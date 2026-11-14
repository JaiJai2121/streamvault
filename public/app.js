const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  form: $('#recordForm'),
  username: $('#username'),
  recordBtn: $('#recordBtn'),
  recordInputWrap: $('#recordInputWrap'),
  formNote: $('#formNote'),
  result: $('#result'),
  activeSection: $('#activeSection'),
  activeGrid: $('#activeGrid'),
  activeCount: $('#activeCount'),
  activeSub: $('#activeSub'),
  watchSection: $('#watchSection'),
  watchList: $('#watchList'),
  watchCount: $('#watchCount'),
  libraryGrid: $('#libraryGrid'),
  libraryEmpty: $('#libraryEmpty'),
  libraryMeta: $('#libraryMeta'),
  search: $('#search'),
  sortSelect: $('#sortSelect'),
  storageUsed: $('#storageUsed'),
  enginePill: $('#enginePill'),
  engineLabel: $('#engineLabel'),
  frameSelect: $('#frameSelect'),
  hero: $('#hero'),
  dockShell: $('#searchDock'),
  modalRoot: $('#modalRoot'),
  toastStack: $('#toastStack'),
};

const DEFAULT_FORM_NOTE =
  "We'll check live status and start a 9:16 portrait recording if they're on air.";
const SORT_LABELS = new Set(['newest', 'oldest', 'largest', 'longest']);
const FRAMES = new Set(['auto', 'center', 'left', 'right']);
const FRAME_KEY = 'burst.frame';

function readStoredFrame() {
  try {
    const value = localStorage.getItem(FRAME_KEY);
    return FRAMES.has(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

const state = {
  loaded: false,
  recordings: [],
  active: [],
  watchers: [],
  storage: { usedBytes: 0, count: 0, freeBytes: null },
  settings: { maxConcurrent: 3, watchIntervalSec: 60 },
  events: [],
  lastEventId: null,
  search: '',
  sort: 'newest',
  frame: readStoredFrame(),
  lastUsername: '',
  busy: false,
  serverDown: false,
  engineDownToastShown: false,
};

let pollTimer = null;
let pollInFlight = false;
let lastActiveSignature = '';
let currentModal = null;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const compactNumber = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/* ---------- Helpers ---------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function icon(name, className = '') {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${Math.max(0, Math.round(value))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let index = -1;
  do {
    scaled /= 1024;
    index += 1;
  } while (scaled >= 1024 && index < units.length - 1);
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
  return `${scaled.toFixed(decimals)} ${units[index]}`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(rest)}`;
  return `${minutes}:${pad(rest)}`;
}

function formatDate(ms) {
  if (!ms) return 'Unknown date';
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return `${dateFormatter.format(date)} · ${timeFormatter.format(date)}`;
}

function videoQualityLabel(recording) {
  const width = Number(recording?.width) || 0;
  const height = Number(recording?.height) || 0;
  if (width > 0 && height > 0) return `${Math.min(width, height)}p`;
  if (recording?.quality && recording.quality !== 'Unknown') return recording.quality;
  return 'Video';
}

function timeAgo(ms) {
  if (!ms) return 'just added';
  const seconds = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (seconds < 15) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function initials(name) {
  return (
    String(name || '?')
      .replace(/^@+/, '')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}

function avatarHtml({ avatar, name, size = '' }, extraClass = '') {
  const src = avatar ? escapeHtml(avatar) : '';
  return `<span class="avatar ${size} ${extraClass}">
    <span>${escapeHtml(initials(name))}</span>
    ${src ? `<img class="avatar-img" src="${src}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
  </span>`;
}

function hueClass(name) {
  let hash = 0;
  for (const char of String(name || '')) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `ph-${hash % 6}`;
}

function wireImageFallbacks(root = document) {
  for (const img of $$('img', root)) {
    if (img.dataset.fallbackWired) continue;
    img.dataset.fallbackWired = '1';
    img.addEventListener('error', () => img.classList.add('is-broken'));
    if (img.complete && img.naturalWidth === 0) img.classList.add('is-broken');
  }
}

function cleanUsername(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  const fromUrl = value.match(/tiktok\.com\/@([^/?#\s]+)/i);
  if (fromUrl) value = fromUrl[1];
  return value.replace(/^@+/, '').trim();
}

function isValidUsername(value) {
  return /^[A-Za-z0-9._]{1,24}$/.test(value);
}

function findRecording(id) {
  return state.recordings.find((recording) => recording.id === id) || null;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* non-JSON error page */
  }

  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

/* ---------- Toasts ---------- */

function toast(message, type = 'info') {
  const element = document.createElement('div');
  element.className = `toast toast--${type}`;
  element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const iconName = type === 'success' ? 'check' : type === 'error' ? 'alert' : 'bell';
  element.innerHTML = `<span class="toast-icon">${icon(iconName)}</span><div>${escapeHtml(message)}</div>`;
  els.toastStack.append(element);

  while (els.toastStack.children.length > 4) {
    els.toastStack.firstElementChild?.remove();
  }

  setTimeout(() => {
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 240);
  }, 4800);
}

/* ---------- Modals ---------- */

function closeModal() {
  if (currentModal) {
    currentModal.close();
    currentModal = null;
  }
  els.modalRoot.replaceChildren();
  document.body.classList.remove('modal-open');
}

function openModal(html, { onMount, onClose } = {}) {
  closeModal();

  const wrapper = document.createElement('div');
  wrapper.className = 'modal';
  wrapper.setAttribute('role', 'presentation');
  wrapper.innerHTML = html;
  els.modalRoot.append(wrapper);
  document.body.classList.add('modal-open');

  const previousFocus = document.activeElement;
  let closed = false;

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    try {
      onClose?.();
    } catch {
      /* ignore cleanup errors */
    }
    wrapper.remove();
    document.body.classList.remove('modal-open');
    if (currentModal?.close === close) currentModal = null;
    try {
      previousFocus?.focus?.();
    } catch {
      /* focus target may be gone */
    }
  }

  document.addEventListener('keydown', onKey);
  wrapper.addEventListener('mousedown', (event) => {
    if (event.target === wrapper) close();
  });
  $$('[data-close]', wrapper).forEach((button) => button.addEventListener('click', close));

  currentModal = { close };
  onMount?.(wrapper, close);

  requestAnimationFrame(() => {
    const target =
      wrapper.querySelector('[data-autofocus]') ||
      wrapper.querySelector('.code-input') ||
      wrapper.querySelector('[data-close]');
    target?.focus?.();
  });

  return { root: wrapper, close };
}

