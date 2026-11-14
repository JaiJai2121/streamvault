import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { log } from './util.js';

const dbFile = path.join(CONFIG.dataDir, 'recordings.json');
const tmpFile = `${dbFile}.tmp`;

/** @type {Array<Record<string, any>>} */
let recordings = [];

export function initStore() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  fs.mkdirSync(CONFIG.recordingsDir, { recursive: true });

  if (!fs.existsSync(dbFile)) {
    writeDb();
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    recordings = Array.isArray(parsed) ? parsed : Array.isArray(parsed.recordings) ? parsed.recordings : [];
    recordings = recordings.filter((rec) => rec && typeof rec.id === 'string' && typeof rec.file === 'string');
    log(`Loaded ${recordings.length} recording${recordings.length === 1 ? '' : 's'} from the vault index.`);
  } catch (error) {
    const backup = `${dbFile}.broken-${Date.now()}`;
    try {
      fs.renameSync(dbFile, backup);
      log(`Vault index was unreadable; moved it to ${path.basename(backup)}.`, error.message);
    } catch {
      log('Vault index was unreadable.', error.message);
    }
    recordings = [];
    writeDb();
  }
}

function writeDb() {
  const payload = { version: 1, recordings };
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpFile, dbFile);
  } catch (error) {
    log('Could not save the vault index:', error.message);
  }
}

export function listRecordings() {
  return [...recordings].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function getRecording(id) {
  return recordings.find((rec) => rec.id === id) || null;
}

export function addRecording(recording) {
  recordings = recordings.filter((rec) => rec.id !== recording.id);
  recordings.push(recording);
  writeDb();
  return recording;
}

export function updateRecording(id, patch) {
  const index = recordings.findIndex((rec) => rec.id === id);
  if (index === -1) return null;
  recordings[index] = { ...recordings[index], ...patch };
  writeDb();
  return recordings[index];
}

export function removeRecording(id) {
  const existing = getRecording(id);
  if (!existing) return null;
  recordings = recordings.filter((rec) => rec.id !== id);
  writeDb();
  return existing;
}

export function totalStoredBytes() {
  return recordings.reduce((sum, rec) => sum + (Number(rec.sizeBytes) || 0), 0);
}

export function knownFileNames() {
  const names = new Set();
  for (const rec of recordings) {
    if (rec.file) names.add(rec.file);
    if (rec.thumb) names.add(rec.thumb);
  }
  return names;
}

export function mediaPath(fileName) {
  const safe = path.basename(String(fileName || ''));
  if (!/^[A-Za-z0-9._-]+$/.test(safe) || safe === '.' || safe === '..') {
    return null;
  }
  return path.join(CONFIG.recordingsDir, safe);
}
