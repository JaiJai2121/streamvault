import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { CONFIG } from './config.js';
import * as store from './store.js';
import { AppError, delay, fileStamp, log, sanitizeFilePart } from './util.js';

/** @type {Map<string, any>} */
const active = new Map();
/** @type {Map<string, string>} */
const activeByUsername = new Map();

let eventSequence = 0;
const events = [];
let engineInfoPromise = null;

export function pushEvent(type, message, data = {}) {
  const event = { id: ++eventSequence, type, message, at: Date.now(), ...data };
  events.push(event);
  if (events.length > 40) events.shift();
  return event;
}

export function getEvents() {
  return [...events];
}

function publicSession(session) {
  return {
    id: session.id,
    username: session.username,
    nickname: session.nickname,
    avatar: session.avatar,
    cover: session.cover,
    title: session.title,
    quality: session.quality,
    protocol: session.protocol,
    startedAt: session.startedAt,
    status: session.status,
    durationSec: Math.max(0, Math.round(session.durationSec || 0)),
    sizeBytes: Math.max(0, Math.round(session.sizeBytes || 0)),
    width: session.width || null,
    height: session.height || null,
    portrait: Boolean(session.portrait),
    frame: session.frame || null,
    source: session.source,
    error: session.error || null,
  };
}

export function getActiveRecordings() {
  return [...active.values()]
    .map(publicSession)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function isRecording(username) {
  return activeByUsername.has(String(username).toLowerCase());
}

export function getActiveForUsername(username) {
  const id = activeByUsername.get(String(username).toLowerCase());
  return id ? publicSession(active.get(id)) : null;
}

export function getEngineInfo() {
  if (!engineInfoPromise) {
    engineInfoPromise = (async () => {
      try {
        const result = await runCapture(ffmpegPath, ['-version'], 15_000);
        if (result.code !== 0 && !result.stdout) {
          return { ready: false, error: 'ffmpeg could not be started.' };
        }
        const firstLine = (result.stdout || result.stderr).split(/\r?\n/)[0] || 'ffmpeg';
        return {
          ready: true,
          binary: 'ffmpeg',
          version: firstLine.replace(/^ffmpeg version\s*/i, '').split(' ')[0] || firstLine,
          detail: firstLine,
        };
      } catch (error) {
        return { ready: false, error: error.message };
      }
    })();
  }
  return engineInfoPromise;
}

async function assertDiskSpace() {
  try {
    const stats = await fsp.statfs(CONFIG.recordingsDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(freeBytes) && freeBytes < CONFIG.minFreeBytes) {
      throw new AppError(
        507,
        `Not enough disk space to start a recording. Free up some space (at least ${Math.ceil(
          CONFIG.minFreeBytes / 1024 ** 3,
        )} GB recommended) and try again.`,
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Some filesystems don't support statfs; don't block recording because of that.
  }
}

const PORTRAIT_FRAMES = new Set(['center', 'left', 'right']);

/**
 * Resolves the portrait framing. "auto" follows the room: a split/dual layout
 * is cropped to the left portrait pane, everything else is centre-cropped.
 */
export function resolveFrame(rawFrame, dualLayout = false) {
  const value = String(rawFrame || '').toLowerCase();
  if (PORTRAIT_FRAMES.has(value)) return value;
  return dualLayout ? 'left' : 'center';
}

function buildCaptureArgs(stream, outputFile, frame) {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-progress',
    'pipe:1',
    '-stats_period',
    '2',
    '-y',
    '-rw_timeout',
    '15000000',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
  ];

  if (stream.protocol === 'hls' || /\.m3u8(\?|$)/i.test(stream.url)) {
    args.push('-live_start_index', '-1');
  }

  args.push('-i', stream.url, '-map', '0:v:0?', '-map', '0:a:0?');

  if (CONFIG.portrait) {
    const width = CONFIG.portraitWidth;
    const height = CONFIG.portraitHeight;
    const cropX = frame === 'left' ? '0' : frame === 'right' ? 'iw-ow' : '(iw-ow)/2';
    const filter = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}:${cropX}:(ih-oh)/2`,
      'setsar=1',
    ].join(',');

    args.push(
      '-vf',
      filter,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '21',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high',
      '-g',
      '60',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ar',
      '48000',
      '-max_muxing_queue_size',
      '2048',
      '-f',
      'mpegts',
      outputFile,
    );
  } else {
    args.push('-c', 'copy', '-f', 'mpegts', outputFile);
  }

  return args;
}

/**
 * Starts a new ffmpeg capture. Returns quickly (after the first few seconds)
 * so the UI can show a live "recording" state.
 */
export async function startRecording({
  username,
  user,
  room,
  stream,
  source = 'manual',
  frame = CONFIG.defaultFrame,
  dualLayout = false,
}) {
  const engine = await getEngineInfo();
  if (!engine.ready) {
    throw new AppError(503, 'The recording engine (ffmpeg) is not available. Run "npm install" again.');
  }

  const usernameKey = String(username).toLowerCase();
  const existingId = activeByUsername.get(usernameKey);
  if (existingId) {
    const existing = active.get(existingId);
    return { session: publicSession(existing), already: true };
  }

  if (active.size >= CONFIG.maxConcurrent) {
    throw new AppError(
      429,
      `Burst Recording Service is already recording ${active.size} streams at once. Stop one before starting another.`,
    );
  }

  await assertDiskSpace();

  const resolvedFrame = CONFIG.portrait ? resolveFrame(frame, dualLayout) : 'source';

  const now = new Date();
  const id = `rec_${now.getTime().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const baseName = `${fileStamp(now)}_${sanitizeFilePart(username)}_${id}`;
  const tsFile = `${baseName}.ts`;
  const mp4File = `${baseName}.mp4`;
  const thumbFile = `${baseName}.jpg`;
  const tsPath = path.join(CONFIG.recordingsDir, tsFile);

  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const session = {
    id,
    username,
    nickname: user?.nickname || username,
    avatar: user?.avatar || null,
    cover: room?.cover || user?.avatar || null,
    title: room?.title || 'Live stream',
    quality: stream.label || 'Best available',
    qualityKey: stream.key,
    protocol: stream.protocol,
    startedAt: now.getTime(),
    status: 'starting',
    durationSec: 0,
    sizeBytes: 0,
    width: CONFIG.portrait ? CONFIG.portraitWidth : null,
    height: CONFIG.portrait ? CONFIG.portraitHeight : null,
    portrait: CONFIG.portrait,
    frame: resolvedFrame,
    tsFile,
    mp4File,
    thumbFile,
    child: null,
    stopRequested: false,
    stderrTail: '',
    error: null,
    source,
    donePromise,
    resolveDone,
    readyPromise,
    resolveReady,
  };

  active.set(id, session);
  activeByUsername.set(usernameKey, id);

  log(
    `Starting recording for @${username} (${stream.label}, ${stream.protocol}, 9:16 ${resolvedFrame}) -> ${tsFile}`,
  );

  let child;
  try {
    child = spawn(ffmpegPath, buildCaptureArgs(stream, tsPath, resolvedFrame), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    finishCleanup(session);
    throw new AppError(500, `Could not start ffmpeg: ${error.message}`);
  }
  session.child = child;

  // ffmpeg's `-progress` output can be buffered when stdout isn't a terminal.
  // Stat the growing file on a timer so the UI gets live size/progress even if
  // progress blocks arrive late.
  session.sizeTimer = setInterval(() => {
    const bytes = fileSizeOf(tsPath);
    if (bytes > session.sizeBytes) session.sizeBytes = bytes;
    if (bytes > 1024 && !sawData) {
      sawData = true;
      markData();
    }
  }, 1000);
  session.sizeTimer.unref?.();

  let stdoutBuffer = '';
  let sawData = false;

  const markData = () => {
    sawData = true;
    if (session.status === 'starting') session.status = 'recording';
    session.resolveReady?.();
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line || !line.includes('=')) continue;
      const [key, value = ''] = line.split('=', 2);
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const micros = Number(value);
        if (Number.isFinite(micros) && micros > 0) {
          // Live streams often start at a non-zero PTS. Measure from the first
          // progress value so this fallback duration reflects capture time.
          if (session.progressBaseUs == null) session.progressBaseUs = micros;
          session.durationSec = Math.max(0, (micros - session.progressBaseUs) / 1_000_000);
          markData();
        }
      } else if (key === 'total_size') {
        const bytes = Number(value);
        if (Number.isFinite(bytes) && bytes > 0) {
          session.sizeBytes = bytes;
          markData();
        }
      } else if (key === 'progress' && value === 'continue') {
        markData();
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    session.stderrTail = `${session.stderrTail}${text}`.slice(-2000);
    for (const line of text.split(/\r?\n/)) {
      if (/error|failed|forbidden|not found|unable/i.test(line) && line.trim()) {
        log(`ffmpeg @${username}:`, line.trim().slice(0, 240));
      }
    }
  });

  child.once('error', (error) => {
    session.status = 'failed';
    session.error = `Recording engine error: ${error.message}`;
    session.resolveReady?.();
    try {
      fs.unlinkSync(tsPath);
    } catch {
      /* no partial file */
    }
    pushEvent('recording-failed', `Could not start recording @${username}: ${error.message}`, {
      username,
      recordingId: id,
    });
    finishCleanup(session);
  });

  child.once('exit', (code, signal) => {
    session.exitCode = code;
    session.exitSignal = signal;
    handleExit(session, sawData).catch((error) => {
      log(`Finalize crashed for @${username}:`, error);
    });
  });

  // Give ffmpeg a moment to connect and produce its first progress line. If it
  // dies immediately (private stream, bad URL, TikTok token expiry) surface a
  // useful error rather than a phantom "recording".
  await Promise.race([readyPromise, delay(2200)]);

  if (session.status === 'failed') {
    throw new AppError(502, session.error || 'The stream could not be opened.');
  }

  pushEvent('recording-started', `Recording @${username} in ${session.quality} portrait.`, {
    username,
    recordingId: id,
    quality: session.quality,
    source,
  });

  return { session: publicSession(session), already: false };
}

async function handleExit(session, sawData) {
  if (session.sizeTimer) {
    clearInterval(session.sizeTimer);
    session.sizeTimer = null;
  }

  // An earlier spawn 'error' already tore this session down.
  if (session.status === 'failed' && !active.has(session.id)) {
    return;
  }

  session.endedAt = Date.now();
  session.resolveReady?.();

  const fileSize = fileSizeOf(path.join(CONFIG.recordingsDir, session.tsFile));

  // ffmpeg can exit before writing anything. Treat that as a failed start, not
  // an empty recording in the vault.
  if (!sawData && fileSize < 1024) {
    session.status = 'failed';
    session.error =
      extractFfmpegError(session.stderrTail) || 'The stream ended before any video could be captured.';
    try {
      fs.unlinkSync(path.join(CONFIG.recordingsDir, session.tsFile));
    } catch {
      /* already gone */
    }
    pushEvent('recording-failed', `Recording @${session.username} failed: ${session.error}`, {
      username: session.username,
      recordingId: session.id,
    });
    finishCleanup(session);
    return;
  }

  session.status = 'saving';
  pushEvent('recording-saving', `Saving @${session.username}'s recording…`, {
    username: session.username,
    recordingId: session.id,
  });

  try {
    await finalizeSession(session, { keepTsOnFailure: false });
  } catch (error) {
    session.status = 'failed';
    session.error = error.message;
    log(`Could not finalize @${session.username}:`, error);
    pushEvent('recording-failed', `Could not save @${session.username}'s recording: ${error.message}`, {
      username: session.username,
      recordingId: session.id,
    });
  } finally {
    finishCleanup(session);
  }
}

function finishCleanup(session) {
  if (session.sizeTimer) {
    clearInterval(session.sizeTimer);
    session.sizeTimer = null;
  }
  if (active.get(session.id) === session) active.delete(session.id);
  if (activeByUsername.get(session.username.toLowerCase()) === session.id) {
    activeByUsername.delete(session.username.toLowerCase());
  }
  session.resolveDone?.();
}

function extractFfmpegError(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const keyLines = lines.filter((line) => /error|failed|forbidden|not found|unable|invalid/i.test(line));
  const found = keyLines.at(-1) || lines.at(-1);
  if (!found) return null;
  return found.replace(/^\[[^\]]+\]\s*/, '').slice(0, 220);
}

async function finalizeSession(session, { keepTsOnFailure = true } = {}) {
  const tsPath = path.join(CONFIG.recordingsDir, session.tsFile);
  const mp4Path = path.join(CONFIG.recordingsDir, session.mp4File);
  let finalPath = null;
  let finalFile = null;
  let format = 'mp4';
  let warning = null;

  if (fileSizeOf(tsPath) > 1024) {
    const remux = await runCapture(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-i',
        tsPath,
        '-max_muxing_queue_size',
        '2048',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        mp4Path,
      ],
      60_000,
    );

    if (remux.code === 0 && fileSizeOf(mp4Path) > 1024) {
      finalPath = mp4Path;
      finalFile = session.mp4File;
    } else {
      log(`Remux failed for ${session.tsFile}:`, (remux.stderr || '').slice(-500));
      warning = 'Could not convert to MP4; saved in the original MPEG-TS format.';
      if (!keepTsOnFailure) {
        // Fall through and keep the .ts file as the recording.
      }
      finalPath = tsPath;
      finalFile = session.tsFile;
      format = 'ts';
    }
  } else if (fileSizeOf(mp4Path) > 1024) {
    finalPath = mp4Path;
    finalFile = session.mp4File;
  } else {
    throw new Error('No video data was written.');
  }

  const probe = await probeMedia(finalPath);
  const durationSec =
    probe.durationSec > 0
      ? probe.durationSec
      : session.durationSec > 0
        ? session.durationSec
        : Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));

  let thumbFile = null;
  try {
    const thumbPath = path.join(CONFIG.recordingsDir, session.thumbFile);
    const thumbOk = await createThumbnail(finalPath, thumbPath, durationSec);
    if (thumbOk) thumbFile = session.thumbFile;
  } catch (error) {
    log(`Thumbnail failed for ${session.tsFile}:`, error.message);
  }

  const finalStat = safeStat(finalPath);
  const recording = {
    id: session.id,
    username: session.username,
    nickname: session.nickname,
    avatar: session.avatar,
    cover: session.cover,
    title: session.title,
    quality: session.quality,
    qualityKey: session.qualityKey,
    protocol: session.protocol,
    width: probe.width || null,
    height: probe.height || null,
    portrait: Boolean(session.portrait),
    frame: session.frame || null,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    durationSec: Math.round(durationSec * 10) / 10,
    sizeBytes: finalStat?.size || session.sizeBytes,
    file: finalFile,
    thumb: thumbFile,
    format,
    source: session.source,
    warning,
  };

  store.addRecording(recording);

  // Only remove the intermediate once an MP4 is safely stored.
  if (format === 'mp4' && tsPath !== finalPath) {
    try {
      fs.unlinkSync(tsPath);
    } catch {
      /* ignore */
    }
  }

  session.status = 'saved';
  const message =
    format === 'mp4'
      ? `Saved @${session.username}'s 9:16 recording (${recording.quality} source, ${Math.round(durationSec)}s).`
      : `Saved @${session.username}'s recording in MPEG-TS format (${Math.round(durationSec)}s).`;
  pushEvent('recording-saved', message, {
    username: session.username,
    recordingId: session.id,
    quality: recording.quality,
  });

  log(
    `Saved ${finalFile} (${(recording.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${recording.width || '?'}x${
      recording.height || '?'
    }, ${recording.durationSec}s)`,
  );

  return recording;
}