function openPlayer(recording) {
  const title = recording.title || 'TikTok live stream';
  const quality = videoQualityLabel(recording);
  const resolution = recording.width && recording.height ? `${recording.width}×${recording.height}` : quality;

  let videoElement = null;

  const html = `
    <div class="dialog player-dialog" role="dialog" aria-modal="true" aria-labelledby="playerTitle">
      <button class="modal-close player-close" type="button" data-close data-autofocus aria-label="Close player">
        ${icon('x')}
      </button>
      <div class="player-shell">
        <video
          class="player-video"
          controls
          autoplay
          playsinline
          preload="metadata"
          ${recording.thumbUrl ? `poster="${escapeHtml(recording.thumbUrl)}"` : ''}
          src="${escapeHtml(recording.fileUrl)}"
        ></video>
      </div>
      <div class="player-info">
        <div class="player-info-head">
          <div>
            <h2 class="player-title" id="playerTitle">${escapeHtml(title)}</h2>
            <div class="player-by">
              ${avatarHtml({ avatar: recording.avatar, name: recording.username }, 'avatar-sm')}
              <span>@${escapeHtml(recording.username)}</span>
              ${
                recording.nickname && recording.nickname !== recording.username
                  ? `<span>·</span><span>${escapeHtml(recording.nickname)}</span>`
                  : ''
              }
            </div>
            <div class="player-meta">
              <span>${escapeHtml(formatDate(recording.startedAt))}</span>
              <span>${escapeHtml(formatDuration(recording.durationSec))}</span>
              <span>${escapeHtml(resolution)}</span>
              <span>${escapeHtml(formatBytes(recording.sizeBytes))}</span>
            </div>
            ${
              recording.warning
                ? `<div class="recording-warning" style="margin-top:9px">${icon('alert')}<span>${escapeHtml(recording.warning)}</span></div>`
                : ''
            }
          </div>
          <div class="player-actions">
            <a class="btn btn-ghost" href="${escapeHtml(recording.downloadUrl)}" download>
              ${icon('download')} Download
            </a>
          </div>
        </div>
      </div>
    </div>`;

  openModal(html, {
    onMount(root) {
      videoElement = $('video', root);
      if (!videoElement) return;
      videoElement.addEventListener(
        'error',
        () => {
          toast('This video could not be played in the browser. Try downloading it instead.', 'error');
        },
        { once: true },
      );
      videoElement.play().catch(() => {
        /* autoplay blocked — controls are available */
      });
    },
    onClose() {
      if (!videoElement) return;
      try {
        videoElement.pause();
        videoElement.removeAttribute('src');
        videoElement.load();
      } catch {
        /* player already gone */
      }
    },
  });
}

