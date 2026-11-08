const SESSION_PREFIX = 'session:chat:';
const DEFAULT_TTL_SECONDS = 900; // 15 menit (900 detik) masa berlaku sesi aktif

/**
 * Penyimpanan cadangan di memori (In-Memory Map)
 * Otomatis digunakan saat pengembangan lokal (npx wrangler dev) jika binding SESSION_KV belum diatur
 */
const memoryStore = new Map();

/**
 * Daftar status resmi tahapan sesi (Finite State Machine)
 */
export const SESSION_STATES = Object.freeze({
  WAITING_PAYER: 'WAITING_PAYER',       // Menunggu klik tombol Pembayar / Edit / Batal
  WAITING_REVISION: 'WAITING_REVISION', // Menunggu ketikan teks Edit sebagian / Tulis ulang penuh
  WAITING_NOTES: 'WAITING_NOTES',       // Menunggu ketikan teks Catatan/Notes (atau '-')
});

const VALID_STATES = new Set(Object.values(SESSION_STATES));

/**
 * Membentuk kunci penyimpanan unik berbasis chatId (Mendukung Japri maupun Grup Berdua)
 * @param {number|string} chatId - ID ruang chat Telegram
 * @returns {string}
 */
function buildSessionKey(chatId) {
  const cleanId = String(chatId ?? '').trim();
  if (!cleanId) {
    throw new Error('chatId wajib diisi untuk mengelola sesi transaksi.');
  }
  return `${SESSION_PREFIX}${cleanId}`;
}

/**
 * Mengambil masa berlaku sesi (TTL) dalam satuan detik dari env atau nilai default (900 detik)
 * @param {Object} env - Environment variables Cloudflare Workers
 * @returns {number}
 */
function getTtlSeconds(env) {
  const customTtl = Number(env?.SESSION_TTL_SECONDS);
  // Cloudflare KV mewajibkan expirationTtl minimal 60 detik
  return Number.isInteger(customTtl) && customTtl >= 60 ? customTtl : DEFAULT_TTL_SECONDS;
}

/**
 * Memeriksa apakah binding Cloudflare KV tersedia di dalam environment
 * Mendukung nama binding SESSION_KV maupun USER_CACHE
 * @param {Object} env - Environment variables Cloudflare Workers
 * @returns {Object|null}
 */
function getKvNamespace(env) {
  const kv = env?.SESSION_KV || env?.USER_CACHE || null;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    return kv;
  }
  return null;
}

/**
 * Menstandarkan objek draf transaksi agar 100% kompatibel dengan telegramApi.js, gemini.js, drive.js, & sheets.js.
 * Menangani perbedaan penamaan properti fileId (camelCase dari drive.js) menjadi file_id (snake_case untuk sheets.js).
 * @param {Object} [rawDraft={}] - Data draf baru dari Gemini / Drive
 * @param {Object} [previousDraft={}] - Data draf sebelumnya (untuk menyelamatkan file_id saat revisi)
 * @returns {Object}
 */
export function normalizeDraftPayload(rawDraft = {}, previousDraft = {}) {
  rawDraft = rawDraft ?? {};
  previousDraft = previousDraft ?? {};

  // Pertahankan file_id Google Drive dari sesi sebelumnya jika draf revisi tidak menyertakan file baru
  const resolvedFileId =
    rawDraft.file_id && rawDraft.file_id !== '-'
      ? rawDraft.file_id
      : rawDraft.fileId && rawDraft.fileId !== '-'
        ? rawDraft.fileId
        : previousDraft.file_id && previousDraft.file_id !== '-'
          ? previousDraft.file_id
          : previousDraft.fileId && previousDraft.fileId !== '-'
            ? previousDraft.fileId
            : '-';

  const resolvedFileName =
    rawDraft.fileName ?? previousDraft.fileName ?? null;

  const resolvedWebViewLink =
    rawDraft.webViewLink ?? previousDraft.webViewLink ?? null;

  const rawItems = Array.isArray(rawDraft.items)
    ? rawDraft.items
    : Array.isArray(previousDraft.items)
      ? previousDraft.items
      : [];

  const normalizedItems = rawItems
    .filter((item) => item && String(item.nama_barang ?? '').trim() !== '')
    .map((item) => ({
      nama_barang: String(item.nama_barang).trim(),
      jumlah: Math.round(Number(item.jumlah) || 0),
    }));

  const calculatedSum = normalizedItems.reduce((sum, item) => sum + item.jumlah, 0);
  const resolvedTotal =
    rawDraft.total !== undefined && rawDraft.total !== null
      ? Math.round(Number(rawDraft.total) || 0)
      : previousDraft.total !== undefined && previousDraft.total !== null
        ? Math.round(Number(previousDraft.total) || 0)
        : calculatedSum;

  return {
    merchant: String(rawDraft.merchant ?? previousDraft.merchant ?? '-').trim() || '-',
    tanggal: String(rawDraft.tanggal ?? previousDraft.tanggal ?? '-').trim() || '-',
    kategori: String(rawDraft.kategori ?? previousDraft.kategori ?? 'Makanan').trim() || 'Makanan',
    total: resolvedTotal,
    items: normalizedItems,
    file_id: String(resolvedFileId),
    fileName: resolvedFileName,
    webViewLink: resolvedWebViewLink,
    dibayar_oleh: rawDraft.dibayar_oleh ?? previousDraft.dibayar_oleh ?? null,
    notes: rawDraft.notes ?? previousDraft.notes ?? null,
  };
}

