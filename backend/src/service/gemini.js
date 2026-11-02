// backend/src/services/gemini.js
// Layanan AI untuk Vision OCR struk belanja dan NLP text parsing menggunakan Gemini REST API

const DEFAULT_MODEL = 'gemini-2.0-flash'; // Dapat dioverride melalui env.GEMINI_MODEL

// Daftar 4 kategori resmi yang diizinkan masuk ke tabel 'transaction'
export const VALID_CATEGORIES = [
  'Makanan',
  'Transportasi',
  'Belanja Bulanan',
  'Hiburan',
];

// Pemetaan nama bulan Bahasa Indonesia (lengkap & singkatan) ke angka bulan (01 - 12)
const INDONESIAN_MONTHS = {
  januari: '01', jan: '01',
  februari: '02', feb: '02', pebruari: '02',
  maret: '03', mar: '03',
  april: '04', apr: '04',
  mei: '05',
  juni: '06', jun: '06',
  juli: '07', jul: '07',
  agustus: '08', agu: '08', ags: '08', agt: '08',
  september: '09', sep: '09', sept: '09',
  oktober: '10', okt: '10',
  november: '11', nov: '11', nopember: '11', nop: '11',
  desember: '12', des: '12',
};

const INDONESIAN_DAYS = [
  'Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu',
];

/**
 * 1. Menghitung tanggal hari ini dalam zona waktu WIB (UTC+7)
 * Digunakan sebagai Dynamic Time Anchor pada System Prompt & fallback tanggal
 */
export function getTodayWIB(date = new Date()) {
  const wibTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');

  const yyyy = wibTime.getUTCFullYear();
  const MM = pad(wibTime.getUTCMonth() + 1);
  const dd = pad(wibTime.getUTCDate());
  const dayName = INDONESIAN_DAYS[wibTime.getUTCDay()];

  return {
    isoDate: `${yyyy}-${MM}-${dd}`,
    readable: `${dayName}, ${dd}-${MM}-${yyyy}`,
    year: yyyy,
  };
}

/**
 * 2. Hybrid Regex Date Pre-Parser (Khusus Teks Manual)
 * Mendeteksi tanggal eksplisit seperti "Senin 2 November 2026", "02/11/2026", atau "2026-11-02"
 */
export function extractDateFromText(text = '', defaultYear = new Date().getFullYear()) {
  if (!text) return null;
  const cleanText = text.toLowerCase();
  const pad = (n) => String(n).padStart(2, '0');

  // A. Pola: "2 November 2026" atau "2 Nov"
  const monthNamesPattern = Object.keys(INDONESIAN_MONTHS).join('|');
  const namedDateRegex = new RegExp(
    `\\b(\\d{1,2})\\s+(${monthNamesPattern})(?:\\s+(\\d{4}))?\\b`,
    'i'
  );
  const namedMatch = cleanText.match(namedDateRegex);
  if (namedMatch) {
    const day = pad(namedMatch[1]);
    const month = INDONESIAN_MONTHS[namedMatch[2].toLowerCase()];
    const year = namedMatch[3] || String(defaultYear);
    return `${year}-${month}-${day}`;
  }

  // B. Pola ISO: "YYYY-MM-DD"
  const isoMatch = cleanText.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // C. Pola Numerik: "DD/MM/YYYY" atau "DD-MM-YYYY"
  const numericMatch = cleanText.match(/\b(0?[1-9]|[12]\d|3[01])[\/\-](0?[1-9]|1[0-2])[\/\-](20\d{2})\b/);
  if (numericMatch) {
    return `${numericMatch[3]}-${pad(numericMatch[2])}-${pad(numericMatch[1])}`;
  }

  return null;
}

/**
 * 3. Menyusun System Prompt dengan Konteks Waktu WIB Dinamis
 */