function openDelete(recording) {
  const html = `
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="deleteTitle">
      <div class="modal-head">
        <div>
          <h2 id="deleteTitle">Delete recording?</h2>
          <p>Permanent action</p>
        </div>
        <button class="modal-close" type="button" data-close aria-label="Close delete dialog">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="danger-badge">${icon('trash')}</div>
        <div class="delete-target">
          ${avatarHtml({ avatar: recording.avatar, name: recording.username }, 'avatar-sm')}
          <div class="delete-target-text">
            <strong>@${escapeHtml(recording.username)} · ${escapeHtml(recording.title || 'Live stream')}</strong>
            <span>${escapeHtml(formatDate(recording.startedAt))} · ${escapeHtml(formatBytes(recording.sizeBytes))}</span>
          </div>
        </div>
        <p class="danger-copy">This permanently removes the video file from the shared server. <strong>This can't be undone.</strong></p>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-close>Cancel</button>
          <button class="btn btn-danger" id="deleteSubmit" type="button">${icon('trash')} Delete forever</button>
        </div>
      </div>
    </div>`;

  openModal(html, {
    onMount(root, close) {
      const submit = $('#deleteSubmit', root);
      submit.addEventListener('click', async () => {
        submit.disabled = true;
        const originalLabel = submit.innerHTML;
        submit.innerHTML = `<span class="spinner" style="border-color:rgba(255,179,192,.3);border-top-color:#ffb3c0"></span> Deleting…`;
        try {
          await api(`/api/recordings/${encodeURIComponent(recording.id)}`, { method: 'DELETE' });
          close();
          state.recordings = state.recordings.filter((item) => item.id !== recording.id);
          renderLibrary();
          renderHeader();
          toast('Recording deleted from the vault.', 'success');
          void loadState();
        } catch (error) {
          submit.disabled = false;
          submit.innerHTML = originalLabel;
          toast(error.message || 'Could not delete that recording.', 'error');
        }
      });
    },
  });
}

/* ---------- Header / engine ---------- */

function renderHeader() {
  const used = Number(state.storage?.usedBytes) || 0;
  const count = Number(state.storage?.count) || 0;
  els.storageUsed.textContent = formatBytes(used);
  const storagePill = els.storageUsed.closest('.storage-pill');
  if (storagePill) {
    const free = state.storage?.freeBytes;
    storagePill.title =
      `${count} recording${count === 1 ? '' : 's'} · ${formatBytes(used)} used` +
      (free ? ` · ${formatBytes(free)} free on disk` : '');
  }
}

function renderEngine(engine) {
  els.enginePill.classList.remove('is-ready', 'is-down');
  if (!engine) {
    els.enginePill.classList.add('is-down');
    els.engineLabel.textContent = 'Server offline';
    return;
  }
  if (engine.ready) {
    els.enginePill.classList.add('is-ready');
    els.engineLabel.textContent = 'Engine ready';
    els.enginePill.title = `ffmpeg ${engine.version || ''} — ready to record`.trim();
  } else {
    els.enginePill.classList.add('is-down');
    els.engineLabel.textContent = 'Engine offline';
    els.enginePill.title = engine.error || 'The recording engine is unavailable.';
    if (!state.engineDownToastShown) {
      state.engineDownToastShown = true;
      toast('The recording engine is unavailable. Run "npm install" in the Burst Recording Service folder.', 'error');
    }
  }
}

/* ---------- Active recordings ---------- */

