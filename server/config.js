import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export const CONFIG = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),
  recordingsDir: process.env.RECORDINGS_DIR
    ? path.resolve(process.env.RECORDINGS_DIR)
    : path.join(ROOT, 'recordings'),
  port: intFromEnv('PORT', 3000),
  // Bind publicly by default so container hosts and reverse proxies can reach the app.
  host: process.env.HOST || '0.0.0.0',
  watchIntervalMs: Math.max(15_000, intFromEnv('WATCH_INTERVAL_MS', 60_000)),
  maxConcurrent: Math.max(1, intFromEnv('MAX_CONCURRENT', 3)),
  minFreeBytes: 1024 ** 3,
  signApiKey: process.env.TIKTOK_SIGN_API_KEY || undefined,
  // Every capture is framed for a vertical 9:16 screen and encoded at 1080x1920.
  // If TikTok only serves 720p, the picture is upscaled so the saved file is
  // still a consistent 1080x1920 portrait recording.
  portrait: process.env.PORTRAIT !== '0',
  portraitWidth: 1080,
  portraitHeight: 1920,
  defaultFrame: ['auto', 'center', 'left', 'right'].includes(
    String(process.env.PORTRAIT_FRAME || '').toLowerCase(),
  )
    ? String(process.env.PORTRAIT_FRAME).toLowerCase()
    : 'auto',
};

export const BRAND = 'Burst Recording Service';
