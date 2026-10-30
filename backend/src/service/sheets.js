import { getGoogleAccessToken } from './googleAuth.js';

const SHEETS_SCOPE = ['https://www.googleapis.com/auth/spreadsheets'];
const BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * Fungsi internal untuk menambahkan baris (append) ke sheet tertentu
 */
async function appendToSheet(spreadsheetId, range, values, accessToken) {
  const url = `${BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      values: values,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gagal menulis ke sheet (${range}): ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Menyimpan data transaksi dan detail barang dari Bot Telegram ke Google Sheets
 * @param {Object} env - Environment variables Cloudflare Workers
 * @param {Object} trx - Data utama transaksi { id, tanggal, merchant, total, dibayar_oleh, file_id, notes }
 * @param {Array} items - Daftar item [{ nama_barang, jumlah, tempat }]
 */
export async function saveTransactionToSheets(env, trx, items = []) {
  const token = await getGoogleAccessToken(env.SERVICE_ACCOUNT_JSON, SHEETS_SCOPE);
  const spreadsheetId = env.GOOGLE_SHEETS_ID;

  // A. Susun 1 baris untuk tabel 'transaction'
  // Kolom: id | tanggal | merchant | total | dibayar_oleh | file_id
  const transactionRow = [
    [
      trx.id,                       // Format: TRX-yyyyMMdd-HHmmss
      trx.tanggal,
      trx.merchant,
      trx.total,
      trx.dibayar_oleh,
      trx.file_id || '-',           // ID file Google Drive (atau '-' jika input teks manual)
    ]
  ];

  // Simpan ke sheet 'transaction'
  await appendToSheet(spreadsheetId, 'transaction!A:F', transactionRow, token);

  // Susun baris-baris untuk tabel 'transaction_detail'
  // Kolom: transaction_id | nama_barang | jumlah | tempat | notes
  if (items.length > 0) {
    const detailRows = items.map((item) => [
      trx.id,                       // Foreign Key (terhubung dengan ID Transaksi)
      item.nama_barang,
      item.jumlah,
      item.tempat || trx.merchant || '-',
      trx.notes || '-',
    ]);

    // Simpan sekaligus (bulk append) ke sheet 'transaction_detail'
    await appendToSheet(spreadsheetId, 'transaction_detail!A:E', detailRows, token);
  }

  return { success: true, transactionId: trx.id };
}

/**
 * Mengambil seluruh data transaksi & detailnya untuk Web Dashboard (Vercel)
 * @param {Object} env - Environment variables Cloudflare Workers
 */
export async function getDashboardDataFromSheets(env) {
  const token = await getGoogleAccessToken(env.SERVICE_ACCOUNT_JSON, SHEETS_SCOPE);
  const spreadsheetId = env.GOOGLE_SHEETS_ID;

  // Menggunakan batchGet agar cukup 1x HTTP request untuk mengambil 2 tabel sekaligus
  const ranges = [
    'transaction!A2:F',
    'transaction_detail!A2:E'
  ].map((r) => `ranges=${encodeURIComponent(r)}`).join('&');

  const url = `${BASE_URL}/${spreadsheetId}/values:batchGet?${ranges}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gagal mengambil data dashboard dari Sheets: ${JSON.stringify(data)}`);
  }

  const transactionRows = data.valueRanges?.[0]?.values || [];
  const detailRows = data.valueRanges?.[1]?.values || [];

  // Kelompokkan detail barang berdasarkan transaction_id agar mudah dirender di Frontend
  const detailsByTrxId = {};
  for (const row of detailRows) {
    const [transaction_id, nama_barang, jumlah, tempat, notes] = row;
    if (!detailsByTrxId[transaction_id]) {
      detailsByTrxId[transaction_id] = [];
    }
    detailsByTrxId[transaction_id].push({
      nama_barang: nama_barang || '',
      jumlah: Number(jumlah) || 0,
      tempat: tempat || '-',
      notes: notes || '-',
    });
  }

  // Gabungkan header transaksi dengan rincian barangnya (Relasi One-to-Many)
  const transactions = transactionRows.map((row) => {
    const [id, tanggal, merchant, total, dibayar_oleh, file_id] = row;
    return {
      id,
      tanggal,
      merchant,
      total: Number(total) || 0,
      dibayar_oleh,
      file_id: file_id !== '-' ? file_id : null,
      items: detailsByTrxId[id] || [],
    };
  });

  return transactions;
}