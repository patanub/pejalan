import { getGoogleAccessToken } from './googleAuth.js';

// Menggunakan scope drive.file sesuai prinsip Least Privilege
const DRIVE_SCOPE = ['https://www.googleapis.com/auth/drive.file'];
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';

/**
 * Fungsi pembantu untuk membuat nama file STRUK_yyyyMMdd_HHmmss.jpg (WIB / UTC+7)
 * Catatan: Nantinya fungsi ini juga bisa dipusatkan di backend/src/utils/formatter.js
 */
export function generateReceiptFileName(date = new Date()) {
  // Konversi waktu ke zona waktu WIB (UTC+7)
  const wibTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');

  const yyyy = wibTime.getUTCFullYear();
  const MM = pad(wibTime.getUTCMonth() + 1);
  const dd = pad(wibTime.getUTCDate());
  const HH = pad(wibTime.getUTCHours());
  const mm = pad(wibTime.getUTCMinutes());
  const ss = pad(wibTime.getUTCSeconds());

  return `STRUK_${yyyy}${MM}${dd}_${HH}${mm}${ss}.jpg`;
}

/**
 * Mengunggah foto struk secara permanen ke folder Google Drive
 * @param {Object} env - Environment variables Cloudflare Workers
 * @param {ArrayBuffer|Uint8Array} imageBuffer - Data biner foto struk dari Telegram
 * @param {string} [customFileName] - Nama file opsional (default: STRUK_yyyyMMdd_HHmmss.jpg)
 * @param {string} [mimeType='image/jpeg'] - Tipe MIME gambar
 * @returns {Promise<{fileId: string, fileName: string, webViewLink: string}>}
 */
export async function uploadReceiptToDrive(
  env,
  imageBuffer,
  customFileName = null,
  mimeType = 'image/jpeg'
) {
  // Dapatkan Access Token dari Service Account
  const token = await getGoogleAccessToken(env.SERVICE_ACCOUNT_JSON, DRIVE_SCOPE);
  const folderId = env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID belum dikonfigurasi di environment variables (.dev.vars).');
  }

  const fileName = customFileName || generateReceiptFileName();

  // Siapkan metadata file untuk Google Drive (nama file & lokasi folder arsip)
  const metadata = {
    name: fileName,
    mimeType: mimeType,
    parents: [folderId],
  };

  // Susun body Multipart/Related (menggabungkan metadata JSON dan file biner gambar)
  const boundary = '-------CloudflareWorkerDriveBoundary' + Date.now();
  const encoder = new TextEncoder();

  const metadataPart = encoder.encode(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );

  const footerPart = encoder.encode(`\r\n--${boundary}--`);
  const fileBytes = imageBuffer instanceof Uint8Array ? imageBuffer : new Uint8Array(imageBuffer);

  // Gabungkan metadataPart + fileBytes + footerPart menjadi satu Uint8Array utuh
  const multipartBody = new Uint8Array(
    metadataPart.byteLength + fileBytes.byteLength + footerPart.byteLength
  );
  multipartBody.set(metadataPart, 0);
  multipartBody.set(fileBytes, metadataPart.byteLength);
  multipartBody.set(footerPart, metadataPart.byteLength + fileBytes.byteLength);

  // 4. Kirim ke Google Drive REST API via Fetch
  const response = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(multipartBody.byteLength),
    },
    body: multipartBody,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gagal mengunggah struk ke Google Drive: ${JSON.stringify(data)}`);
  }

  return {
    fileId: data.id,            // Disimpan ke kolom file_id di sheet 'transaction'
    fileName: data.name,        // Contoh: STRUK_20261026_135500.jpg
    webViewLink: data.webViewLink || null,
  };
}