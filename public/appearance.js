// Local appearance preferences. Only bounded design tokens reach CSS.
export const APPEARANCE_KEY = 'babel-echo-appearance-v1';
const LEGACY_MODE_KEY = 'miaoji-theme';
// Each skin: default panel radius, its own accent (shown in the color picker) and the
// secondary surface that custom accents are checked against for readable text.
export const SKIN_INFO = {
  default: { radius: 20, accent: ['#435fdb', '#9cb2ff'], surface: ['#eaf0f8', '#283750'] },
  endspace: { radius: 2, accent: ['#fbfb45', '#fbfb45'], surface: ['#f4f4f5', '#252529'] },
  paper: { radius: 10, accent: ['#a3441d', '#e8a07a'], surface: ['#efe6d6', '#2b251e'] },
  nordic: { radius: 16, accent: ['#226f6b', '#7fcbc4'], surface: ['#e3ebee', '#22303a'] },
  contrast: { radius: 4, accent: ['#0040c1', '#ffd60a'], surface: ['#f0f0f0', '#1a1a1a'] },
};
export const SKINS = Object.keys(SKIN_INFO);
/** The skin's own accent for the current light/dark mode. */
export const skinAccent = (skin, dark) => (SKIN_INFO[skin] || SKIN_INFO.default).accent[dark ? 1 : 0];
const defaults = (skin) => ({ accent: '', fontSize: 14, radius: (SKIN_INFO[skin] || SKIN_INFO.default).radius, density: 'comfortable', texture: true });

export function normalizeAppearance(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const profiles = Object.fromEntries(SKINS.map((skin) => {
    const p = source.profiles?.[skin] || {};
    const d = defaults(skin);
    const bounded = (v, min, max, fallback) => typeof v === 'number' && Number.isFinite(v)
      ? Math.round(Math.min(max, Math.max(min, v))) : fallback;
    return [skin, {
      accent: typeof p.accent === 'string' && /^#[0-9a-f]{6}$/i.test(p.accent) ? p.accent.toLowerCase() : '',
      fontSize: bounded(p.fontSize, 12, 20, d.fontSize),
      radius: bounded(p.radius, 0, 24, d.radius),
      density: p.density === 'compact' ? 'compact' : 'comfortable',
      texture: typeof p.texture === 'boolean' ? p.texture : true,
    }];
  }));
  return { version: 1, skin: SKINS.includes(source.skin) ? source.skin : 'default',
    mode: ['auto', 'light', 'dark'].includes(source.mode) ? source.mode : 'auto', profiles };
}

export function readAppearance(storage) {
  try {
    const raw = storage.getItem(APPEARANCE_KEY);
    if (raw) return normalizeAppearance(JSON.parse(raw));
  } catch { /* Corrupt or unavailable storage must not prevent startup. */ }
  let mode;
  try { mode = storage.getItem(LEGACY_MODE_KEY); } catch { /* Use system. */ }
  return normalizeAppearance({ mode });
}

// Return a foreground with the larger WCAG contrast against a solid color.
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
export function contrastRatio(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
export function contrastInk(hex) {
  const l = luminance(hex);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

let appearance;
let desktopSave = Promise.resolve();
export function getAppearance() { return structuredClone(appearance); }

export function applyAppearance(value, root = document.documentElement) {
  const prefs = normalizeAppearance(value);
  const p = prefs.profiles[prefs.skin];
  root.dataset.skin = prefs.skin;
  root.dataset.density = p.density;
  root.dataset.texture = String(p.texture);
  root.dataset.customAccent = String(Boolean(p.accent));
  root.dataset.colorMode = prefs.mode;
  const dark = prefs.mode === 'dark' || (prefs.mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.style.setProperty('--ui-font-size', p.fontSize + 'px');
  root.style.setProperty('--ui-radius', p.radius + 'px');
  for (const token of ['--accent', '--accent-soft', '--signal', '--signal-ink']) root.style.removeProperty(token);
  if (p.accent) {
    root.style.setProperty('--signal', p.accent);
    root.style.setProperty('--signal-ink', contrastInk(p.accent));
    // Pale signal colors stay on backgrounds; readable text uses the theme ink.
    const surface = SKIN_INFO[prefs.skin].surface[dark ? 1 : 0];
    root.style.setProperty('--accent', contrastRatio(p.accent, surface) < 4.5 ? 'var(--text)' : p.accent);
    root.style.setProperty('--accent-soft', p.accent + (dark ? '26' : '18'));
  }
  return prefs;
}

export async function updateAppearance(patch = {}, profilePatch) {
  const next = { ...appearance, ...patch, profiles: { ...appearance.profiles } };
  if (profilePatch) next.profiles[next.skin] = { ...next.profiles[next.skin], ...profilePatch };
  appearance = applyAppearance(next);
  let saved = true;
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
    if (appearance.mode === 'auto') localStorage.removeItem(LEGACY_MODE_KEY);
    else localStorage.setItem(LEGACY_MODE_KEY, appearance.mode);
  } catch { saved = false; }
  const bridge = window.miaojiDesktop;
  if (bridge?.setAppearancePreference) {
    const snapshot = getAppearance();
    const write = desktopSave.then(() => bridge.setAppearancePreference(snapshot));
    desktopSave = write.catch(() => {});
    try { await write; saved = true; } catch { saved = false; }
  }
  window.dispatchEvent(new CustomEvent('appearancechange', { detail: { saved } }));
  return saved;
}

export function resetAppearanceProfile() {
  return updateAppearance({}, defaults(appearance.skin));
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let storage;
  try { storage = window.localStorage; } catch { /* Defaults still render. */ }
  appearance = applyAppearance(readAppearance(storage));
  const bridge = window.miaojiDesktop;
  if (bridge?.getAppearancePreference) {
    try {
      const saved = await bridge.getAppearancePreference();
      if (saved) appearance = applyAppearance(saved);
      else await bridge.setAppearancePreference(appearance);
    } catch { /* The settings UI reports write failures on the next change. */ }
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (appearance.mode === 'auto') {
      applyAppearance(appearance);
      window.dispatchEvent(new CustomEvent('appearancechange', { detail: { saved: true } }));
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === APPEARANCE_KEY || event.key === null) {
      appearance = applyAppearance(readAppearance(storage));
      window.dispatchEvent(new CustomEvent('appearancechange', { detail: { saved: true } }));
    }
  });
}