function buildSystemPrompt(todayWIB) {
  return `
Anda adalah asisten AI ekstraktor transaksi keuangan keluarga.
Konteks Waktu Saat Ini (WIB): ${todayWIB.readable} (Format ISO: ${todayWIB.isoDate}).

Tugas Anda adalah mengekstrak informasi dari gambar struk belanja (OCR) atau kalimat teks manual menjadi JSON murni tanpa markdown (\`\`\`json).

ATURAN EKSTRAKSI PENTING:
1. TANGGAL ("tanggal"):
   - Prioritaskan tanggal yang tertulis di struk atau disebutkan di kalimat pengguna (contoh: "Senin 2 November 2026" -> "2026-11-02", atau kata relatif seperti "kemarin" dihitung mundur dari ${todayWIB.isoDate}).
   - HANYA JIKA tanggal tidak disebutkan sama sekali, gunakan "${todayWIB.isoDate}".
   - Format wajib "YYYY-MM-DD".

2. KATEGORI ("kategori"):
   - Wajib memilih TEPAT SATU dari 4 kategori berikut berdasarkan merchant dan barang:
     * "Makanan" (Restoran, kafe, warung, kopi, minuman, jajanan, food delivery)
     * "Transportasi" (BBM/bensin, ojek/taksi online, parkir, tol, tiket perjalanan, servis kendaraan)
     * "Belanja Bulanan" (Supermarket, minimarket, kebutuhan rumah tangga, bahan dapur, obat/kesehatan, tagihan rutin)
     * "Hiburan" (Bioskop, streaming, game, rekreasi, hobi, nongkrong/wisata)

3. TOTAL & PAJAK ("total" & "items"):
   - "total" adalah Grand Total akhir yang benar-benar dibayar pelanggan (sudah termasuk pajak/service charge/pembulatan dan dikurangi diskon). Wajib bertipe Number murni.
   - JANGAN masukkan Pajak (PB1/PPN/Tax), Service Charge, Biaya Layanan, Biaya Kemasan, atau Pembulatan sebagai item di dalam array "items". Biarkan hanya barang/menu utama saja, karena sistem akan mendistribusikan pajak secara proporsional.

4. ADD-ON / TOPPING ("addons"):
   - Jika suatu menu/barang memiliki tambahan berbayar di bawahnya (seperti "+Telor", "+Sosis", "Extra Cheese", "Upsize"), JANGAN jadikan elemen baru di "items".
   - Masukkan ke dalam array "addons" milik item induknya dengan struktur: {"nama": "Nama Addon tanpa tanda +", "harga": 0}.
   - Nilai "jumlah" pada item induk adalah harga dasar item tersebut SEBELUM ditambah harga addons (atau jika sudah tergabung, kosongkan "addons").

Format JSON Keluaran Wajib:
{
  "merchant": "Nama Toko / Merchant",
  "tanggal": "YYYY-MM-DD",
  "kategori": "Makanan | Transportasi | Belanja Bulanan | Hiburan",
  "total": 0,
  "items": [
    {
      "nama_barang": "Nama menu/barang utama",
      "jumlah": 0,
      "addons": [
        { "nama": "Telor", "harga": 0 }
      ]
    }
  ]
}
`.trim();
}

/**
 * 4. Validasi & Normalisasi 4 Kategori Pengeluaran
 */
export function normalizeCategory(rawCategory, merchant = '', items = []) {
  const cleanCat = String(rawCategory || '').trim();
  const exactMatch = VALID_CATEGORIES.find(
    (c) => c.toLowerCase() === cleanCat.toLowerCase()
  );
  if (exactMatch) return exactMatch;

  // Fallback berbasis kata kunci pada kategori mentah, merchant, dan nama barang
  const combinedText = `${cleanCat} ${merchant} ${items.map((i) => i.nama_barang).join(' ')}`.toLowerCase();

  if (/(bensin|pertamina|shell|gojek|goride|gocar|grab|tol|parkir|kereta|kai|tiket|bengkel|transport|ojol)/i.test(combinedText)) {
    return 'Transportasi';
  }
  if (/(bioskop|xxi|cgv|netflix|spotify|game|steam|hiburan|wisata|timezone|karaoke|konser)/i.test(combinedText)) {
    return 'Hiburan';
  }
  if (/(indomaret|alfamart|superindo|hypermart|sabun|shampo|deterjen|listrik|pln|air|pdam|internet|wifi|pulsa|apotek|obat|belanja)/i.test(combinedText)) {
    return 'Belanja Bulanan';
  }

  return 'Makanan';
}

/**
 * 5. Peleburan Add-on (Solusi 2: Sub-array 'addons' + Solusi 3: Prefix Sweeper)
 * Menghasilkan Format A: "Nasi Goreng (+Telor, +Sosis)" dengan harga dasar gabungan
 */
