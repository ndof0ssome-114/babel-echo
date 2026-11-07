import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAppearance, readAppearance, applyAppearance, contrastInk, contrastRatio, APPEARANCE_KEY, SKINS, SKIN_INFO, skinAccent } from '../public/appearance.js';

// Upgrade existing preferences without changing the default visual family.
const storage = (entries) => ({ getItem: (key) => entries[key] ?? null });
assert.equal(readAppearance(storage({ 'miaoji-theme': 'dark' })).mode, 'dark');
assert.equal(readAppearance(storage({ 'miaoji-theme': 'dark' })).skin, 'default');
assert.equal(readAppearance(storage({ [APPEARANCE_KEY]: '{broken', 'miaoji-theme': 'light' })).mode, 'light');
assert.equal(readAppearance({ getItem() { throw new Error('blocked'); } }).mode, 'auto');
assert.equal(normalizeAppearance(null).skin, 'default');
const prefs = normalizeAppearance({ skin: 'endspace', mode: 'dark', profiles: {
  default: { accent: '#ABCDEF', fontSize: 18 },
  endspace: { accent: 'url(https://example.com)', radius: -10, fontSize: Infinity, density: 'invalid' },
} });
assert.equal(prefs.profiles.default.accent, '#abcdef');
assert.equal(prefs.profiles.endspace.accent, '');
assert.equal(prefs.profiles.endspace.radius, 0);
assert.equal(prefs.profiles.endspace.fontSize, 14);
assert.equal(prefs.profiles.endspace.density, 'comfortable');
assert.equal(normalizeAppearance({ profiles: { default: { fontSize: 100, radius: 100 } } }).profiles.default.fontSize, 20);
assert.deepEqual(normalizeAppearance(JSON.parse(JSON.stringify(prefs))), prefs);

// Applying another skin removes the previous custom colors. System mode reacts
// to the actual OS value rather than merely removing a root attribute.
let dark = false;
globalThis.matchMedia = () => ({ matches: dark });
const tokens = new Map();
const root = { dataset: {}, style: { setProperty: (k, v) => tokens.set(k, v), removeProperty: (k) => tokens.delete(k) } };
applyAppearance({ ...prefs, skin: 'default' }, root);
assert.equal(tokens.get('--signal'), '#abcdef');
applyAppearance(prefs, root);
assert.equal(tokens.has('--signal'), false);
assert.equal(root.dataset.theme, 'dark');
applyAppearance({ ...prefs, mode: 'auto' }, root);
assert.equal(root.dataset.theme, 'light');
dark = true;
applyAppearance({ ...prefs, mode: 'auto' }, root);
assert.equal(root.dataset.theme, 'dark');
assert.equal(contrastInk('#fbfb45'), '#000000');
assert.equal(contrastInk('#000000'), '#ffffff');
assert.equal(contrastInk('#ffffff'), '#000000');
for (const accent of ['#fbfb45', '#000000', '#ffffff', '#435fdb', '#808080']) {
  assert.ok(contrastRatio(accent, contrastInk(accent)) >= 4.5);
}
applyAppearance({ profiles: { default: { accent: '#fbfb45' } }, mode: 'light' }, root);
assert.equal(tokens.get('--accent'), 'var(--text)');
applyAppearance({ profiles: { default: { accent: '#000000' } }, mode: 'dark' }, root);
assert.equal(tokens.get('--accent'), 'var(--text)');
// Every skin keeps its own profile and default radius; unknown skins fall back to default.
assert.deepEqual(SKINS, ['default', 'endspace', 'paper', 'nordic', 'contrast']);
const all = normalizeAppearance({ skin: 'paper' });
assert.equal(all.skin, 'paper');
for (const skin of SKINS) assert.equal(all.profiles[skin].radius, SKIN_INFO[skin].radius);
assert.equal(normalizeAppearance({ skin: 'neon' }).skin, 'default');
assert.equal(skinAccent('contrast', true), '#ffd60a');

// The new palettes are read from the stylesheet itself, so a later edit cannot quietly
// break readability: body text 7:1, secondary text and accent text 4.5:1, button labels 4.5:1.
const css = readFileSync(new URL('../public/appearance.css', import.meta.url), 'utf8');
const palette = (selector) => {
  const block = css.split(selector + ' {')[1]?.split('}')[0] || '';
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2].toLowerCase()]));
};
for (const skin of ['paper', 'nordic', 'contrast']) {
  const light = palette(`[data-skin="${skin}"]`);
  const dark = { ...light, ...palette(`[data-skin="${skin}"][data-theme="dark"]`) };
  for (const [mode, c] of [['light', light], ['dark', dark]]) {
    const label = skin + '/' + mode;
    for (const bg of ['bg', 'surface', 'surface-2']) {
      assert.ok(contrastRatio(c.text, c[bg]) >= 7, `${label} text on ${bg}`);
      assert.ok(contrastRatio(c['text-2'], c[bg]) >= 4.5, `${label} text-2 on ${bg}`);
      assert.ok(contrastRatio(c['text-3'], c[bg]) >= 4.5, `${label} text-3 on ${bg}`);
      assert.ok(contrastRatio(c.accent, c[bg]) >= 4.5, `${label} accent on ${bg}`);
    }
    assert.ok(contrastRatio(c['signal-ink'], c.signal) >= 4.5, `${label} primary button label`);
    assert.equal(c.accent, skinAccent(skin, mode === 'dark'), `${label} accent matches SKIN_INFO`);
    assert.equal(c['surface-2'], SKIN_INFO[skin].surface[mode === 'dark' ? 1 : 0], `${label} surface matches SKIN_INFO`);
  }
}
console.log('Appearance: five skins, palette contrast,');
console.log('Appearance: migration, corrupt storage, token validation, profile isolation, system mode and contrast passed.');
