import { renderMarkdownInto, decodeMarkdown, MAX_MARKDOWN_BYTES } from './markdown.js';
import { READER_EXAMPLE } from './reader-example.js';
import { translate, applyStaticTranslations } from './i18n.js';

const $ = (id) => document.getElementById(id);
const bridge = window.babelMarkdownReader;
const language = new URLSearchParams(location.search).get('ui') || localStorage.getItem('miaoji-ui-language') || 'zh';
const t = (text) => translate(text, language);
let activeText = '';
let loading = false;
let ready = Promise.resolve();
let sourceView = false;
let revision = 0;
let preferences = { mode: 'auto', fontSize: 17 };
try {
  const saved = JSON.parse(localStorage.getItem('babel-markdown-reader-v1') || '{}');
  if (['auto', 'light', 'dark'].includes(saved.mode)) preferences.mode = saved.mode;
  if ([15, 17, 19, 21].includes(saved.fontSize)) preferences.fontSize = saved.fontSize;
} catch { /* Reading documents never depends on preference storage. */ }
function applyPreferences() {
  document.documentElement.dataset.theme = preferences.mode === 'dark' ||
    (preferences.mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.documentElement.style.setProperty('--reader-font', preferences.fontSize + 'px');
  $('readerMode').value = preferences.mode; $('readerFont').value = String(preferences.fontSize);
  try { localStorage.setItem('babel-markdown-reader-v1', JSON.stringify(preferences)); } catch { /* Apply in memory. */ }
}
function setStatus(text) { $('readerStatus').textContent = text; }
function updateButtons() {
  $('readerPrint').disabled = loading || !activeText;
  $('readerPdf').disabled = loading || !activeText;
  $('readerSource').disabled = !activeText;
}
function setSourceView(value) {
  sourceView = value;
  $('readerSource').setAttribute('aria-pressed', String(value));
  $('readerSource').textContent = t(value ? '返回阅读' : '查看源码');
  $('readerRaw').hidden = !value || !activeText;
  $('readerDocument').hidden = value || !activeText;
}
function outline(headings = []) {
  $('readerToc').replaceChildren(...headings.map((heading) => {
    const link = document.createElement('a'); link.href = '#' + heading.id;
    link.textContent = heading.text; link.dataset.level = Math.min(4, heading.level); return link;
  }));
}
export async function showDocument(snapshot) {
  const ownRevision = ++revision;
  const text = String(snapshot?.text || '');
  if (new TextEncoder().encode(text).byteLength > MAX_MARKDOWN_BYTES) throw new Error(t('Markdown 文件不能超过 2 MB'));
  activeText = text; loading = true; setSourceView(false); updateButtons();
  $('readerEmpty').hidden = !!text;
  $('readerRaw').textContent = text;
  $('documentName').textContent = snapshot?.title || t('未命名文档');
  document.title = (snapshot?.title || t('Markdown 阅读器')) + ' — Babel Echo';
  $('readerStats').textContent = text ? `${text.length.toLocaleString()} ${t('字符')}` : '';
  setStatus(t('正在排版…'));
  ready = renderMarkdownInto($('readerDocument'), text, { idPrefix: 'reader-',
    resolveImage: snapshot?.hasLocalAssets && bridge ? async (relative) => {
      const asset = await bridge.readImage(relative); return `data:${asset.mime};base64,${asset.base64}`;
    } : null });
  try {
    const result = await ready;
    await document.fonts.ready;
    if (ownRevision !== revision || result.stale) return;
    outline(result.headings);
    setStatus(t(result.warnings?.length ? '排版完成，部分内容显示为源码。' : '排版完成 · 本地阅读'));
  } catch (error) {
    if (ownRevision === revision) setStatus(t('无法排版：') + error.message);
  } finally {
    if (ownRevision === revision) { loading = false; updateButtons(); }
  }
}
async function openFile() {
  if (bridge) {
    try { const snapshot = await bridge.pickDocument(); if (snapshot) await showDocument(snapshot); }
    catch (error) { setStatus(error.message); }
  } else $('readerFile').click();
}
async function printDocument(pdf) {
  if (!activeText) return;
  loading = true; updateButtons();
  try {
    await ready; await document.fonts.ready;
    if (bridge) {
      const result = pdf ? await bridge.savePdf() : await bridge.print();
      setStatus(t(result?.canceled ? '已取消' : pdf ? 'PDF 已保存' : '已提交打印'));
    } else {
      // Browser print offers Save as PDF through the system print dialog.
      setSourceView(false); window.print();
    }
  } catch (error) { setStatus(error.message); }
  finally { loading = false; updateButtons(); }
}
$('readerOpen').onclick = openFile;
$('readerExample').onclick = () => showDocument({ title: t('排版示例'), text: READER_EXAMPLE });
$('readerSource').onclick = () => setSourceView(!sourceView);
$('readerPrint').onclick = () => printDocument(false);
$('readerPdf').onclick = () => printDocument(true);
$('readerFont').onchange = (event) => { preferences.fontSize = Number(event.target.value); applyPreferences(); };
$('readerMode').onchange = (event) => { preferences.mode = event.target.value; applyPreferences(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPreferences);
$('readerFile').onchange = async () => {
  const file = $('readerFile').files[0]; $('readerFile').value = '';
  if (!file) return;
  try {
    if (file.size > MAX_MARKDOWN_BYTES) throw new Error(t('Markdown 文件不能超过 2 MB'));
    await showDocument({ title: file.name, text: decodeMarkdown(await file.arrayBuffer()) });
  } catch (error) { setStatus(error.message); }
};
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 'p') { event.preventDefault(); printDocument(false); }
  if (event.key.toLowerCase() === 'o') { event.preventDefault(); openFile(); }
});
for (const [id, label] of Object.entries({ readerLabel: 'Markdown 阅读器', readerOpen: '打开 MD',
  readerSource: '查看源码', readerPdf: '保存 PDF', readerPrint: '打印', tocLabel: '文档目录',
  localHint: '本地阅读，不自动加载网络图片。', emptyTitle: '给文字一个清晰的版面',
  emptyHint: '打开本地 Markdown，或从会议摘要进入阅读器。支持表格、图表、公式和打印。', readerExample: '查看排版示例' })) $(id).textContent = t(label);