/**
 * Fungsi internal untuk menyimpan objek sesi ke Cloudflare KV atau Memory Fallback
 * @param {Object} env - Environment variables
 * @param {string} key - Kunci sesi
 * @param {Object} sessionData - Data sesi utuh
 */
async function writeSessionRecord(env, key, sessionData) {
  const ttlSeconds = getTtlSeconds(env);
  const now = Date.now();

  const recordToSave = {
    ...sessionData,
    updated_at: now,
    expires_at: now + ttlSeconds * 1000,
  };

  const kv = getKvNamespace(env);
  if (kv) {
    await kv.put(key, JSON.stringify(recordToSave), {
      expirationTtl: ttlSeconds,
    });
  } else {
    memoryStore.set(key, recordToSave);
  }

  return recordToSave;
}

/**
 * 1. Mengambil sesi aktif berdasarkan chatId.
 * Mengembalikan null jika sesi tidak ditemukan, rusak, atau sudah melewati batas waktu (expired).
 * @param {Object} env - Environment variables Cloudflare Workers
 * @param {number|string} chatId - ID ruang chat Telegram
 * @returns {Promise<Object|null>}
 */
export async function getSession(env, chatId) {
  const key = buildSessionKey(chatId);
  const kv = getKvNamespace(env);

  let session = null;

  if (kv) {
    const rawText = await kv.get(key);
    if (!rawText) return null;
    try {
      session = JSON.parse(rawText);
    } catch (err) {
      console.warn(`Data sesi KV korup untuk ${key}, menghapus sesi:`, err.message);
      await kv.delete(key);
      return null;
    }
  } else {
    session = memoryStore.get(key) || null;
  }

  if (!session) return null;

  // Periksa masa kedaluwarsa (terutama untuk In-Memory Fallback atau toleransi KV)
  if (session.expires_at && Date.now() > session.expires_at) {
    await clearSession(env, chatId);
    return null;
  }

  return session;
}

/**
 * 2. Membuat sesi transaksi baru dengan status awal WAITING_PAYER.
 * Jika sebelumnya masih ada sesi menggantung di ruang chat yang sama, fungsi ini
 * mengembalikan replacedMessageId agar handler bisa menutup tombol pada draf lama.
 * @param {Object} env - Environment variables Cloudflare Workers
 * @param {number|string} chatId - ID ruang chat Telegram
 * @param {Object} draftData - Hasil ekstraksi dari gemini.js (+ fileId dari drive.js)
 * @param {Object} [options={}] - Opsi tambahan { draftMessageId, userId }
 * @returns {Promise<{session: Object, replacedMessageId: number|null}>}
 */
export async function createSession(env, chatId, draftData, options = {}) {
  const key = buildSessionKey(chatId);
  const existingSession = await getSession(env, chatId);
  const replacedMessageId = existingSession?.draft_message_id ?? null;

  const now = Date.now();
  const normalizedDraft = normalizeDraftPayload(draftData, {});

  const newSession = {
    chat_id: String(chatId),
    state: SESSION_STATES.WAITING_PAYER,
    draft_message_id: options.draftMessageId ?? null,
    last_active_user_id: options.userId ? String(options.userId) : null,
    revision_count: 0,
    created_at: now,
    updated_at: now,
    draft: normalizedDraft,
  };

  const savedSession = await writeSessionRecord(env, key, newSession);

  return {
    session: savedSession,
    replacedMessageId,
  };
}

