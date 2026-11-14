import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from './config.js';
import {
  getActiveRecordings,
  getEngineInfo,
  getEvents,
  pushEvent,
  recoverOrphans,
  shutdownRecorders,
  startRecording,
  stopRecording,
} from './recorder.js';
import { initStore, listRecordings, mediaPath, removeRecording, totalStoredBytes } from './store.js';
import { checkLive } from './tiktok.js';
import { AppError, log, normalizeUsername, publicRecording, sanitizeFilePart } from './util.js';
import { addWatcher, initWatchers, listWatchers, removeWatcher, stopWatchers } from './watchers.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "media-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: '16kb' }));

// Public deployment: no site-wide login, access key, or authentication gate.

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function isActiveRecording(id) {
  return getActiveRecordings().some((recording) => recording.id === id);
}

function publicStreamInfo(stream) {
  if (!stream) return null;
  const { url, ...rest } = stream;
  return rest;
}

function localFileStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(
    date.getHours(),
  )}-${pad(date.getMinutes())}`;
}

function watchedUsernames() {
  return new Set(listWatchers().map((watcher) => watcher.username.toLowerCase()));
}

async function freeDiskBytes() {
  try {
    const stats = await fsp.statfs(CONFIG.recordingsDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

app.get(
  '/api/state',
  route(async (req, res) => {
    const recordings = listRecordings().map(publicRecording);
    const usedBytes = totalStoredBytes();
    const engine = await getEngineInfo();

    res.json({
      ok: true,
      now: Date.now(),
      recordings,
      active: getActiveRecordings(),
      watchers: listWatchers(),
      storage: {
        usedBytes,
        count: recordings.length,
        freeBytes: await freeDiskBytes(),
      },
      engine,
      events: getEvents().slice(-20),
      settings: {
        maxConcurrent: CONFIG.maxConcurrent,
        watchIntervalSec: Math.round(CONFIG.watchIntervalMs / 1000),
        portrait: CONFIG.portrait,
        portraitWidth: CONFIG.portraitWidth,
        portraitHeight: CONFIG.portraitHeight,
        defaultFrame: CONFIG.defaultFrame,
      },
    });
  }),
);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, now: Date.now() });
});

app.post(
  '/api/check',
  route(async (req, res) => {
    const status = await checkLive(req.body?.username, { profile: true, force: true });
    res.json({
      ok: true,
      ...status,
      stream: publicStreamInfo(status.stream),
      watched: watchedUsernames().has(status.user.username.toLowerCase()),
    });
  }),
);

app.post(
  '/api/record',
  route(async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const status = await checkLive(username, { profile: true, force: true });

    if (!status.live) {
      res.json({
        ok: true,
        live: false,
        started: false,
        user: status.user,
        watched: watchedUsernames().has(status.user.username.toLowerCase()),
      });
      return;
    }

    const existing = getActiveRecordings().find(
      (recording) => recording.username.toLowerCase() === status.user.username.toLowerCase(),
    );
    if (existing) {
      res.json({
        ok: true,
        live: true,
        started: false,
        alreadyRecording: true,
        recording: existing,
        user: status.user,
        room: status.room,
      });
      return;
    }

    if (!status.stream) {
      res.json({
        ok: true,
        live: true,
        started: false,
        noStream: true,
        user: status.user,
        room: status.room,
        message: "They're live, but TikTok isn't sharing a playable stream right now. Try again in a moment.",
      });
      return;
    }

    if (!status.qualities.some((quality) => /1080|full hd/i.test(quality.label))) {
      log(
        `Best quality for @${username} is ${status.stream.label} (TikTok is not offering a 1080p tier for this stream).`,
      );
    }

    const recording = await startRecording({
      username: status.user.username || username,
      user: status.user,
      room: status.room,
      stream: status.stream,
      source: 'manual',
      frame: req.body?.frame,
      dualLayout: status.dualLayout,
    });

    res.json({
      ok: true,
      live: true,
      started: !recording.already,
      alreadyRecording: recording.already,
      recording: recording.session,
      user: status.user,
      room: status.room,
      stream: publicStreamInfo(status.stream),
      qualities: status.qualities,
      dualLayout: status.dualLayout,
    });
  }),
);

app.post(
  '/api/recordings/:id/stop',
  route(async (req, res) => {
    const recording = stopRecording(req.params.id);
    res.json({ ok: true, recording });
  }),
);

app.delete(
  '/api/recordings/:id',
  route(async (req, res) => {
    const recording = listRecordings().find((item) => item.id === req.params.id);
    if (!recording) throw new AppError(404, 'That recording no longer exists.');

    if (isActiveRecording(recording.id)) {
      throw new AppError(409, 'Stop the recording before deleting it.');
    }


    for (const fileName of [recording.file, recording.thumb]) {
      if (!fileName) continue;
      const filePath = mediaPath(fileName);
      if (!filePath) continue;
      try {
        await fsp.unlink(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          log(`Could not delete ${path.basename(filePath)}:`, error.message);
        }
      }
    }

    removeRecording(recording.id);
    pushEvent('recording-deleted', `Deleted @${recording.username}'s recording.`, {
      username: recording.username,
      recordingId: recording.id,
    });
    log(`Deleted recording ${recording.id} (@${recording.username}).`);

    res.json({ ok: true, deleted: recording.id });
  }),
);