for (const option of $('readerMode').options) option.textContent = t(option.textContent);
applyStaticTranslations(language); applyPreferences(); updateButtons();
// Keep heading/footnote targets visible below the toolbar, including when its
// controls wrap in a narrow reader window or after the interface language changes.
const toolbar = document.querySelector('.reader-toolbar');
new ResizeObserver(() => document.documentElement.style.setProperty('--reader-toolbar-height', toolbar.offsetHeight + 'px')).observe(toolbar);
async function boot() {
  if (bridge) {
    const snapshot = await bridge.getDocument();
    if (snapshot?.text) await showDocument(snapshot);
    else setStatus(t('准备就绪'));
    return;
  }
  const query = new URLSearchParams(location.search);
  const meetingId = query.get('meeting');
  if (meetingId && /^[A-Za-z0-9_-]{6,64}$/.test(meetingId)) {
    const url = '/api/meetings/' + meetingId;
    if (query.get('view') === 'full') {
      const response = await fetch(url + '/export?format=md&includeTranscript=' + (query.get('includeTranscript') === '0' ? '0' : '1')); if (!response.ok) throw new Error(t('无法读取会议'));
      await showDocument({ title: t('完整纪要'), text: await response.text() });
    } else {
      const response = await fetch(url); if (!response.ok) throw new Error(t('无法读取会议'));
      const { meeting } = await response.json(); await showDocument({ title: meeting.title, text: meeting.summary || '' });
    }
  } else if (query.has('example')) await showDocument({ title: t('排版示例'), text: READER_EXAMPLE });
  else setStatus(t('准备就绪'));
}
boot().catch((error) => setStatus(error.message));
