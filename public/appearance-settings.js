import { getAppearance, updateAppearance, resetAppearanceProfile, skinAccent } from './appearance.js';

// Skin cards: [id, name, one-line character]. Order is the order shown.
const SKIN_CARDS = [
  ['default', '默认主题', '半透明面板与柔和渐变'],
  ['endspace', 'Endspace 风格', '黑白灰、信号黄与工业排版'],
  ['paper', '纸本', '暖色纸张、衬线正文，适合长时间阅读纪要'],
  ['nordic', '雾凇', '冷灰青色、留白宽松，安静不抢眼'],
  ['contrast', '高对比', '纯黑白、粗边框与醒目焦点，便于弱视和强光下使用'],
];
const isDark = () => document.documentElement.dataset.theme === 'dark';

export function appearanceSettings(h, t) {
  const prefs = getAppearance();
  const p = prefs.profiles[prefs.skin];
  const section = h('section', { class: 'settings-section appearance-settings', 'data-settings': 'appearance' });
  const status = h('p', { class: 'settings-note appearance-save-state', role: 'status', text: t('即时预览，自动保存在本机。') });
  const commit = async (patch, profile) => {
    const saved = await updateAppearance(patch, profile);
    status.textContent = t(saved ? '即时预览，自动保存在本机。' : '当前外观已应用，但无法保存；重启后可能恢复。');
  };
  const refresh = (focusSelector) => {
    const next = appearanceSettings(h, t);
    next.querySelector('.appearance-save-state').textContent = status.textContent;
    section.replaceWith(next);
    if (focusSelector) next.querySelector(focusSelector)?.focus();
  };
  const field = (label, control) => h('label', { class: 'settings-field' }, h('span', { text: t(label) }), control);
  const cards = SKIN_CARDS.map(([skin, label, note]) =>
    h('button', { type: 'button', class: 'appearance-card', 'data-preview-skin': skin,
      'aria-pressed': String(skin === prefs.skin), 'aria-label': t(label),
      onclick: async () => {
        await commit({ skin });
        refresh(`[data-preview-skin="${skin}"]`);
      } },
    h('span', { class: 'appearance-mini', 'aria-hidden': 'true' },
      h('span', { class: 'appearance-mini-bar' }),
      h('span', { class: 'appearance-mini-content' }, h('span'), h('span'))),
    h('strong', { text: t(label) }), h('small', { text: t(note) })));
  const mode = h('select', { id: 'appearanceMode', onchange: async (e) => {
    await commit({ mode: e.target.value });
    const current = getAppearance();
    if (!current.profiles[current.skin].accent) accent.value = skinAccent(current.skin, isDark());
  } },
    ...[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([value, label]) =>
      h('option', { value, selected: value === prefs.mode, text: t(label) })));
  const density = h('select', { id: 'appearanceDensity', onchange: (e) => commit({}, { density: e.target.value }) },
    ...[['comfortable', '舒适'], ['compact', '紧凑']].map(([value, label]) =>
      h('option', { value, selected: value === p.density, text: t(label) })));
  const range = (key, label, min, max, unit) => {
    const output = h('output', { text: p[key] + unit });
    const input = h('input', { type: 'range', min, max, step: 1, value: p[key],
      id: 'appearance-' + key, oninput: (e) => {
        output.textContent = e.target.value + unit;
        commit({}, { [key]: Number(e.target.value) });
      } });
    return field(label, h('span', { class: 'appearance-range' }, input, output));
  };
  const accent = h('input', { id: 'appearanceAccent', type: 'color',
    value: p.accent || skinAccent(prefs.skin, isDark()),
    oninput: (e) => commit({}, { accent: e.target.value }) });
  const accentField = h('div', { class: 'appearance-accent' }, field('强调色', accent),
    h('button', { id: 'appearanceUseThemeColors', class: 'btn tiny', type: 'button', text: t('使用主题配色'), onclick: async () => { await commit({}, { accent: '' }); refresh('#appearanceUseThemeColors'); } }));
  section.append(
    h('div', { class: 'settings-section-head' }, h('h4', { text: t('界面外观') })),
    h('div', { class: 'appearance-cards', role: 'group', 'aria-label': t('界面主题') }, cards),
    h('div', { class: 'settings-grid' }, field('明暗模式', mode), field('界面间距', density),
      range('fontSize', '阅读字号', 12, 20, 'px'), range('radius', '面板圆角', 0, 24, 'px'), accentField,
      h('label', { class: 'settings-check' }, h('input', { type: 'checkbox', id: 'appearanceTexture', checked: p.texture,
        onchange: (e) => commit({}, { texture: e.target.checked }) }), t('显示背景纹理'))),
    h('div', { class: 'settings-actions' }, h('button', { id: 'appearanceReset', class: 'btn tiny', type: 'button', text: t('恢复当前主题默认值'),
      onclick: async () => { status.textContent = t(await resetAppearanceProfile() ? '即时预览，自动保存在本机。' : '当前外观已应用，但无法保存；重启后可能恢复。'); refresh('#appearanceReset'); } })), status,
    h('p', { class: 'settings-note', text: t('每种主题分别记住自定义外观。阅读字号调整转写、摘要、纪要和问答。') }),
    h('a', { class: 'appearance-source', href: 'https://github.com/cloud-oc/endspace', target: '_blank', rel: 'noopener noreferrer', text: t('设计参考：Endspace（cloud-oc）') }));
  return section;
}