function activeCardHtml(active) {
  const saving = active.status === 'saving' || active.status === 'stopping';
  const statusLabel =
    active.status === 'starting'
      ? 'CONNECTING'
      : active.status === 'stopping'
        ? 'STOPPING'
        : active.status === 'saving'
          ? 'SAVING'
          : 'REC';
  const tagClass = saving ? 'is-saving' : '';
  const quality = videoQualityLabel(active);
  const frameLabel =
    active.frame === 'left' ? 'Left' : active.frame === 'right' ? 'Right' : 'Centre';
  const qualityTag = `${quality} · 9:16${active.frame && active.frame !== 'center' ? ` · ${frameLabel}` : ''}`;

  return `
    <article class="active-card" data-active-id="${escapeHtml(active.id)}">
      <div class="active-cover">
        <span class="thumb-placeholder ${hueClass(active.username)}"></span>
        ${
          active.cover || active.avatar
            ? `<img class="cover-img" src="${escapeHtml(active.cover || active.avatar)}" alt="" referrerpolicy="no-referrer" />`
            : ''
        }
      </div>
      <div class="active-overlay"></div>
      <div class="active-top">
        <span class="rec-tag ${tagClass}"><span class="rec-dot"></span>${statusLabel}</span>
        <span class="active-quality">${escapeHtml(qualityTag)}</span>
      </div>
      <div class="active-body">
        <div class="active-user">
          ${avatarHtml({ avatar: active.avatar, name: active.username })}
          <div class="active-user-text">
            <div class="active-name">${escapeHtml(active.nickname || active.username)}</div>
            <div class="active-handle">@${escapeHtml(active.username)}</div>
          </div>
        </div>
        <p class="active-title">${escapeHtml(active.title || 'Live stream')}</p>
        <div class="active-bottom">
          <div>
            <div
              class="active-timer"
              data-started="${Number(active.startedAt) || 0}"
              data-duration="${Number(active.durationSec) || 0}"
              data-status="${escapeHtml(active.status)}"
            >${formatDuration(active.durationSec)}</div>
            <div class="active-meta">
              <span><strong class="active-size" data-size-for="${escapeHtml(active.id)}">${formatBytes(active.sizeBytes)}</strong> captured</span>
              <span>${active.source === 'watcher' ? 'Auto-recorded' : 'Manual'}</span>
            </div>
            ${
              saving
                ? `<div class="save-note"><span class="spinner"></span>Finishing file — don't close the app yet</div>`
                : ''
            }
          </div>
          <button
            class="btn btn-stop"
            type="button"
            data-stop="${escapeHtml(active.id)}"
            ${saving ? 'disabled' : ''}
          >
            ${icon('stop')} ${saving ? 'Saving…' : 'Stop'}
          </button>
        </div>
      </div>
    </article>`;
}

function renderActive() {
  const active = state.active || [];
  els.activeSection.hidden = active.length === 0;
  document.title = active.length
    ? `● Recording ${active.length} live${active.length === 1 ? '' : 's'} — Burst Recording Service`
    : 'Burst Recording Service — TikTok Live Recorder';

  if (!active.length) {
    els.activeGrid.innerHTML = '';
    lastActiveSignature = '';
    return;
  }

  els.activeCount.textContent = String(active.length);
  const max = Number(state.settings?.maxConcurrent) || 3;
  els.activeSub.textContent =
    active.length >= max
      ? `All ${max} recording slots are busy · files save automatically`
      : `${active.length} of ${max} recording slots in use · files save automatically`;

  const signature = active.map((item) => `${item.id}:${item.status}`).join('|');
  if (signature !== lastActiveSignature) {
    lastActiveSignature = signature;
    els.activeGrid.innerHTML = active.map(activeCardHtml).join('');
    wireImageFallbacks(els.activeGrid);

    $$('[data-stop]', els.activeGrid).forEach((button) => {
      button.addEventListener('click', () => stopActive(button.dataset.stop, button));
    });
  }

  updateActiveMeta();
  updateClocks();
}

function updateActiveMeta() {
  for (const active of state.active || []) {
    const el = els.activeGrid.querySelector(`[data-size-for="${CSS.escape(active.id)}"]`);
    if (el) el.textContent = formatBytes(active.sizeBytes);
  }
}

function updateClocks() {
  const now = Date.now();
  for (const timer of $$('.active-timer')) {
    const startedAt = Number(timer.dataset.started) || now;
    const recorded = Number(timer.dataset.duration) || 0;
    const status = timer.dataset.status;
    const wall = Math.max(0, Math.floor((now - startedAt) / 1000));
    const seconds =
      status === 'saving' || status === 'stopping' ? Math.max(recorded, wall) : wall;
    timer.textContent = formatDuration(seconds);
  }
}

async function stopActive(id, button) {
  if (!id) return;
  button.disabled = true;
  const original = button.innerHTML;
  button.innerHTML = `<span class="spinner" style="border-color:rgba(255,255,255,.25);border-top-color:#fff"></span> Stopping…`;

  try {
    await api(`/api/recordings/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    toast('Stopping the capture — the file is being saved.', 'info');
    setTimeout(() => void loadState(), 700);
    setTimeout(() => void loadState(), 2500);
  } catch (error) {
    button.disabled = false;
    button.innerHTML = original;
    toast(error.message, 'error');
  }
}

/* ---------- Watchers ---------- */

function watcherStatus(watcher) {
  if (watcher.status === 'recording') return 'Recording now';
  if (watcher.status === 'error') return watcher.error || 'Check failed';
  if (watcher.status === 'live') return 'Live — checking for stream';
  return watcher.lastCheckAt ? `Waiting · checked ${timeAgo(watcher.lastCheckAt)}` : 'Waiting for next stream';
}

function renderWatchers() {
  const watchers = state.watchers || [];
  els.watchSection.hidden = watchers.length === 0;
  els.watchCount.textContent = String(watchers.length);

  if (!watchers.length) {
    els.watchList.innerHTML = '';
    return;
  }

  els.watchList.innerHTML = watchers
    .map(
      (watcher) => `
        <div class="watch-chip status-${escapeHtml(watcher.status)}" data-watch-user="${escapeHtml(watcher.username)}">
          ${avatarHtml({ name: watcher.username })}
          <div class="watch-info">
            <span class="watch-name">@${escapeHtml(watcher.username)}</span>
            <span class="watch-status" title="${escapeHtml(watcherStatus(watcher))}">${escapeHtml(watcherStatus(watcher))}</span>
          </div>
          <button
            class="watch-remove"
            type="button"
            data-unwatch="${escapeHtml(watcher.username)}"
            aria-label="Stop watching @${escapeHtml(watcher.username)}"
            title="Stop watching"
          >${icon('x')}</button>
        </div>`,
    )
    .join('');

  $$('[data-unwatch]', els.watchList).forEach((button) => {
    button.addEventListener('click', () => removeWatcher(button.dataset.unwatch, button));
  });
}

async function removeWatcher(username, button) {
  button.disabled = true;
  try {
    await api(`/api/watchers/${encodeURIComponent(username)}`, { method: 'DELETE' });
    toast(`Stopped watching @${username}.`, 'info');
    await loadState();
  } catch (error) {
    button.disabled = false;
    toast(error.message, 'error');
  }
}

