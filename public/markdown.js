// One renderer shared by live summaries and the standalone reader. No CDN requests.
const jobs = new WeakMap();
let enginePromise;
let mermaidPromise;
let diagramSequence = 0;
const MAX_TEXT = 2 * 1024 * 1024;
export const MAX_MARKDOWN_BYTES = MAX_TEXT;

export function decodeMarkdown(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength > MAX_TEXT) throw new Error('Markdown 文件不能超过 2 MB');
  const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
    : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(data);
  if (text.includes('\0')) throw new Error('文件包含二进制内容，请使用 UTF-8 或带 BOM 的 UTF-16 文本');
  return text;
}

async function engine() {
  enginePromise ||= import('./vendor/markdown/engine.js');
  return enginePromise;
}
function safeHref(value) {
  return /^(https?:|mailto:)/i.test(value) || value.startsWith('#');
}
function imageHtml(tokens, index, options, env) {
  const token = tokens[index];
  const src = token.attrGet('src') || '';
  const key = String(env.images.length);
  env.images.push({ src, alt: token.content || '' });
  return `<span class="md-image" data-md-image="${key}">${env.escape(token.content || '图片')}</span>`;
}

export async function renderMarkdownInto(container, text, options = {}) {
  const job = {};
  jobs.set(container, job);
  const current = () => jobs.get(container) === job;
  const raw = String(text || '');
  if (raw.length > MAX_TEXT) throw new Error('Markdown 内容不能超过 2 MB');
  let deps;
  try { deps = await engine(); }
  catch {
    if (!current()) return { stale: true };
    container.replaceChildren();
    const note = container.ownerDocument.createElement('p');
    note.className = 'md-warning'; note.textContent = 'Markdown 组件尚未安装。请执行 npm run desktop:install；原文仍可阅读。';
    const source = container.ownerDocument.createElement('pre'); source.textContent = raw;
    container.append(note, source);
    return { headings: [], warnings: [note.textContent] };
  }
  if (!current()) return { stale: true };
  const { MarkdownIt, createDOMPurify, highlight, katex, texmath, footnote, taskLists } = deps;
  const doc = container.ownerDocument;
  const purify = createDOMPurify(doc.defaultView);
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false,
    highlight(code, language) {
      if (code.length < 100000 && language && highlight.getLanguage(language)) {
        try { return highlight.highlight(code, { language, ignoreIllegals: true }).value; } catch { /* Plain code fallback. */ }
      }
      return '';
    } }).use(footnote).use(taskLists, { enabled: false }).use(texmath, {
      engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: { trust: false, strict: 'warn', maxExpand: 1000, maxSize: 20, throwOnError: false },
    });
  const env = { images: [], diagrams: [], escape: md.utils.escapeHtml };
  const originalFence = md.renderer.rules.fence;
  md.renderer.rules.image = imageHtml;
  md.renderer.rules.fence = (tokens, index, opts, context, renderer) => {
    if (tokens[index].info.trim().toLowerCase() !== 'mermaid') return originalFence(tokens, index, opts, context, renderer);
    const key = String(context.diagrams.length);
    const code = tokens[index].content;
    context.diagrams.push(code);
    return `<figure class="md-diagram" data-md-diagram="${key}"><pre><code>${md.utils.escapeHtml(code)}</code></pre></figure>`;
  };
  const html = md.render(raw, env);
  const fragment = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'video', 'audio', 'img'],
    FORBID_ATTR: ['src', 'srcset', 'formaction'], ALLOW_DATA_ATTR: true });
  if (!current()) return { stale: true };
  container.replaceChildren(fragment);
  container.classList.add('markdown-rich');
  const warnings = [];
  const headings = [];
  const slugs = new Map();
  const prefix = (options.idPrefix || 'md-').replace(/[^a-zA-Z0-9_-]/g, '');
  for (const heading of container.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const slug = heading.textContent.toLowerCase().trim().replace(/[^\p{Letter}\p{Number}_\s-]/gu, '').replace(/\s+/g, '-') || 'section';
    const count = slugs.get(slug) || 0; slugs.set(slug, count + 1);
    heading.id = prefix + slug + (count ? '-' + count : '');
    headings.push({ id: heading.id, level: Number(heading.tagName[1]), text: heading.textContent });
  }
  for (const input of container.querySelectorAll('input')) { input.disabled = true; input.type = 'checkbox'; }
  for (const table of container.querySelectorAll('table')) {
    const wrap = doc.createElement('div'); wrap.className = 'md-table-scroll';
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Markdown table');
    table.replaceWith(wrap); wrap.append(table);
  }
  for (const link of container.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) link.setAttribute('href', '#' + prefix + href.slice(1));
    else if (safeHref(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    else { link.removeAttribute('href'); link.title = '此链接不会自动打开'; }
  }
  // Footnote IDs and links use the same per-container namespace.
  for (const node of container.querySelectorAll('[id]')) {
    if (!/^H[1-6]$/.test(node.tagName)) node.id = prefix + node.id;
  }
  const tasks = [];
  let imageBytes = 0;
  for (const node of container.querySelectorAll('[data-md-image]')) {
    const { src, alt } = env.images[Number(node.dataset.mdImage)];
    tasks.push(async () => {
      try {
        if (Number(node.dataset.mdImage) >= 64) throw new Error('图片数量过多');
        let url;
        if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=\r\n]+$/i.test(src) && src.length < MAX_TEXT) url = src;
        else if (options.resolveImage && !/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(src)) url = await options.resolveImage(src);
        if (!current()) return;
        if (!url || !/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.test(url)) {
          node.textContent = `${alt || '图片'}（未加载：仅显示本地图片，不自动访问网络）`;
          node.classList.add('md-image-blocked'); return;
        }
        imageBytes += url.length * 0.75;
        if (imageBytes > 32 * 1024 * 1024) throw new Error('本地图片总量过大');
        const image = doc.createElement('img'); image.alt = alt; image.src = url;
        await image.decode().catch(() => { throw new Error('图片解码失败'); });
        if (current()) node.replaceChildren(image);
      } catch {
        if (current()) { node.textContent = `${alt || '图片'}（无法读取）`; node.classList.add('md-image-blocked'); }
      }
    });
  }
  for (const figure of container.querySelectorAll('[data-md-diagram]')) {
    const index = Number(figure.dataset.mdDiagram);
    const code = env.diagrams[index];
    tasks.push(async () => {
      try {
        if (options.diagrams === false) return;
        if (index >= 16 || code.length > 20000 || /%%\s*\{|^\s*---/.test(code)) throw new Error('图表过大或包含配置指令');
        mermaidPromise ||= deps.getMermaid().then((mermaid) => {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false,
            maxTextSize: 20000, maxEdges: 500, theme: 'neutral', fontFamily: 'Arial, "Microsoft YaHei", "PingFang SC", sans-serif',
            flowchart: { htmlLabels: false }, sequence: { useMaxWidth: true } });
          return mermaid;
        });
        const mermaid = await mermaidPromise;
        if (!current()) return;
        const { svg } = await mermaid.render('babel-diagram-' + (++diagramSequence), code);
        const safe = purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ['foreignObject', 'script', 'image', 'a'], FORBID_ATTR: ['href', 'xlink:href'] });
        if (!current()) return;
        const image = doc.createElement('img'); image.alt = 'Mermaid 图表'; image.className = 'md-chart';
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(safe);
        await image.decode();
        if (current()) figure.replaceChildren(image);
      } catch {
        if (!current()) return;
        const note = doc.createElement('figcaption'); note.className = 'md-warning';
        note.textContent = '图表未能绘制，已保留源码。请检查 Mermaid 语法。'; figure.prepend(note);
        warnings.push(note.textContent);
      }
    });
  }
  // Bound local image decoding and diagram work instead of starting an entire
  // document's worth of reads at once. Mermaid also serializes its own renderer.
  const iterator = tasks[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => {
    for (const task of iterator) { if (!current()) break; await task(); }
  }));
  if (!current()) return { stale: true };
  return { headings, warnings };
}

export function cancelMarkdownRender(container) { jobs.delete(container); }
