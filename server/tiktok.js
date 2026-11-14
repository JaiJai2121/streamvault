import { TikTokLiveConnection } from 'tiktok-live-connector';
import { CONFIG } from './config.js';
import { AppError, log, normalizeUsername, withTimeout } from './util.js';

const statusCache = new Map();
const CACHE_MS = 10_000;

function newConnection(username) {
  return new TikTokLiveConnection(username, {
    signApiKey: CONFIG.signApiKey,
    fetchRoomInfoOnConnect: false,
  });
}

function pickImage(...candidates) {
  for (const candidate of candidates) {
    const url = candidate?.url_list?.find((item) => typeof item === 'string' && /^https?:\/\//.test(item));
    if (url) return url;
  }
  return null;
}

function humanizeQualityKey(key) {
  const map = {
    FULL_HD1: '1080p',
    HD1: '720p',
    SD1: '360p',
    SD2: '540p',
    ORIGION: 'Original',
    ORIGIN: 'Original',
    AUTO: 'Auto',
    pm_mt_video_1080p60: '1080p60',
    pm_mt_video_720p60: '720p60',
    ttlive_videoQuality_option_2k: '2K',
  };
  return map[key] || key;
}

function qualityScore(key, label) {
  const k = String(key).toUpperCase();
  const l = String(label).toLowerCase();
  if (l.includes('1080p60')) return 121;
  if (l.includes('1080') || k.includes('FULL_HD')) return 120;
  if (l.includes('4k') || l.includes('2k') || k.includes('4K') || k.includes('2K')) return 119;
  if (k.includes('ORIGION') || k.includes('ORIGIN')) return 110;
  if (l.includes('720p60')) return 82;
  if (l.includes('720') || k.includes('HD1')) return 80;
  if (l.includes('540') || k.includes('SD2')) return 50;
  if (l.includes('360') || k.includes('SD1')) return 30;
  if (k.includes('AUTO')) return 10;
  return 60;
}

function asUrlMap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

/**
 * Best-effort check for TikTok's split/dual live layout (two portrait feeds in
 * one room). The room payload exposes link-mic state for co-hosted streams; not
 * every dual room sets every flag, so look at the common ones.
 */
export function isDualLayout(room) {
  if (!room) return false;
  const link = room.link_mic || {};
  const linkedUsers = Array.isArray(link.linked_user_list) ? link.linked_user_list.length : 0;
  return Boolean(
    room.live_type_linkmic === true ||
      room.with_linkmic === true ||
      linkedUsers > 1 ||
      Number(link.channel_id) > 0 ||
      Number(link.linker_mode) > 0 ||
      Number(link.multi_live_enum) > 0,
  );
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * Turns TikTok's many quality flavours into one ordered list, best first.
 * FLV is preferred over HLS when both carry the same quality because it is
 * more forgiving during long, continuous captures.
 */
export function getStreamOptions(room) {
  const streamUrl = room?.stream_url;
  if (!streamUrl) return [];

  const flv = asUrlMap(streamUrl.flv_pull_url);
  const hls = asUrlMap(streamUrl.hls_pull_url_map);
  const labels = asUrlMap(streamUrl.resolution_name);
  const options = [];
  const seen = new Set();

  for (const key of new Set([...Object.keys(flv), ...Object.keys(hls)])) {
    const url = isHttpUrl(flv[key]) ? flv[key] : isHttpUrl(hls[key]) ? hls[key] : null;
    if (!url) continue;
    const protocol = isHttpUrl(flv[key]) ? 'flv' : 'hls';
    const label = labels[key] || humanizeQualityKey(key);
    const signature = `${label}|${protocol}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    options.push({
      key,
      label,
      protocol,
      url,
      score: qualityScore(key, label),
    });
  }

  // Some rooms only expose default pull URLs rather than quality maps.
  if (!options.length) {
    if (isHttpUrl(streamUrl.flv_pull_url)) {
      const label = labels[streamUrl.default_resolution] || 'Best available';
      options.push({ key: 'default', label, protocol: 'flv', url: streamUrl.flv_pull_url, score: 70 });
    } else if (isHttpUrl(streamUrl.hls_pull_url)) {
      const label = labels[streamUrl.default_resolution] || 'Best available';
      options.push({ key: 'default', label, protocol: 'hls', url: streamUrl.hls_pull_url, score: 70 });
    }
  }

  return options.sort((a, b) => b.score - a.score || (a.protocol === 'flv' ? -1 : 1));
}

function buildStatus(username, isLive, room) {
  const owner = room?.owner || {};
  const user = {
    username: owner.display_id || username,
    nickname: owner.nickname || owner.display_id || username,
    avatar:
      pickImage(owner.avatar_thumb, owner.avatar_medium, owner.avatar_large) || null,
    followers: Number.isFinite(owner.follow_info?.follower_count)
      ? owner.follow_info.follower_count
      : null,
  };

  const streamOptions = isLive ? getStreamOptions(room) : [];
  const bestStream = streamOptions[0] || null;

  const roomInfo = isLive
    ? {
        title: (room?.title || '').trim() || 'Untitled live stream',
        viewers: Number(room?.user_count) || 0,
        startedAt: room?.create_time ? Number(room.create_time) * 1000 : null,
        cover: pickImage(room?.cover, owner?.avatar_thumb) || user.avatar,
      }
    : null;

  return {
    username,
    live: Boolean(isLive),
    checkedAt: Date.now(),
    dualLayout: isLive ? isDualLayout(room) : false,
    user,
    room: roomInfo,
    stream: bestStream
      ? {
          key: bestStream.key,
          label: bestStream.label,
          protocol: bestStream.protocol,
          score: bestStream.score,
          url: bestStream.url,
        }
      : null,
    qualities: streamOptions.map(({ key, label, protocol }) => ({ key, label, protocol })),
    noStream: Boolean(isLive && !bestStream),
  };
}

/**
 * Checks TikTok for the live status of a username. Fetches public room data
 * for identity/cover details. Uses a short cache so double-clicks don't hammer
 * TikTok.
 */
export async function checkLive(rawUsername, { force = false, profile = true } = {}) {
  const username = normalizeUsername(rawUsername);
  const cacheKey = username.toLowerCase();
  const cached = statusCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return structuredClone(cached.value);
  }

  const connection = newConnection(username);
  let isLive;
  try {
    isLive = await withTimeout(
      connection.fetchIsLive(username),
      25_000,
      "TikTok didn't answer the live check in time. Try again.",
    );
  } catch (error) {
    log(`Live check failed for @${username}:`, error.name || '', error.message || error);
    throw toFriendlyError(error);
  }

  let room = null;
  let roomWarning = null;
  if (isLive || profile) {
    try {
      const response = await withTimeout(
        connection.fetchRoomInfo(),
        25_000,
        "TikTok didn't return the room details in time.",
      );
      room = response?.data?.data || response?.data || response || null;
    } catch (error) {
      roomWarning = 'Room details were unavailable.';
      log(`Room info failed for @${username}:`, error.name || '', error.message || error);
      if (isLive) {
        // Live was confirmed; let the caller surface a helpful "no stream" state.
        room = null;
      }
    }
  }

  const status = buildStatus(username, isLive, room);
  status.warning = roomWarning;

  statusCache.set(cacheKey, { at: Date.now(), value: status });
  if (statusCache.size > 200) {
    const oldest = [...statusCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) statusCache.delete(oldest[0]);
  }

  return structuredClone(status);
}

function toFriendlyError(error) {
  if (error instanceof AppError) return error;
  const name = error?.name || '';
  const message = String(error?.message || '');

  if (name === 'InvalidUniqueIdError' || /not found|invalid unique/i.test(message)) {
    return new AppError(404, 'That TikTok account could not be found. Check the spelling and try again.');
  }
  if (/rate.?limit/i.test(`${name} ${message}`)) {
    return new AppError(429, 'TikTok is rate-limiting checks right now. Give it a minute and try again.');
  }
  if (/sign|signature/i.test(`${name} ${message}`)) {
    return new AppError(
      502,
      'TikTok rejected the request signature. This is usually temporary — try again in a moment.',
    );
  }
  return new AppError(502, "Couldn't check that account. TikTok may be busy or blocking requests — try again shortly.");
}

export function clearStatusCache() {
  statusCache.clear();
}