/* ---------- Library ---------- */

function recordingCardHtml(recording, index = 0) {
  const quality = videoQualityLabel(recording);
  const resolution =
    recording.width && recording.height ? `${recording.width}×${recording.height}` : recording.height ? `${recording.height}p` : null;
  const title = recording.title || 'TikTok live stream';
  const avatar = avatarHtml({ avatar: recording.avatar, name: recording.username }, 'avatar-sm');

  return `
    <article class="recording-card" data-recording-id="${escapeHtml(recording.id)}" style="--i:${index}">
      <button
        class="recording-thumb"
        type="button"
        data-play="${escapeHtml(recording.id)}"
        aria-label="Play recording from @${escapeHtml(recording.username)}"
      >
        <span class="thumb-placeholder ${hueClass(recording.username)}"></span>
        ${
          recording.thumbUrl
            ? `<img class="thumb-img" src="${escapeHtml(recording.thumbUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
            : ''
        }
        <span class="thumb-shade"></span>
        <span class="play-orb">${icon('play')}</span>
        <span class="card-quality">${escapeHtml(quality)}</span>
        <span class="duration-tag">${escapeHtml(formatDuration(recording.durationSec))}</span>
      </button>
      <div class="recording-body">
        <div class="recording-by">
          ${avatar}
          <span>@${escapeHtml(recording.username)}</span>
        </div>
        <h3 class="recording-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
        ${
          recording.warning
            ? `<div class="recording-warning" title="${escapeHtml(recording.warning)}">${icon('alert')}<span>${escapeHtml(recording.warning)}</span></div>`
            : ''
        }
        <div class="recording-meta">
          <span class="meta-item">${icon('clock')}${escapeHtml(formatDate(recording.startedAt))}</span>
          <span class="meta-item">${icon('database')}${escapeHtml(formatBytes(recording.sizeBytes))}</span>
          ${resolution ? `<span class="meta-item">${escapeHtml(resolution)}</span>` : ''}
        </div>
        <div class="recording-actions">
          <a
            class="btn btn-ghost card-action"
            href="${escapeHtml(recording.downloadUrl)}"
            download
            title="Download this recording"
          >${icon('download')} Save</a>
          <button
            class="icon-btn"
            type="button"
            data-play="${escapeHtml(recording.id)}"
            title="Play recording"
            aria-label="Play recording from @${escapeHtml(recording.username)}"
          >${icon('play')}</button>
          <span class="action-spacer"></span>
          <button
            class="icon-btn icon-btn--danger"
            type="button"
            data-delete="${escapeHtml(recording.id)}"
            title="Delete recording"
            aria-label="Delete recording from @${escapeHtml(recording.username)}"
          >${icon('trash')}</button>
        </div>
      </div>
    </article>`;
}

function emptyStateMarkup(searchTerm) {
  const art = `
    <div class="empty-art" aria-hidden="true">
      <span class="empty-ring"></span>
      ${icon('vault')}
    </div>`;

  if (searchTerm) {
    return `${art}
      <h3>No matches</h3>
      <p>Nothing in the vault matches “${escapeHtml(searchTerm)}”. Try a different search or creator.</p>`;
  }

  return `${art}
    <h3>Your storage is empty</h3>
    <p>Search a TikTok username above. If they're live, the portrait recording lands here.</p>`;
}

