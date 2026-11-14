import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { getActiveForUsername, isRecording, pushEvent, startRecording } from './recorder.js';
import { checkLive } from './tiktok.js';
import { AppError, log, normalizeUsername } from './util.js';

const watcherFile = path.join(CONFIG.dataDir, 'watchers.json');

/** @type {Array<{username:string, addedAt:number, lastLive:boolean, lastCheckAt:number|null, lastError:string|null, frame:string}>} */
let watchers = [];
let timer = null;
let ticking = false;

export function initWatchers() {
  try {
    if (fs.existsSync(watcherFile)) {
      const parsed = JSON.parse(fs.readFileSync(watcherFile, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.watchers) ? parsed.watchers : [];
      const seen = new Set();
      watchers = list
        .filter((item) => item && typeof item.username === 'string')
        .map((item) => ({
          username: item.username,
          addedAt: Number(item.addedAt) || Date.now(),
          lastLive: Boolean(item.lastLive),
          lastCheckAt: Number(item.lastCheckAt) || null,
          lastError: null,
          frame: ['center', 'left', 'right'].includes(String(item.frame || '').toLowerCase())
            ? String(item.frame).toLowerCase()
            : 'auto',
        }))
        .filter((item) => {
          const key = item.username.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      log(`Loaded ${watchers.length} auto-record watcher${watchers.length === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    log('Could not load watchers:', error.message);
    watchers = [];
  }

  if (watchers.length) {
    // Correct stale live flags shortly after boot, then keep checking.
    setTimeout(() => {
      void tick();
    }, 5000).unref();
  }

  timer = setInterval(() => {
    void tick();
  }, CONFIG.watchIntervalMs);
  timer.unref?.();
}

function persist() {
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    const tmp = `${watcherFile}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        watchers.map(({ username, addedAt, lastLive, frame }) => ({
          username,
          addedAt,
          lastLive,
          frame: frame || 'auto',
        })),
        null,
        2,
      ),
    );
    fs.renameSync(tmp, watcherFile);
  } catch (error) {
    log('Could not save watchers:', error.message);
  }
}

export function listWatchers() {
  return watchers
    .map((watcher) => {
      const active = getActiveForUsername(watcher.username);
      return {
        username: watcher.username,
        addedAt: watcher.addedAt,
        lastCheckAt: watcher.lastCheckAt,
        lastLive: watcher.lastLive,
        status: active ? 'recording' : watcher.lastError ? 'error' : watcher.lastLive ? 'live' : 'waiting',
        error: watcher.lastError,
        recordingId: active?.id || null,
      };
    })
    .sort((a, b) => b.addedAt - a.addedAt);
}

function findWatcher(rawUsername) {
  const username = normalizeUsername(rawUsername);
  const key = username.toLowerCase();
  return watchers.find((watcher) => watcher.username.toLowerCase() === key) || null;
}

/**
 * Adds a username to the watch list and, if they happen to already be live,
 * starts recording right away.
 */
export async function addWatcher(rawUsername, { frame = 'auto' } = {}) {
  const username = normalizeUsername(rawUsername);
  const existing = findWatcher(username);
  if (existing) {
    return {
      watcher: listWatchers().find((w) => w.username.toLowerCase() === existing.username.toLowerCase()),
      existed: true,
      started: Boolean(getActiveForUsername(existing.username)),
    };
  }

  // Verify the account exists / find out whether it's live right now.
  const status = await checkLive(username, { profile: true, force: true });

  const watcher = {
    username: status.user.username || username,
    addedAt: Date.now(),
    lastLive: Boolean(status.live),
    lastCheckAt: Date.now(),
    lastError: null,
    frame: ['center', 'left', 'right'].includes(String(frame || '').toLowerCase())
      ? String(frame).toLowerCase()
      : 'auto',
  };

  watchers.push(watcher);

  let started = false;
  if (status.live && status.stream && !isRecording(watcher.username)) {
    try {
      await startRecording({
        username: watcher.username,
        user: status.user,
        room: status.room,
        stream: status.stream,
        source: 'watcher',
        frame: watcher.frame,
        dualLayout: status.dualLayout,
      });
      started = true;
    } catch (error) {
      watcher.lastError = error.message;
      log(`Auto-record on add failed for @${watcher.username}:`, error.message);
    }
  } else if (status.live && !status.stream) {
    watcher.lastLive = false;
    watcher.lastError = "Live, but TikTok isn't sharing a playable stream right now.";
  }

  persist();
  pushEvent(
    'watcher-added',
    started
      ? `@${watcher.username} is live — recording started.`
      : `Watching for @${watcher.username} to go live.`,
    { username: watcher.username },
  );

  return {
    watcher: listWatchers().find((w) => w.username.toLowerCase() === watcher.username.toLowerCase()),
    existed: false,
    started,
  };
}

export function removeWatcher(rawUsername) {
  const username = normalizeUsername(rawUsername);
  const key = username.toLowerCase();
  const existing = watchers.find((watcher) => watcher.username.toLowerCase() === key);
  if (!existing) {
    throw new AppError(404, 'That username is not on the watch list.');
  }
  watchers = watchers.filter((watcher) => watcher.username.toLowerCase() !== key);
  persist();
  pushEvent('watcher-removed', `Stopped watching @${existing.username}.`, {
    username: existing.username,
  });
  return { ok: true };
}

async function tick() {
  if (ticking || !watchers.length) return;
  ticking = true;

  let changed = false;
  try {
    for (const watcher of [...watchers]) {
      if (!watchers.includes(watcher)) continue;

      if (isRecording(watcher.username)) {
        if (!watcher.lastLive) {
          watcher.lastLive = true;
          changed = true;
        }
        watcher.lastCheckAt = Date.now();
        continue;
      }

      try {
        const status = await checkLive(watcher.username, { profile: false, force: true });
        const wasLive = watcher.lastLive;
        watcher.lastCheckAt = Date.now();
        watcher.lastError = null;

        if (!status.live) {
          if (wasLive) changed = true;
          watcher.lastLive = false;
          continue;
        }

        if (!status.stream) {
          watcher.lastLive = false;
          watcher.lastError = "Live, but TikTok isn't sharing a playable stream right now.";
          changed = true;
          continue;
        }

        watcher.lastLive = true;
        changed = true;

        if (!wasLive) {
          log(`Watcher: @${watcher.username} is live, starting recording.`);
          try {
            await startRecording({
              username: watcher.username,
              user: status.user,
              room: status.room,
              stream: status.stream,
              source: 'watcher',
              frame: watcher.frame || 'auto',
              dualLayout: status.dualLayout,
            });
          } catch (error) {
            watcher.lastError = error.message;
            log(`Watcher could not start @${watcher.username}:`, error.message);
          }
        }
      } catch (error) {
        watcher.lastCheckAt = Date.now();
        watcher.lastError = error.message;
        log(`Watcher check failed for @${watcher.username}:`, error.message);
        changed = true;
      }

      // Stagger requests so a big watch list doesn't burst TikTok.
      await sleep(600);
    }
  } finally {
    if (changed) persist();
    ticking = false;
  }
}

export function stopWatchers() {
  if (timer) clearInterval(timer);
  timer = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
