/**
 * Accent colour control.
 *
 * Purely presentational: reads/writes a colour preference, updates CSS custom
 * properties, and manages the small picker in the top-left corner. Recording,
 * library and server behaviour live in app.js and are never touched here.
 */
(() => {
  const STORAGE_KEY = 'burst.accent';
  const DEFAULT_ACCENT = '#a78bfa';
  const root = document.documentElement;

  let current = DEFAULT_ACCENT;
  let ui = null;

  function normalizeHex(value) {
    const raw = String(value || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(raw)) {
      return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toLowerCase();
    }
    if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
    return null;
  }

  function hexToRgb(hex) {
    return {
      r: Number.parseInt(hex.slice(1, 3), 16),
      g: Number.parseInt(hex.slice(3, 5), 16),
      b: Number.parseInt(hex.slice(5, 7), 16),
    };
  }

  function relativeLuminance({ r, g, b }) {
    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function readStored() {
    try {
      return normalizeHex(window.localStorage.getItem(STORAGE_KEY)) || DEFAULT_ACCENT;
    } catch {
      return DEFAULT_ACCENT;
    }
  }

  function persist(color) {
    try {
      window.localStorage.setItem(STORAGE_KEY, color);
    } catch {
      /* private mode / storage blocked — the colour still applies for this visit */
    }
  }

  function paint(color) {
    const rgb = hexToRgb(color);
    const ink = relativeLuminance(rgb) > 0.28 ? '#050505' : '#ffffff';

    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    root.style.setProperty('--accent-ink', ink);
    root.dataset.accent = color;
  }

  function syncUi() {
    if (!ui) return;
    ui.hex.textContent = current.toUpperCase();
    if (ui.input.value !== current) ui.input.value = current;
    for (const swatch of ui.swatches) {
      const active = normalizeHex(swatch.dataset.accent) === current;
      swatch.classList.toggle('is-active', active);
      swatch.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function apply(value, { save = true } = {}) {
    const color = normalizeHex(value);
    if (!color) return;
    current = color;
    paint(color);
    if (save) persist(color);
    syncUi();
  }

  function setOpen(open) {
    if (!ui) return;
    ui.panel.hidden = !open;
    ui.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    ui.control.classList.toggle('is-open', open);
  }

  function init() {
    const control = document.getElementById('accentControl');
    const toggle = document.getElementById('accentToggle');
    const panel = document.getElementById('accentPanel');
    const hex = document.getElementById('accentHex');
    const input = document.getElementById('accentColor');
    const swatches = [...document.querySelectorAll('[data-accent]')];
    if (!control || !toggle || !panel || !hex || !input) return;

    ui = { control, toggle, panel, hex, input, swatches };

    // Re-apply the stored colour now that the controls exist, without rewriting
    // localStorage just because the page loaded.
    apply(readStored(), { save: false });

    toggle.addEventListener('click', () => {
      setOpen(panel.hidden);
    });

    for (const swatch of swatches) {
      swatch.addEventListener('click', () => apply(swatch.dataset.accent));
    }

    input.addEventListener('input', () => apply(input.value));
    input.addEventListener('change', () => apply(input.value));

    document.addEventListener('pointerdown', (event) => {
      if (!panel.hidden && !control.contains(event.target)) setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || panel.hidden) return;
      setOpen(false);
      toggle.focus();
    });
  }

  // Apply before first paint where possible so there is no colour flash.
  paint(readStored());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
