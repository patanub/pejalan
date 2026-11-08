const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10000; // 10 detik untuk panggilan API standar
const FILE_DOWNLOAD_TIMEOUT_MS = 20000; // 20 detik untuk unduh foto struk
const MAX_RETRY_AFTER_SEC = 5; // Batas aman tunggu rate-limit 429 di Cloudflare Workers
const MAX_DISPLAY_ITEMS = 25; // Batas item yang ditampilkan agar aman dari limit 4096 karakter
const MAX_ITEM_NAME_LENGTH = 80; // Batas panjang nama per barang sebelum di-escape

/**
 * Custom Error agar pemanggil (handler) bisa membedakan error fatal
 * dari error ringan yang aman diabaikan (seperti klik tombol dua kali).
 */
export class TelegramApiError extends Error {
  constructor(method, status, errorCode, description, retryAfter = null) {
    super(`Telegram API Error (${method}) [${errorCode || status}]: ${description}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.status = status;
    this.errorCode = errorCode;
    this.description = description;
    this.retryAfter = retryAfter;
  }

  /**
   * Menandai error saat edit pesan yang aman diabaikan
   * (misalnya: tombol diklik ganda dari 2 device berbeda sehingga isi pesan sama)
   */
  get isIgnorableEditError() {
    const desc = (this.description || '').toLowerCase();
    return (
      desc.includes('message is not modified') ||
      desc.includes('message to edit not found') ||
      desc.includes("message can't be edited")
    );
  }

  /**
   * Menandai error saat menjawab callback query yang sudah kedaluwarsa
   */
  get isIgnorableCallbackError() {
    const desc = (this.description || '').toLowerCase();
    return (
      desc.includes('query is too old') ||
      desc.includes('query id is invalid')
    );
  }
}

/**
 * Mengambil token bot dari environment variables (.dev.vars)
 * Mendukung TELEGRAM_BOT_TOKEN maupun TELEGRAM_TOKEN
 * @param {Object} env - Environment variables Cloudflare Workers
 * @returns {string}
 */
function getBotToken(env) {
  const token = env?.TELEGRAM_BOT_TOKEN || env?.TELEGRAM_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN belum dikonfigurasi di dalam .dev.vars.');
  }
  return token;
}

/**
 * Mengambil daftar nama pembayar untuk tombol Inline Keyboard.
 * Di-export agar handler bisa memetakan callback_data 'pay:0' dan 'pay:1'.
 * @param {Object} env - Environment variables Cloudflare Workers
 * @returns {string[]}
 */
export function getPayerNames(env) {
  return [
    env?.PAYER_1 || 'Patan',
    env?.PAYER_2 || 'Nyunyu',
  ];
}

/**
 * Memetakan indeks dari callback_data (contoh: 0 atau 1) menjadi nama pembayar
 * @param {Object} env - Environment variables Cloudflare Workers
 * @param {number|string} index - Indeks pembayar dari callback_data
 * @returns {string|null}
 */
export function getPayerByIndex(env, index) {
  // Number(null) dan Number('') bernilai 0, sehingga tanpa pengecekan ini pembayar pertama terpilih secara keliru
  if (index === null || index === undefined || String(index).trim() === '') {
    return null;
  }
  const payers = getPayerNames(env);
  const idx = Number(index);
  if (Number.isInteger(idx) && idx >= 0 && idx < payers.length) {
    return payers[idx];
  }
  return null;
}

/**
 * Memeriksa apakah pengguna/ruang chat diizinkan mengakses bot (Khusus Pengguna Tertutup).
 * Mendukung pemakaian di Chat Pribadi (Japri) maupun Grup Telegram berdua:
 * - Jika kamu mendaftarkan User ID kalian berdua di ALLOWED_CHAT_IDS, maka kalian otomatis
 *   diizinkan baik saat japri ke bot maupun saat berinteraksi di dalam Grup Telegram.
 * @param {Object} env - Environment variables (.dev.vars)
 * @param {number|string} chatId - ID ruang chat (bisa ID japri atau ID grup negatif)
 * @param {number|string|null} [userId=null] - ID akun Telegram pengirim pesan/klik tombol
 * @returns {boolean}
 */
export function isAuthorizedContext(env, chatId, userId = null) {
  const rawAllowed = String(env?.ALLOWED_CHAT_IDS ?? '').trim();

  // Jika ALLOWED_CHAT_IDS belum diatur, tolak semua (fail-closed) agar bot tidak terbuka untuk umum
  if (!rawAllowed) return false;

  const allowedSet = new Set(
    rawAllowed
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );

  const chatStr = String(chatId ?? '');
  const userStr = String(userId ?? '');

  // Lolos jika ID ruang chat terdaftar ATAU ID akun pengirim terdaftar
  return allowedSet.has(chatStr) || (Boolean(userStr) && allowedSet.has(userStr));
}

/**
 * Mengamankan karakter khusus pada mode HTML Telegram & menangani nilai null/undefined dari OCR
 * @param {any} text - Teks masukan
 * @returns {string}
 */
export function escapeHtml(text = '') {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Memotong teks mentah SEBELUM di-escape ke HTML agar tidak pernah memotong tag/entitas di tengah
 * @param {any} text - Teks mentah
 * @param {number} [maxLength=80] - Batas jumlah karakter
 * @returns {string}
 */
export function truncatePlainText(text = '', maxLength = 80) {
  const str = String(text ?? '').trim();
  if (str.length <= maxLength) return str;
  let cut = str.slice(0, maxLength - 1);
  // Jangan memotong di tengah surrogate pair (misalnya emoji) agar tidak menghasilkan karakter rusak
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut + '…';
}

/**
 * Format angka menjadi mata uang Rupiah (contoh: 63800 -> Rp63.800)
 * @param {number|string} [amount=0] - Nominal harga
 * @returns {string}
 */
export function formatRupiah(amount = 0) {
  const num = Math.round(Number(amount) || 0);
  const isNegative = num < 0;
  const formatted = Math.abs(num)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (isNegative ? '-Rp' : 'Rp') + formatted;
}

/**
 * Helper jeda waktu untuk retry saat terkena limit 429
 * @param {number} ms - Milidetik
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fungsi inti pemanggil endpoint Telegram Bot API via Fetch.
 * Dilengkapi Timeout, proteksi respons non-JSON (502/504), penyensoran token menyeluruh, & retry 429.
 * @param {Object} env - Environment variables
 * @param {string} method - Nama metode Telegram Bot API
 * @param {Object} [payload={}] - Body JSON yang dikirim
 * @param {Object} [options={}] - Pengaturan timeoutMs & maxRetries
 * @returns {Promise<any>}
 */
async function callTelegramApi(env, method, payload = {}, options = {}) {
  const token = getBotToken(env);
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? 1;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    let rawBody;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Baca sebagai teks terlebih dahulu agar tidak melempar SyntaxError jika server membalas HTML 502/504.
      // Dibaca di dalam try yang sama karena timeout masih berlaku setelah header diterima.
      rawBody = await response.text();
    } catch (networkErr) {
      const rawMsg = networkErr instanceof Error ? networkErr.message : String(networkErr);
      const safeMsg = rawMsg.replaceAll(token, '[REDACTED]');
      throw new TelegramApiError(method, 0, 'NETWORK_OR_TIMEOUT', safeMsg);
    }

    let data = null;
    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch (_) {
      const safeSnippet = rawBody.replaceAll(token, '[REDACTED]').slice(0, 200);
      throw new TelegramApiError(
        method,
        response.status,
        'NON_JSON_RESPONSE',
        `Respons bukan JSON valid (HTTP ${response.status}): ${safeSnippet}`
      );
    }

    if (response.ok && data?.ok) {
      return data.result;
    }

    const errorCode = data?.error_code || response.status;
    const retryAfter = data?.parameters?.retry_after ?? null;
    const safeDesc = String(data?.description || rawBody || `HTTP ${response.status}`).replaceAll(
      token,
      '[REDACTED]'
    );

    // Jika terkena 429 Too Many Requests dan waktu tunggunya singkat, coba ulang otomatis
    if (errorCode === 429 && retryAfter && retryAfter <= MAX_RETRY_AFTER_SEC && attempt < maxRetries) {
      await sleep(retryAfter * 1000);
      continue;
    }

    throw new TelegramApiError(method, response.status, errorCode, safeDesc, retryAfter);
  }
}

/**
 * Mengirim pesan teks standar ke ruang chat Telegram (Japri maupun Grup)
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID Chat Telegram
 * @param {string} text - Isi pesan berformat HTML
 * @param {Object} [extraOptions={}] - Opsi tambahan (seperti reply_markup)
 */
export async function sendMessage(env, chatId, text, extraOptions = {}) {
  return callTelegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extraOptions,
  });
}

/**
 * Mengedit pesan dengan aman tanpa mematahkan alur utama.
 * Menangani kasus tombol diklik dua kali dari 2 device/orang di grup ("message is not modified").
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID Chat Telegram
 * @param {number} messageId - ID pesan yang akan diedit
 * @param {string} text - Teks baru berformat HTML
 * @param {Object} [extraOptions={}] - Opsi tambahan
 */
export async function safeEditMessageText(env, chatId, messageId, text, extraOptions = {}) {
  if (!chatId || !messageId) return null;
  try {
    return await callTelegramApi(env, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extraOptions,
    });
  } catch (err) {
    if (err instanceof TelegramApiError && err.isIgnorableEditError) {
      return null;
    }
    console.warn(`Gagal mengedit pesan ${messageId} (alur tetap dilanjutkan):`, err.message);
    return null;
  }
}

/**
 * Mengirim indikator status bot ('typing') tanpa mematahkan alur jika gagal
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID Chat Telegram
 * @param {string} [action='typing'] - Jenis aksi ('typing', 'upload_photo', dll.)
 */
export async function sendChatAction(env, chatId, action = 'typing') {
  try {
    await callTelegramApi(env, 'sendChatAction', {
      chat_id: chatId,
      action,
    });
  } catch (_) {
    // Abaikan kegagalan pengiriman chat action
  }
}

/**
 * Menghentikan animasi loading pada tombol Inline Keyboard setelah diklik.
 * Dibungkus try/catch agar tidak mematahkan alur jika query sudah kedaluwarsa.
 * @param {Object} env - Environment variables
 * @param {string} callbackQueryId - ID dari callback_query Telegram
 * @param {string} [text=''] - Notifikasi toast singkat di layar pengguna
 * @param {boolean} [showAlert=false] - Tampilkan sebagai pop-up alert jika true
 */
export async function answerCallbackQuery(env, callbackQueryId, text = '', showAlert = false) {
  if (!callbackQueryId) return null;
  try {
    return await callTelegramApi(env, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  } catch (err) {
    if (!(err instanceof TelegramApiError && err.isIgnorableCallbackError)) {
      console.warn('Gagal menjawab callback query:', err.message);
    }
    return null;
  }
}

/**
 * Mengunduh foto struk dari server Telegram menjadi ArrayBuffer tunggal.
 * Digunakan secara paralel oleh uploadReceiptToDrive() dan parseReceiptWithGemini().
 * @param {Object} env - Environment variables Cloudflare Workers
 * @param {Array|string} photoOrFileId - Array message.photo dari webhook atau string file_id langsung
 * @returns {Promise<{buffer: ArrayBuffer, mimeType: string, filePath: string}>}
 */
export async function getFileBuffer(env, photoOrFileId) {
  const token = getBotToken(env);

  // Jika input berupa array message.photo, ambil elemen terakhir (resolusi paling tajam untuk OCR)
  const fileId = Array.isArray(photoOrFileId)
    ? photoOrFileId[photoOrFileId.length - 1]?.file_id
    : photoOrFileId;

  if (!fileId) {
    throw new Error('file_id foto tidak ditemukan pada pesan Telegram.');
  }

  // Tahap A: Ambil file_path dari endpoint getFile
  const fileInfo = await callTelegramApi(env, 'getFile', { file_id: fileId });
  if (!fileInfo?.file_path) {
    throw new Error('Gagal mendapatkan file_path foto dari server Telegram.');
  }

  // Tahap B: Unduh biner gambar dari server file Telegram dengan batas waktu (timeout)
  const fileUrl = `${TELEGRAM_API_BASE}/file/bot${token}/${fileInfo.file_path}`;
  let fileResponse;
  let buffer;
  try {
    fileResponse = await fetch(fileUrl, {
      signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
    });
    // Body dibaca di dalam try yang sama karena timeout masih berlaku selama unduhan biner berjalan
    if (fileResponse.ok) {
      buffer = await fileResponse.arrayBuffer();
    }
  } catch (err) {
    const safeMsg = String(err?.message || err).replaceAll(token, '[REDACTED]');
    throw new Error(`Gagal mengunduh gambar dari Telegram (Timeout/Network): ${safeMsg}`);
  }

  if (!fileResponse.ok) {
    throw new Error(`Gagal mengunduh file gambar dari Telegram (HTTP ${fileResponse.status}).`);
  }

  const ext = fileInfo.file_path.split('.').pop()?.toLowerCase();
  const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

  return {
    buffer,
    mimeType,
    filePath: fileInfo.file_path,
  };
}

/**
 * Helper untuk merender daftar item dengan batas aman MAX_DISPLAY_ITEMS (25 item).
 * Mencegah penolakan Telegram API akibat pesan melebihi 4096 karakter pada struk belanja panjang.
 * @param {Array} [items=[]] - Daftar item barang
 * @param {boolean} [boldPrice=false] - Tebalkan nominal harga jika true
 * @returns {string}
 */
function formatItemsListLimited(items = [], boldPrice = false) {
  if (!Array.isArray(items) || items.length === 0) {
    return '  - (Tidak ada rincian)';
  }

  const visibleItems = items.slice(0, MAX_DISPLAY_ITEMS);
  const lines = visibleItems.map((item, idx) => {
    const safeName = escapeHtml(
      truncatePlainText(item?.nama_barang || 'Item', MAX_ITEM_NAME_LENGTH)
    );
    const priceStr = formatRupiah(item?.jumlah);
    const formattedPrice = boldPrice ? `<b>${priceStr}</b>` : priceStr;
    return `  ${idx + 1}. ${safeName} — ${formattedPrice}`;
  });

  if (items.length > MAX_DISPLAY_ITEMS) {
    const hiddenItems = items.slice(MAX_DISPLAY_ITEMS);
    const hiddenCount = hiddenItems.length;
    const hiddenSubtotal = hiddenItems.reduce(
      (sum, item) => sum + (Number(item?.jumlah) || 0),
      0
    );
    lines.push(
      `  <i>...dan ${hiddenCount} item lainnya (${formatRupiah(hiddenSubtotal)})</i>`
    );
  }

  return lines.join('\n');
}

/**
 * Helper penyusun teks tampilan Draf Transaksi
 * @param {Object} [draft={}] - Objek draf transaksi dari gemini.js & session.js
 * @param {boolean} [isRevised=false] - True jika draf baru saja selesai diedit/ditulis ulang
 * @returns {string}
 */
export function formatDraftMessageText(draft = {}, isRevised = false) {
  // Default parameter hanya berlaku untuk undefined, sedangkan null dari session tetap perlu dijaga
  draft = draft ?? {};

  const headerTitle = isRevised
    ? '✅ <b>Draf Transaksi Diperbarui:</b>'
    : '📄 <b>Draf Transaksi Terbaca:</b>';

  const itemsList = formatItemsListLimited(draft.items, true);

  const driveBadge =
    draft.file_id && draft.file_id !== '-'
      ? '\n• <b>Struk:</b> 📎 Tersimpan di Google Drive'
      : '';

  return (
    `${headerTitle}\n` +
    `• <b>Merchant:</b> ${escapeHtml(truncatePlainText(draft.merchant || '-', 100))}\n` +
    `• <b>Tanggal:</b> ${escapeHtml(truncatePlainText(draft.tanggal || '-', 30))}\n` +
    `• <b>Kategori:</b> ${escapeHtml(truncatePlainText(draft.kategori || 'Makanan', 50))}\n` +
    `• <b>Rincian Item:</b>\n${itemsList}\n` +
    `• <b>Total Akhir:</b> <b>${formatRupiah(draft.total)}</b>` +
    `${driveBadge}`
  );
}

/**
 * Mengirim Draf Konfirmasi beserta Inline Keyboard (Pembayar + Edit/Tulis Ulang + Batal).
 * Menggunakan indeks pada callback_data ('pay:0', 'pay:1') agar aman dari batas 64 byte & karakter ':'.
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID Chat Telegram
 * @param {Object} draftData - Data draf transaksi dari gemini.js (+ file_id dari drive.js)
 * @param {boolean} [isRevised=false] - Menandakan apakah ini draf hasil revisi
 */
export async function sendDraftConfirmation(env, chatId, draftData, isRevised = false) {
  const payers = getPayerNames(env);
  const draftText = formatDraftMessageText(draftData, isRevised);

  const messageText =
    `${draftText}\n\n` +
    `❓ <b>Siapa yang membayar transaksi ini?</b>\n` +
    `<i>(Atau klik <b>Edit / Tulis Ulang</b> jika ada nama item/harga yang keliru)</i>`;

  const inlineKeyboard = {
    inline_keyboard: [
      // Baris 1: Pilihan Pembayar menggunakan indeks (pay:0, pay:1)
      payers.map((payerName, idx) => ({
        text: `👤 ${payerName}`,
        callback_data: `pay:${idx}`,
      })),
      // Baris 2: Gabungan Solusi 1 & 3 (Edit/Tulis Ulang) dan Batal
      [
        { text: '✏️ Edit / Tulis Ulang', callback_data: 'action:revise' },
        { text: '❌ Batal', callback_data: 'action:cancel' },
      ],
    ],
  };

  return sendMessage(env, chatId, messageText, {
    reply_markup: inlineKeyboard,
  });
}

/**
 * Transisi ke Mode Edit / Tulis Ulang (Gabungan Solusi 1 & Solusi 3).
 * Dipanggil saat pengguna menekan tombol [ ✏️ Edit / Tulis Ulang ] ('action:revise').
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID Chat Telegram
 * @param {number} messageId - ID pesan draf sebelumnya
 * @param {string} callbackQueryId - ID callback query
 * @param {Object} [currentDraft={}] - Draf transaksi saat ini di session.js
 */
export async function promptDraftRevision(
  env,
  chatId,
  messageId,
  callbackQueryId,
  currentDraft = {}
) {
  await answerCallbackQuery(env, callbackQueryId, 'Mode Edit / Tulis Ulang aktif');

  if (messageId) {
    const lockedText =
      `${formatDraftMessageText(currentDraft)}\n\n` +
      `⏳ <i>Menunggu input koreksi / tulis ulang draf...</i>`;

    await safeEditMessageText(env, chatId, messageId, lockedText);
  }

  const keepDriveNote =
    currentDraft?.file_id && currentDraft.file_id !== '-'
      ? '\n\n📎 <i>Catatan: Foto struk di Google Drive tetap tersimpan aman dan tidak perlu diunggah ulang.</i>'
      : '';

  const instructionText =
    `✏️ <b>Silakan ketik koreksi atau tulis ulang transaksi:</b>\n\n` +
    `• <b>Edit sebagian:</b>\n` +
    `  Contoh: <i>"Ubah harga Nasi Goreng jadi 55000"</i> atau <i>"Ganti merchant jadi Kopi Kenangan dan tambah Roti 15000"</i>\n\n` +
    `• <b>Tulis ulang penuh:</b>\n` +
    `  Contoh: <i>"Warung Tekko beli Nasi Goreng + Telor 53000, Es Jeruk 12000 total 71500"</i>` +
    `${keepDriveNote}\n\n` +
    `<i>Ketik /cancel jika ingin membatalkan transaksi sepenuhnya.</i>`;

  return sendMessage(env, chatId, instructionText);
}

/**
 * Mengunci pilihan pembayar di pesan draf & meminta input teks Catatan/Notes.
 * Dipanggil saat pengguna menekan tombol [ 👤 Pembayar ] ('pay:0' atau 'pay:1').
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID Chat Telegram
 * @param {number} messageId - ID pesan draf sebelumnya
 * @param {string} callbackQueryId - ID callback query
 * @param {string} payerName - Nama pembayar hasil pemetaan indeks
 * @param {Object} draftData - Data draf transaksi saat ini
 */
export async function confirmPayerAndAskNotes(
  env,
  chatId,
  messageId,
  callbackQueryId,
  payerName,
  draftData
) {
  await answerCallbackQuery(env, callbackQueryId, `Pembayar dipilih: ${payerName}`);

  if (messageId && draftData) {
    const updatedDraftText =
      `${formatDraftMessageText(draftData)}\n` +
      `• <b>Dibayar oleh:</b> ✅ ${escapeHtml(payerName)}`;

    await safeEditMessageText(env, chatId, messageId, updatedDraftText);
  }

  const notesPrompt =
    `📝 <b>Ketik catatan/notes untuk transaksi ini:</b>\n` +
    `<i>(Balas dengan tanda <code>-</code> jika tidak ada catatan)</i>`;

  return sendMessage(env, chatId, notesPrompt);
}

/**
 * Mengirim Ringkasan Sukses setelah data resmi tersimpan di Google Sheets.
 * Dilengkapi pembatas 25 item agar aman dari limit 4096 karakter Telegram.
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID Chat Telegram
 * @param {Object} [trx={}] - Objek transaksi yang disimpan ke tabel 'transaction'
 * @param {Array} [items=[]] - Daftar item yang disimpan ke tabel 'transaction_detail'
 */
export async function sendFinalSummary(env, chatId, trx = {}, items = []) {
  // Default parameter hanya berlaku untuk undefined, sedangkan null dari pemanggil tetap perlu dijaga
  trx = trx ?? {};
  items = Array.isArray(items) ? items : [];

  const itemsFormatted = formatItemsListLimited(items, false);

  let driveInfo = '• <b>Arsip Struk:</b> - (Input Teks Manual)';
  if (trx.file_id && trx.file_id !== '-') {
    const driveUrl = trx.webViewLink || `https://drive.google.com/file/d/${trx.file_id}/view`;
    driveInfo = `• <b>Arsip Struk:</b> <a href="${escapeHtml(driveUrl)}">Lihat Foto Struk di Drive</a>`;
  }

  const summaryText =
    `✅ <b>Transaksi Berhasil Disimpan!</b>\n\n` +
    `• <b>ID Transaksi:</b> <code>${escapeHtml(trx.id || '-')}</code>\n` +
    `• <b>Tanggal:</b> ${escapeHtml(truncatePlainText(trx.tanggal || '-', 30))}\n` +
    `• <b>Merchant:</b> ${escapeHtml(truncatePlainText(trx.merchant || '-', 100))}\n` +
    `• <b>Kategori:</b> ${escapeHtml(truncatePlainText(trx.kategori || 'Makanan', 50))}\n` +
    `• <b>Dibayar oleh:</b> ${escapeHtml(truncatePlainText(trx.dibayar_oleh || '-', 50))}\n` +
    `• <b>Catatan/Notes:</b> ${escapeHtml(truncatePlainText(trx.notes || '-', 300))}\n` +
    `${driveInfo}\n\n` +
    `🛒 <b>Rincian Item (${items.length} barang):</b>\n` +
    `${itemsFormatted}\n\n` +
    `💰 <b>Total Akhir: ${formatRupiah(trx.total)}</b>`;

  return sendMessage(env, chatId, summaryText);
}

/**
 * 10. Mengirim konfirmasi pembatalan sesi (/cancel atau klik tombol [ ❌ Batal ])
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID Chat Telegram
 * @param {number|null} [messageId=null] - ID pesan draf jika dibatalkan lewat tombol
 * @param {string|null} [callbackQueryId=null] - ID callback query jika dibatalkan lewat tombol
 */
export async function sendCancelConfirmation(
  env,
  chatId,
  messageId = null,
  callbackQueryId = null
) {
  if (callbackQueryId) {
    await answerCallbackQuery(env, callbackQueryId, 'Transaksi dibatalkan');
  }

  if (messageId) {
    await safeEditMessageText(
      env,
      chatId,
      messageId,
      '🚫 <i>Draf transaksi ini telah dibatalkan oleh pengguna.</i>'
    );
  }

  return sendMessage(
    env,
    chatId,
    '🚫 <b>Sesi transaksi dibatalkan.</b> Silakan kirim foto struk atau ketik pengeluaran baru kapan saja.'
  );
}

/**
 * 11. Mengirim Notifikasi Error Real-Time ke ruang chat Telegram pengguna.
 * Memotong teks mentah SEBELUM di-escape ke HTML agar tidak pernah merusak tag <code>.
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID Chat Telegram
 * @param {Error|string} error - Objek atau pesan error yang tertangkap
 * @param {string} [context='Pemrosesan Transaksi'] - Nama proses tempat terjadinya error
 */
export async function sendErrorAlert(env, chatId, error, context = 'Pemrosesan Transaksi') {
  if (!chatId) return;

  const token = env?.TELEGRAM_BOT_TOKEN || env?.TELEGRAM_TOKEN || '';
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');

  let sanitizedPlain = rawMessage
    .replace(/key=[A-Za-z0-9_\-]+/gi, 'key=[HIDDEN]')
    .replace(/bot\d+:[A-Za-z0-9_\-]+/gi, 'bot[HIDDEN]');

  if (token) {
    sanitizedPlain = sanitizedPlain.replaceAll(token, '[REDACTED]');
  }

  // Potong teks mentah terlebih dahulu sebelum masuk ke escapeHtml
  const truncatedPlainError = truncatePlainText(sanitizedPlain, 450);
  const safeContext = truncatePlainText(context, 80);

  const alertText =
    `⚠️ <b>Terjadi Kegagalan Sistem (${escapeHtml(safeContext)})</b>\n\n` +
    `<b>Detail:</b> <code>${escapeHtml(truncatedPlainError)}</code>\n\n` +
    `<i>Silakan coba lagi atau ketik /cancel untuk mereset sesi.</i>`;

  try {
    await sendMessage(env, chatId, alertText);
  } catch (err) {
    console.error('Gagal mengirim notifikasi error ke Telegram:', err.message);
  }
}