export function mergeItemAddons(rawItems = []) {
  // Pola untuk membuang baris pajak/service/pembulatan jika AI tidak sengaja memasukkannya ke items
  const taxOrFeeRegex = /^(pajak|ppn|pb1|tax|service\s*charge|biaya\s*layanan|pembulatan|rounding|biaya\s*admin|biaya\s*aplikasi)\b/i;

  // Pola Solusi 3: Baris mandiri yang sebenarnya adalah add-on (diawali +, extra, tambah, topping, add, upsize)
  const addonPrefixRegex = /^(\+\s*|add\s+|extra\s+|ekstra\s+|topping\s+|toping\s+|tambah\s+|upsize\b)/i;

  const cleanAddonName = (name) => {
    const stripped = String(name || '')
      .trim()
      .replace(/^(\+\s*|add\s+|extra\s+|ekstra\s+|topping\s+|toping\s+|tambah\s+)/i, '')
      .trim();
    return stripped ? `+${stripped}` : null;
  };

  const mergedList = [];

  for (const raw of rawItems) {
    const rawName = String(raw?.nama_barang || '').trim();
    const basePrice = Number(raw?.jumlah) || 0;

    if (!rawName || taxOrFeeRegex.test(rawName)) {
      continue;
    }

    // Cek apakah baris ini adalah baris add-on mandiri yang lolos (Solusi 3)
    if (addonPrefixRegex.test(rawName) && mergedList.length > 0) {
      const parentItem = mergedList[mergedList.length - 1];
      const formattedAddon = cleanAddonName(rawName);
      if (formattedAddon) {
        parentItem.modifiers.push(formattedAddon);
      }
      parentItem.jumlah += basePrice;
      continue;
    }

    // Proses sub-array 'addons' bawaan dari JSON Gemini (Solusi 2)
    const modifiers = [];
    let addonsTotal = 0;

    if (Array.isArray(raw?.addons)) {
      for (const addon of raw.addons) {
        const formattedAddon = cleanAddonName(addon?.nama);
        const addonPrice = Number(addon?.harga) || 0;
        if (formattedAddon) {
          modifiers.push(formattedAddon);
        }
        addonsTotal += addonPrice;
      }
    }

    mergedList.push({
      baseName: rawName,
      modifiers,
      jumlah: basePrice + addonsTotal,
    });
  }

  // Bentuk string akhir dengan Format A: "Nama Barang (+Addon1, +Addon2)"
  return mergedList.map((item) => {
    const fullName =
      item.modifiers.length > 0
        ? `${item.baseName} (${item.modifiers.join(', ')})`
        : item.baseName;

    return {
      nama_barang: fullName,
      jumlah: item.jumlah,
    };
  });
}

/**
 * 6. Distribusi Harga Proporsional (Solusi 3 Harga/Pajak)
 * Memastikan penjumlahan seluruh items.jumlah SAMA PERSIS (100%) dengan total akhir
 */
export function distributeProportionalTotal(items = [], grandTotal = 0, fallbackName = 'Transaksi') {
  const validItems = items.filter((item) => item.nama_barang);

  // Jika tidak ada rincian item, buat 1 item default sebesar grandTotal
  if (validItems.length === 0) {
    return [
      {
        nama_barang: fallbackName || 'Transaksi',
        jumlah: Math.round(Number(grandTotal) || 0),
      },
    ];
  }

  const subtotal = validItems.reduce((acc, item) => acc + (Number(item.jumlah) || 0), 0);
  const targetTotal = Math.round(Number(grandTotal) || subtotal);

  // Jika subtotal 0 tetapi ada targetTotal, bagi rata ke seluruh item
  if (subtotal <= 0 && targetTotal > 0) {
    const equalShare = Math.floor(targetTotal / validItems.length);
    const distributed = validItems.map((item) => ({
      nama_barang: item.nama_barang,
      jumlah: equalShare,
    }));
    const remainder = targetTotal - equalShare * validItems.length;
    distributed[distributed.length - 1].jumlah += remainder;
    return distributed;
  }

  // Jika subtotal sudah sama persis dengan targetTotal (tidak ada pajak/selisih), kembalikan langsung
  if (subtotal === targetTotal) {
    return validItems.map((item) => ({
      nama_barang: item.nama_barang,
      jumlah: Math.round(item.jumlah),
    }));
  }

  // Distribusi proporsional ke masing-masing item
  let runningSum = 0;
  const proportionalItems = validItems.map((item) => {
    const proportionalAmount = Math.round((item.jumlah / subtotal) * targetTotal);
    runningSum += proportionalAmount;
    return {
      nama_barang: item.nama_barang,
      jumlah: proportionalAmount,
    };
  });

  // Koreksi selisih pembulatan desimal (±1 atau ±2 rupiah) pada item terakhir
  const roundingDiff = targetTotal - runningSum;
  if (roundingDiff !== 0) {
    proportionalItems[proportionalItems.length - 1].jumlah += roundingDiff;
  }

  return proportionalItems;
}