/**
 * 3. Menyimpan ID pesan draf Telegram (message_id) ke dalam sesi yang sedang berjalan.
 * Dipanggil tepat setelah sendDraftConfirmation() berhasil mengirim pesan ke Telegram.
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID ruang chat Telegram
 * @param {number} messageId - message_id dari pesan draf yang baru dikirim bot
 * @returns {Promise<Object|null>}
 */
export async function setDraftMessageId(env, chatId, messageId) {
  const key = buildSessionKey(chatId);
  const session = await getSession(env, chatId);
  if (!session) return null;

  session.draft_message_id = messageId ?? session.draft_message_id;
  return writeSessionRecord(env, key, session);
}

/**
 * 4. Mengubah status tahapan sesi (state) dan memperbarui sebagian atribut draf jika diperlukan.
 * Contoh penggunaan:
 * - Saat klik [ ✏️ Edit / Tulis Ulang ] -> setSessionState(env, chatId, SESSION_STATES.WAITING_REVISION)
 * - Saat klik [ 👤 Pembayar ] -> setSessionState(env, chatId, SESSION_STATES.WAITING_NOTES, { dibayar_oleh: 'Patan' })
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID ruang chat Telegram
 * @param {string} newState - Status baru dari SESSION_STATES
 * @param {Object} [draftPatch={}] - Properti draf yang ingin diperbarui (misal: { dibayar_oleh })
 * @param {Object} [metaPatch={}] - Metadata sesi tambahan (misal: { userId, draftMessageId })
 * @returns {Promise<Object|null>}
 */
export async function setSessionState(
  env,
  chatId,
  newState,
  draftPatch = {},
  metaPatch = {}
) {
  if (!VALID_STATES.has(newState)) {
    throw new Error(`Status sesi tidak valid: ${newState}`);
  }

  const key = buildSessionKey(chatId);
  const session = await getSession(env, chatId);
  if (!session) return null;

  const updatedDraft = normalizeDraftPayload(
    { ...session.draft, ...(draftPatch ?? {}) },
    session.draft
  );

  const updatedSession = {
    ...session,
    state: newState,
    draft_message_id:
      metaPatch.draftMessageId !== undefined
        ? metaPatch.draftMessageId
        : session.draft_message_id,
    last_active_user_id: metaPatch.userId
      ? String(metaPatch.userId)
      : session.last_active_user_id,
    draft: updatedDraft,
  };

  return writeSessionRecord(env, key, updatedSession);
}

/**
 * 5. Memperbarui isi draf setelah pengguna melakukan Edit Sebagian / Tulis Ulang Penuh (Solusi 1 & 3).
 * Otomatis mengunci kembali file_id Google Drive dari sesi lama dan mengembalikan status ke WAITING_PAYER.
 * @param {Object} env - Environment variables
 * @param {number|string} chatId - ID ruang chat Telegram
 * @param {Object} revisedDraft - Draf hasil revisi dari reviseDraftWithGemini()
 * @param {number|null} [newDraftMessageId=null] - ID pesan draf baru jika sudah dikirim
 * @returns {Promise<Object|null>}
 */
export async function updateSessionDraft(
  env,
  chatId,
  revisedDraft,
  newDraftMessageId = null
) {
  const key = buildSessionKey(chatId);
  const session = await getSession(env, chatId);
  if (!session) return null;

  // Gabungkan draf baru dengan tetap menyelamatkan file_id, fileName, & webViewLink dari sesi lama
  const mergedDraft = normalizeDraftPayload(revisedDraft, session.draft);

  // Reset pilihan pembayar karena nominal/rincian draf baru saja berubah
  mergedDraft.dibayar_oleh = null;

  const updatedSession = {
    ...session,
    state: SESSION_STATES.WAITING_PAYER,
    draft_message_id: newDraftMessageId ?? session.draft_message_id,
    revision_count: (Number(session.revision_count) || 0) + 1,
    draft: mergedDraft,
  };

  return writeSessionRecord(env, key, updatedSession);
}

/**
 * 6. Menghapus sesi dari penyimpanan (Dipanggil setelah simpan ke Google Sheets atau saat /cancel)
 * @param {Object} env - Environment variables Cloudflare Workers
 * @param {number|string} chatId - ID ruang chat Telegram
 * @returns {Promise<boolean>}
 */
export async function clearSession(env, chatId) {
  const key = buildSessionKey(chatId);
  const kv = getKvNamespace(env);

  if (kv) {
    await kv.delete(key);
  }
  memoryStore.delete(key);
  return true;
}