function filteredRecordings() {
  const query = state.search.trim().toLowerCase();
  let list = [...(state.recordings || [])];

  if (query) {
    list = list.filter((recording) =>
      [recording.username, recording.nickname, recording.title]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }

  switch (state.sort) {
    case 'oldest':
      list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      break;
    case 'largest':
      list.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
      break;
    case 'longest':
      list.sort((a, b) => (b.durationSec || 0) - (a.durationSec || 0));
      break;
    default:
      list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  return list;
}

function renderLibrary() {
  const all = state.recordings || [];
  const list = filteredRecordings();
  const totalBytes = Number(state.storage?.usedBytes) || 0;
  const query = state.search.trim();

  if (query) {
    els.libraryMeta.textContent = `${list.length} of ${all.length} recording${all.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)} stored`;
  } else {
    els.libraryMeta.textContent = `${all.length} recording${all.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)} stored`;
  }

  els.libraryGrid.innerHTML = list.map((recording, index) => recordingCardHtml(recording, index)).join('');
  wireImageFallbacks(els.libraryGrid);

  $$('[data-play]', els.libraryGrid).forEach((button) => {
    button.addEventListener('click', () => {
      const recording = findRecording(button.dataset.play);
      if (recording) openPlayer(recording);
    });
  });

  $$('[data-delete]', els.libraryGrid).forEach((button) => {
    button.addEventListener('click', () => {
      const recording = findRecording(button.dataset.delete);
      if (recording) openDelete(recording);
    });
  });

  els.libraryEmpty.hidden = list.length > 0;
  if (!list.length) {
    els.libraryEmpty.innerHTML = emptyStateMarkup(query);
  }
}

/* ---------- Lookup / record flow ---------- */

function setFormNote(message, isError = false) {
  els.formNote.textContent = message || DEFAULT_FORM_NOTE;
  els.formNote.classList.toggle('is-error', Boolean(isError));
}

function setBusy(busy) {
  state.busy = busy;
  els.recordBtn.disabled = busy;
  els.username.disabled = busy;
  els.recordBtn.querySelector('.btn-label').textContent = busy ? 'Checking…' : 'Check & record';
  els.recordBtn.querySelector('.spinner').hidden = !busy;
  els.form.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return compactNumber.format(number);
}

function lookupUserHtml(user, badges, { dim = false } = {}) {
  const username = user?.username || state.lastUsername || 'unknown';
  const nickname = user?.nickname || username;
  return `<div class="lookup-user">
    ${avatarHtml({ avatar: user?.avatar, name: nickname }, `avatar-lg ${dim ? 'is-dim' : ''}`)}
    <div class="lookup-id">
      <div class="lookup-name-row"><strong>${escapeHtml(nickname)}</strong></div>
      <span class="lookup-handle">@${escapeHtml(username)}</span>
    </div>
    ${badges ? `<div class="lookup-badges">${badges}</div>` : ''}
  </div>`;
}

function renderLoadingResult(username) {
  els.result.innerHTML = `
    <div class="result-loading" role="status">
      <div class="skeleton skeleton-avatar"></div>
      <div class="skeleton-lines">
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line"></div>
        <span class="sr-only">Checking @${escapeHtml(username)} and starting a recording if live…</span>
      </div>
    </div>`;
}

function wireResultActions() {
  $$('[data-watch]', els.result).forEach((button) => {
    button.addEventListener('click', () => watchUsername(button.dataset.watch, button));
  });
  $$('[data-retry]', els.result).forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.lastUsername) return;
      els.username.value = state.lastUsername;
      els.form.requestSubmit();
    });
  });
}

function renderLiveResult(data) {
  const user = data.user || { username: state.lastUsername, nickname: state.lastUsername };
  const room = data.room || {};
  const sourceQuality = data.stream?.label || data.recording?.quality || 'Best available';
  const outputHeight = data.recording?.height || 1920;
  const outputWidth = data.recording?.width || 1080;
  const outputQuality = `${Math.min(outputWidth, outputHeight)}p`;
  const viewers = formatCount(room.viewers);
  const isHd = outputHeight >= 1080;
  const isDual = Boolean(data.dualLayout);
  const frame = data.recording?.frame || (isDual && state.frame === 'auto' ? 'left' : state.frame);
  const frameNote =
    frame === 'left'
      ? 'Capturing the left portrait view.'
      : frame === 'right'
        ? 'Capturing the right portrait view.'
        : 'Capturing a centred portrait view.';
  const note =
    data.alreadyRecording
      ? 'This stream was already being captured.'
      : `TikTok source: ${sourceQuality} · saved as ${outputWidth}×${outputHeight} portrait.`;
  const dualNote = isDual ? ` Dual layout detected — ${frameNote.toLowerCase()}` : '';

  els.result.innerHTML = `
    <div class="lookup lookup-live">
      ${lookupUserHtml(
        user,
        `<span class="quality-pill is-hd">${escapeHtml(outputQuality)} output</span>${
          viewers ? `<span class="viewers-tag">${escapeHtml(viewers)} watching</span>` : ''
        }<span class="quality-pill">9:16</span>`,
      )}
      <div class="lookup-name-row" style="margin-top:12px">
        <span class="live-tag">Live</span>
        <span class="lookup-title" style="margin-top:0">${escapeHtml(room.title || 'Recording the live stream')}</span>
      </div>
      <div class="lookup-status">
        <span class="status-icon">${icon('check')}</span>
        <span>${data.alreadyRecording ? 'Already recording this stream.' : 'Recording started — saving to your storage.'}</span>
      </div>
      <div class="lookup-actions">
        <a class="btn btn-ghost" href="#activeSection">${icon('aperture')} View live capture</a>
        <span class="lookup-hint">${escapeHtml(note)}${escapeHtml(dualNote)}</span>
      </div>
    </div>`;
}

function renderOfflineResult(data) {
  const user = data.user || { username: state.lastUsername, nickname: state.lastUsername };
  const username = user.username || state.lastUsername;
  const watched = Boolean(data.watched);

  els.result.innerHTML = `
    <div class="lookup lookup-offline">
      ${lookupUserHtml(user, '', { dim: true })}
      <p class="lookup-title" style="margin-top:13px">Not live right now — and that's okay.</p>
      <p class="lookup-desc">
        @${escapeHtml(username)} isn't broadcasting at the moment, so there's nothing to record.
        ${watched ? "We're already watching for their next stream." : 'Want Burst Recording Service to catch the next one?'}
      </p>
      <div class="lookup-actions">
        ${
          watched
            ? `<div class="lookup-status" style="margin:0;padding:0;border:0"><span class="status-icon">${icon('eye')}</span><span>Watching for the next stream.</span></div>`
            : `<button class="btn btn-ghost" type="button" data-watch="${escapeHtml(username)}">${icon('bell')} Watch for next stream</button>
               <span class="lookup-hint">Checks every ${Number(state.settings?.watchIntervalSec) || 60}s while the app is open.</span>`
        }
      </div>
    </div>`;
  wireResultActions();
}

