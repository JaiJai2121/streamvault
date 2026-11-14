export class AppError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
  }
}

export function normalizeUsername(raw) {
  if (typeof raw !== 'string') {
    throw new AppError(400, 'Enter a TikTok username.');
  }

  let value = raw.trim();
  if (!value) throw new AppError(400, 'Enter a TikTok username.');

  // Accept a profile/live URL as well as a bare @username.
  const fromUrl = value.match(/tiktok\.com\/@([^/?#\s]+)/i);
  if (fromUrl) value = fromUrl[1];

  value = value.replace(/^@+/, '').trim();

  if (!/^[A-Za-z0-9._]{1,24}$/.test(value)) {
    throw new AppError(400, "That doesn't look like a TikTok username. Use letters, numbers, dots or underscores.");
  }

  return value;
}

export function sanitizeFilePart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'recording';
}

export function fileStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '_' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('-');
}

export function publicRecording(rec) {
  const media = (file) => (file ? `/media/${encodeURIComponent(file)}` : null);
  return {
    ...rec,
    fileUrl: media(rec.file),
    thumbUrl: media(rec.thumb),
    downloadUrl: `/api/recordings/${encodeURIComponent(rec.id)}/download`,
  };
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout(promise, ms, message = 'The request took too long.') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AppError(504, message)), ms);
    }),
  ]);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function log(...args) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[burst ${stamp}]`, ...args);
}