/**
 * 7. Orkestrator Post-Processing Hasil Ekstraksi Gemini
 */
function normalizeGeminiResult(rawJson, textMessage = null, todayWIB = getTodayWIB()) {
  const merchant = String(rawJson?.merchant || '-').trim() || '-';

  // Prioritas Tanggal: 1. Regex Teks Eksplisit -> 2. Tanggal AI Valid -> 3. Hari Ini (WIB)
  const regexDate = textMessage ? extractDateFromText(textMessage, todayWIB.year) : null;
  const aiDate = /^\d{4}-\d{2}-\d{2}$/.test(String(rawJson?.tanggal || '').trim())
    ? String(rawJson.tanggal).trim()
    : null;
  const tanggal = regexDate || aiDate || todayWIB.isoDate;

  // Tahap A: Lebur Add-ons menjadi Format A
  const mergedItems = mergeItemAddons(rawJson?.items || []);

  // Hitung total apabila AI mengembalikan total = 0
  const sumMerged = mergedItems.reduce((acc, item) => acc + item.jumlah, 0);
  const rawTotal = Number(rawJson?.total) || 0;
  const finalTotal = rawTotal > 0 ? Math.round(rawTotal) : Math.round(sumMerged);

  // Tahap B: Distribusi pajak/service/pembulatan secara proporsional
  const finalItems = distributeProportionalTotal(
    mergedItems,
    finalTotal,
    merchant !== '-' ? merchant : 'Pengeluaran'
  );

  // Tahap C: Kunci ke salah satu dari 4 kategori resmi
  const kategori = normalizeCategory(rawJson?.kategori, merchant, finalItems);

  return {
    merchant,
    tanggal,
    kategori,
    total: finalTotal,
    items: finalItems,
  };
}

/**
 * Helper konversi ArrayBuffer gambar ke Base64 yang aman untuk ukuran file besar di Cloudflare Workers
 */
function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunkSize = 0x8000; // 32KB per chunk untuk mencegah Call Stack Size Exceeded
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * FUNGSI UTAMA 1: Memproses Gambar Struk Belanja (Vision OCR)
 * @param {Object} env - Environment variables Cloudflare Workers
 * @param {ArrayBuffer|Uint8Array} imageBuffer - Data biner foto struk dari Telegram
 * @param {string} [mimeType='image/jpeg'] - Tipe MIME gambar
 */
export async function parseReceiptWithGemini(env, imageBuffer, mimeType = 'image/jpeg') {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi di environment variables (.dev.vars).');
  }

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const todayWIB = getTodayWIB();
  const base64Image = arrayBufferToBase64(imageBuffer);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [
          { text: buildSystemPrompt(todayWIB) },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Image,
            },
          },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.1,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini API Error (Vision OCR): ${JSON.stringify(data)}`);
  }

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Gemini tidak mengembalikan hasil pembacaan struk yang valid.');
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Gagal mengurai JSON dari Gemini OCR: ${rawText}`);
  }

  return normalizeGeminiResult(parsedJson, null, todayWIB);
}

/**
 * FUNGSI UTAMA 2: Memproses Kalimat Pengeluaran Manual (NLP Text Parsing)
 * @param {Object} env - Environment variables Cloudflare Workers
 * @param {string} textMessage - Kalimat input dari pengguna di Telegram
 */
export async function parseTextWithGemini(env, textMessage) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi di environment variables (.dev.vars).');
  }

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const todayWIB = getTodayWIB();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [
          { text: buildSystemPrompt(todayWIB) },
          { text: `Ekstrak transaksi dari kalimat pengguna berikut: "${textMessage}"` },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.1,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini API Error (Text Parsing): ${JSON.stringify(data)}`);
  }

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Gemini tidak mengembalikan respons ekstraksi teks yang valid.');
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Gagal mengurai JSON dari Gemini Text: ${rawText}`);
  }

  return normalizeGeminiResult(parsedJson, textMessage, todayWIB);
}