app.get(
  '/api/recordings/:id/download',
  route(async (req, res) => {
    const recording = listRecordings().find((item) => item.id === req.params.id);
    if (!recording) throw new AppError(404, 'That recording no longer exists.');

    const filePath = mediaPath(recording.file);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new AppError(404, 'The recording file is missing from disk.');
    }

    const extension = path.extname(recording.file) || '.mp4';
    const date = new Date(recording.startedAt || Date.now());
    const downloadName = `${sanitizeFilePart(recording.username)}_${localFileStamp(date)}${extension}`;
    res.download(filePath, downloadName);
  }),
);

app.get('/api/watchers', (req, res) => {
  res.json({ ok: true, watchers: listWatchers() });
});

app.post(
  '/api/watchers',
  route(async (req, res) => {
    const result = await addWatcher(req.body?.username, { frame: req.body?.frame });
    res.json({ ok: true, ...result });
  }),
);

app.delete(
  '/api/watchers/:username',
  route(async (req, res) => {
    const result = removeWatcher(req.params.username);
    res.json(result);
  }),
);

app.use(
  '/media',
  express.static(CONFIG.recordingsDir, {
    index: false,
    dotfiles: 'deny',
    fallthrough: false,
    maxAge: '1h',
    setHeaders(res) {
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=3600');
    },
  }),
);

app.use(
  express.static(CONFIG.publicDir, {
    index: 'index.html',
    extensions: ['html'],
    maxAge: 0,
  }),
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ ok: false, error: 'Not found.' });
    return;
  }
  res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (res.headersSent) {
    res.end();
    return;
  }

  if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ ok: false, error: 'Invalid JSON in the request body.' });
    return;
  }

  const status = error instanceof AppError ? error.status : Number(error.status) || 500;
  if (status >= 500) {
    log('Request failed:', error.name || 'Error', error.message || error);
  }

  const message =
    error instanceof AppError
      ? error.message
      : status === 404
        ? 'Not found.'
        : status === 413
          ? 'Request body is too large.'
          : 'Something went wrong on the server. Check the terminal for details.';

  res.status(status).json({ ok: false, error: message });
});

let server = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}. Shutting down…`);

  stopWatchers();
  try {
    await shutdownRecorders(20_000);
  } catch (error) {
    log('Error while stopping recorders:', error.message);
  }

  if (server) {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } else {
    process.exit(0);
  }
}

async function main() {
  initStore();

  const engine = await getEngineInfo();
  if (engine.ready) {
    log(`Recording engine ready: ffmpeg ${engine.version}`);
  } else {
    log('WARNING: ffmpeg is not available:', engine.error);
    log('Run "npm install" inside this folder to restore it.');
  }

  await recoverOrphans();
  initWatchers();

  server = app.listen(CONFIG.port, CONFIG.host, () => {
    const shownHost = CONFIG.host === '0.0.0.0' ? 'localhost' : CONFIG.host;
    log(`Burst Recording Service is running at http://${shownHost}:${CONFIG.port}`);
    log(`Recordings folder: ${CONFIG.recordingsDir}`);
    if (CONFIG.host === '0.0.0.0') {
      log('Network access is enabled (HOST=0.0.0.0). Anyone on your network can view recordings.');
    }
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      log(`Port ${CONFIG.port} is already in use. Close the other app or start with PORT=3001.`);
    } else {
      log('Server error:', error.message);
    }
    process.exit(1);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((error) => {
  log('Fatal startup error:', error);
  process.exit(1);
});