function renderNoStreamResult(data) {
  const user = data.user || { username: state.lastUsername, nickname: state.lastUsername };
  const watched = (state.watchers || []).some(
    (watcher) => watcher.username.toLowerCase() === String(user.username).toLowerCase(),
  );

  els.result.innerHTML = `
    <div class="lookup lookup-live">
      ${lookupUserHtml(user, '<span class="live-tag">Live</span>')}
      <p class="lookup-title" style="margin-top:13px">${escapeHtml(data.message || "They're live, but TikTok isn't sharing a playable stream right now.")}</p>
      <div class="lookup-actions">
        ${
          watched
            ? `<div class="lookup-status" style="margin:0;padding:0;border:0"><span class="status-icon">${icon('eye')}</span><span>Watching for a playable stream.</span></div>`
            : `<button class="btn btn-ghost" type="button" data-watch="${escapeHtml(user.username)}">${icon('bell')} Keep checking</button>
               <span class="lookup-hint">We'll retry and record when TikTok opens the stream.</span>`
        }
      </div>
    </div>`;
  wireResultActions();
}

function renderErrorResult(message, username) {
  els.result.innerHTML = `
    <div class="lookup lookup-error">
      <div class="lookup-error-head">
        ${icon('alert')}
        <strong>Couldn't check @${escapeHtml(username)}</strong>
      </div>
      <p class="lookup-desc">${escapeHtml(message)}</p>
      <div class="lookup-actions">
        <button class="btn btn-ghost" type="button" data-retry>${icon('retry')} Try again</button>
      </div>
    </div>`;
  wireResultActions();
}

async function checkAndRecord() {
  if (state.busy) return;

  const username = cleanUsername(els.username.value);
  if (!username) {
    els.recordInputWrap.classList.add('is-invalid');
    setFormNote('Type a TikTok username first.', true);
    els.username.focus();
    return;
  }
  if (!isValidUsername(username)) {
    els.recordInputWrap.classList.add('is-invalid');
    setFormNote('Usernames can only use letters, numbers, dots and underscores.', true);
    els.username.focus();
    return;
  }

  els.recordInputWrap.classList.remove('is-invalid');
  setFormNote(DEFAULT_FORM_NOTE);
  state.lastUsername = username;
  setBusy(true);
  renderLoadingResult(username);

  try {
    const data = await api('/api/record', { method: 'POST', body: { username, frame: state.frame } });

    if (!data.live) {
      renderOfflineResult(data);
    } else if (data.noStream) {
      renderNoStreamResult(data);
    } else if (data.started || data.alreadyRecording) {
      renderLiveResult(data);
      toast(
        data.alreadyRecording
          ? `@${username} is already being recorded.`
          : `Recording @${username} — 9:16 portrait, 1080×1920.`,
        'success',
      );
      els.username.value = '';
      void loadState();
    } else {
      renderErrorResult('TikTok returned an unexpected response. Try again.', username);
    }
  } catch (error) {
    renderErrorResult(error.message || 'Something went wrong while checking that account.', username);
  } finally {
    setBusy(false);
  }
}

async function watchUsername(username, button) {
  if (!username) return;
  button.disabled = true;
  const original = button.innerHTML;
  button.innerHTML = `<span class="spinner" style="border-color:rgba(255,255,255,.22);border-top-color:#fff"></span> Adding…`;

  try {
    const data = await api('/api/watchers', { method: 'POST', body: { username, frame: state.frame } });
    const actions = button.closest('.lookup-actions');

    if (data.started) {
      toast(`@${username} is live — recording started.`, 'success');
      if (actions) {
        actions.innerHTML = `
          <a class="btn btn-ghost" href="#activeSection">${icon('aperture')} View live capture</a>
          <span class="lookup-hint">Recording started automatically.</span>`;
      }
    } else {
      toast(`Watching @${username} for their next live.`, 'info');
      if (actions) {
        actions.innerHTML = `
          <div class="lookup-status" style="margin:0;padding:0;border:0">
            <span class="status-icon">${icon('eye')}</span>
            <span>Watching for the next stream.</span>
          </div>
          <a class="lookup-hint" href="#watchSection" style="text-decoration:underline">Manage watchers</a>`;
      }
    }

    await loadState();
  } catch (error) {
    button.disabled = false;
    button.innerHTML = original;
    toast(error.message, 'error');
  }
}

/* ---------- State loading / polling ---------- */

function handleEvents(events, initial) {
  if (!Array.isArray(events) || !events.length) {
    if (initial) state.lastEventId = state.lastEventId ?? 0;
    return;
  }

  const maxId = events.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0);
  if (initial || state.lastEventId == null) {
    state.lastEventId = maxId;
    return;
  }

  const fresh = events
    .filter((event) => Number(event.id) > Number(state.lastEventId || 0))
    .sort((a, b) => Number(a.id) - Number(b.id));
  state.lastEventId = Math.max(Number(state.lastEventId || 0), maxId);

  for (const event of fresh) {
    switch (event.type) {
      case 'recording-saved':
      case 'recording-recovered':
        toast(event.message, 'success');
        break;
      case 'recording-failed':
        toast(event.message, 'error');
        break;
      case 'recording-deleted':
        toast(event.message, 'info');
        break;
      case 'watcher-added':
      case 'watcher-removed':
        toast(event.message, 'info');
        break;
      case 'recording-started':
        if (event.source === 'watcher') toast(event.message, 'success');
        break;
      default:
        break;
    }
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden) {
    pollTimer = setTimeout(() => void loadState(), 20_000);
    return;
  }
  const activeCount = state.active.length;
  const watcherCount = state.watchers.length;
  const delay = activeCount ? 2_500 : watcherCount ? 8_000 : 6_000;
  pollTimer = setTimeout(() => void loadState(), delay);
}

async function loadState({ initial = false } = {}) {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const data = await api('/api/state');
    const firstLoad = !state.loaded || initial;

    state.loaded = true;
    state.recordings = Array.isArray(data.recordings) ? data.recordings : [];
    state.active = Array.isArray(data.active) ? data.active : [];
    state.watchers = Array.isArray(data.watchers) ? data.watchers : [];
    state.storage = data.storage || state.storage;
    state.settings = data.settings || state.settings;
    state.security = data.security || state.security;
    state.events = Array.isArray(data.events) ? data.events : [];

    if (state.serverDown) {
      state.serverDown = false;
      toast('Reconnected to Burst Recording Service.', 'info');
    }

    handleEvents(state.events, firstLoad);
    renderEngine(data.engine);
    renderHeader();
    renderActive();
    renderWatchers();
    renderLibrary();
  } catch (error) {
    renderEngine(null);
    if (!state.serverDown) {
      state.serverDown = true;
      toast('Cannot reach the Burst Recording Service server. Is it still running?', 'error');
    }
  } finally {
    pollInFlight = false;
    schedulePoll();
  }
}

/* ---------- Scroll effects & reveals ---------- */

let scrollFrame = null;

function updateScrollEffects() {
  scrollFrame = null;
  const y = window.scrollY || 0;
  const heroHeight = els.hero?.offsetHeight || 560;
  const progress = Math.min(1, Math.max(0, y / Math.max(180, heroHeight * 0.72)));
  document.documentElement.style.setProperty('--hero-fade', String(1 - progress));
  document.body.classList.toggle('is-scrolled', y > 16);
  if (els.dockShell) {
    const top = els.dockShell.getBoundingClientRect().top;
    els.dockShell.classList.toggle('is-stuck', top <= 1);
  }
}

function requestScrollEffects() {
  if (scrollFrame != null) return;
  scrollFrame = requestAnimationFrame(updateScrollEffects);
}

function initReveals() {
  const items = $$('.reveal');
  if (!items.length) return;
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -30px 0px' },
  );
  items.forEach((el) => observer.observe(el));
}

function syncFrameControl() {
  if (els.frameSelect) els.frameSelect.value = state.frame;
}

function applyFramePreference() {
  const value = els.frameSelect?.value || 'auto';
  state.frame = FRAMES.has(value) ? value : 'auto';
  try {
    localStorage.setItem(FRAME_KEY, state.frame);
  } catch {
    /* storage can be blocked in private mode */
  }
}

/* ---------- Events ---------- */

function bindEvents() {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void checkAndRecord();
  });

  els.frameSelect?.addEventListener('change', applyFramePreference);

  els.username.addEventListener('input', () => {
    els.recordInputWrap.classList.remove('is-invalid');
    if (els.formNote.classList.contains('is-error')) setFormNote(DEFAULT_FORM_NOTE);
  });

  els.search.addEventListener('input', () => {
    state.search = els.search.value;
    renderLibrary();
  });

  els.sortSelect.addEventListener('change', () => {
    state.sort = SORT_LABELS.has(els.sortSelect.value) ? els.sortSelect.value : 'newest';
    renderLibrary();
  });

  window.addEventListener('scroll', requestScrollEffects, { passive: true });
  window.addEventListener('resize', requestScrollEffects);
  window.addEventListener('load', requestScrollEffects);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      schedulePoll();
    } else {
      void loadState();
    }
  });

  setInterval(updateClocks, 1000);
}

function init() {
  syncFrameControl();
  bindEvents();
  initReveals();
  requestScrollEffects();
  void loadState({ initial: true });
}

init();