export function stopRecording(id) {
  const session = active.get(id);
  if (!session) {
    throw new AppError(404, 'That recording is not currently running.');
  }

  if (session.status === 'recording' || session.status === 'starting') {
    session.stopRequested = true;
    session.status = 'stopping';
    try {
      session.child?.kill();
    } catch (error) {
      log(`Could not stop ffmpeg for ${session.id}:`, error.message);
    }

    const forceTimer = setTimeout(() => {
      if (session.child && session.child.exitCode === null) {
        try {
          session.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 6000);
    forceTimer.unref();

    pushEvent('recording-stopping', `Stopping @${session.username}'s recording…`, {
      username: session.username,
      recordingId: session.id,
    });
  }

  return publicSession(session);
}

export async function waitForRecordingDone(id, timeoutMs = 45_000) {
  const session = active.get(id);
  if (!session) return;
  await Promise.race([session.donePromise, delay(timeoutMs)]);
}

export async function shutdownRecorders(timeoutMs = 20_000) {
  const sessions = [...active.values()];
  if (!sessions.length) return;

  log(`Stopping ${sessions.length} active recording${sessions.length === 1 ? '' : 's'} before shutdown…`);
  for (const session of sessions) {
    if (session.child && session.child.exitCode === null) {
      try {
        session.child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  await Promise.race([
    Promise.allSettled(sessions.map((session) => session.donePromise)),
    delay(timeoutMs),
  ]);
}

async function probeMedia(filePath) {
  const result = await runCapture(
    ffmpegPath,
    ['-hide_banner', '-nostdin', '-i', filePath],
    20_000,
  );
  const output = `${result.stderr}\n${result.stdout}`;

  let durationSec = 0;
  const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (durationMatch) {
    durationSec =
      Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  }

  let width = null;
  let height = null;
  const videoLine = output
    .split(/\r?\n/)
    .find((line) => /Stream #\d+:\d+.*Video:/.test(line));
  if (videoLine) {
    const dimensionMatch = videoLine.match(/(\d{2,5})x(\d{2,5})/);
    if (dimensionMatch) {
      width = Number(dimensionMatch[1]);
      height = Number(dimensionMatch[2]);
    }
  }

  return { durationSec, width, height };
}

async function createThumbnail(inputPath, thumbPath, durationSec) {
  const seek = Math.max(0.1, Math.min(2, (durationSec || 2) / 3));
  const result = await runCapture(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(seek),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '3',
      thumbPath,
    ],
    30_000,
  );
  return result.code === 0 && fileSizeOf(thumbPath) > 100;
}

function runCapture(command, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('ffmpeg timed out.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function fileSizeOf(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Cleans up half-finished captures from a crash/kill. Any orphan .ts is
 * remuxed into the vault, and any orphan .mp4 is indexed. This is what makes
 * a hard shutdown non-destructive.
 */
export async function recoverOrphans() {
  let files;
  try {
    files = await fsp.readdir(CONFIG.recordingsDir);
  } catch {
    return;
  }

  const known = store.knownFileNames();
  const tsFiles = files.filter((file) => file.endsWith('.ts') && !known.has(file));
  const mp4Files = files.filter((file) => file.endsWith('.mp4') && !known.has(file));

  for (const tsFile of tsFiles) {
    const fullPath = path.join(CONFIG.recordingsDir, tsFile);
    const size = fileSizeOf(fullPath);
    if (size < 1024) {
      try {
        await fsp.unlink(fullPath);
      } catch {
        /* ignore */
      }
      continue;
    }

    const base = tsFile.slice(0, -3);
    const mp4Name = `${base}.mp4`;
    const mp4Exists = fileSizeOf(path.join(CONFIG.recordingsDir, mp4Name)) > 1024;
    const idMatch = base.match(/_(rec_[a-z0-9]+)$/i);
    const id = idMatch?.[1] || `rec_recovered${Date.now().toString(36)}`;
    if (store.getRecording(id)) continue;

    const username = usernameFromFile(base) || 'unknown';
    log(`Recovering interrupted recording ${tsFile}…`);

    const session = {
      id,
      username,
      nickname: username,
      avatar: null,
      cover: null,
      title: 'Recovered recording',
      quality: 'Unknown',
      qualityKey: null,
      protocol: null,
      startedAt: statBirth(fullPath),
      durationSec: 0,
      sizeBytes: size,
      tsFile,
      mp4File: mp4Exists ? mp4Name : `${base}.mp4`,
      thumbFile: `${base}.jpg`,
      source: 'recovered',
    };

    try {
      if (!mp4Exists) {
        await finalizeSession(session, { keepTsOnFailure: true });
      } else {
        // The remux succeeded before the crash but the index was never written.
        const probe = await probeMedia(path.join(CONFIG.recordingsDir, mp4Name));
        const thumbOk = await createThumbnail(
          path.join(CONFIG.recordingsDir, mp4Name),
          path.join(CONFIG.recordingsDir, session.thumbFile),
          probe.durationSec,
        ).catch(() => false);
        store.addRecording({
          id,
          username,
          nickname: username,
          avatar: null,
          cover: null,
          title: 'Recovered recording',
          quality: 'Unknown',
          qualityKey: null,
          protocol: null,
          width: probe.width || null,
          height: probe.height || null,
          startedAt: session.startedAt,
          endedAt: session.startedAt,
          durationSec: Math.round(probe.durationSec * 10) / 10,
          sizeBytes: fileSizeOf(path.join(CONFIG.recordingsDir, mp4Name)),
          file: mp4Name,
          thumb: thumbOk ? session.thumbFile : null,
          format: 'mp4',
          source: 'recovered',
          warning: null,
        });
        await fsp.unlink(fullPath).catch(() => {});
      }
      pushEvent('recording-recovered', `Recovered an interrupted recording from @${username}.`, {
        username,
        recordingId: id,
      });
    } catch (error) {
      log(`Could not recover ${tsFile}:`, error.message);
    }
  }

  // Index stray MP4s (e.g. finalization succeeded but the process died before
  // writing the index, and the .ts was already deleted).
  const knownAfter = store.knownFileNames();
  for (const mp4File of [...mp4Files, ...files.filter((f) => f.endsWith('.mp4'))]) {
    if (knownAfter.has(mp4File)) continue;
    const fullPath = path.join(CONFIG.recordingsDir, mp4File);
    if (fileSizeOf(fullPath) < 1024) continue;

    const base = mp4File.slice(0, -4);
    const idMatch = base.match(/_(rec_[a-z0-9]+)$/i);
    const id = idMatch?.[1] || `rec_recovered${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    if (store.getRecording(id)) continue;

    try {
      const probe = await probeMedia(fullPath);
      const username = usernameFromFile(base) || 'unknown';
      const thumbName = `${base}.jpg`;
      const thumbExists = fileSizeOf(path.join(CONFIG.recordingsDir, thumbName)) > 100;
      if (!thumbExists) {
        await createThumbnail(
          fullPath,
          path.join(CONFIG.recordingsDir, thumbName),
          probe.durationSec,
        ).catch(() => false);
      }
      const recording = {
        id,
        username,
        nickname: username,
        avatar: null,
        cover: null,
        title: 'Recovered recording',
        quality: 'Unknown',
        qualityKey: null,
        protocol: null,
        width: probe.width || null,
        height: probe.height || null,
        startedAt: statBirth(fullPath),
        endedAt: statBirth(fullPath),
        durationSec: Math.round(probe.durationSec * 10) / 10,
        sizeBytes: fileSizeOf(fullPath),
        file: mp4File,
        thumb: thumbExists || fileSizeOf(path.join(CONFIG.recordingsDir, thumbName)) > 100 ? thumbName : null,
        format: 'mp4',
        source: 'recovered',
        warning: null,
      };
      store.addRecording(recording);
      knownAfter.add(mp4File);
      knownAfter.add(thumbName);
      pushEvent('recording-recovered', `Indexed an orphaned recording from @${username}.`, {
        username,
        recordingId: id,
      });
      log(`Indexed orphaned recording ${mp4File}`);
    } catch (error) {
      log(`Could not index ${mp4File}:`, error.message);
    }
  }
}

function usernameFromFile(base) {
  const withoutStamp = base.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/, '');
  const withoutId = withoutStamp.replace(/_rec_[a-z0-9]+$/i, '');
  return withoutId && withoutId !== withoutStamp ? withoutId : null;
}

function statBirth(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.birthtimeMs || stat.mtimeMs || Date.now();
  } catch {
    return Date.now();
  }
}
