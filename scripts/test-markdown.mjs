import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdownInto, cancelMarkdownRender, decodeMarkdown } from '../public/markdown.js';
import { toMarkdown } from '../lib/meeting.mjs';
import { summaryMessages } from '../lib/prompts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'desktop/package.json'));
const { JSDOM } = require('jsdom');
const { readMarkdownFile, readRelativeImage, isExternalLink, MAX_MARKDOWN_BYTES, markdownPathsFromArgv, macDefaultHandlerScript, MARKDOWN_UTI } = require('./markdown-files.cjs');
const dom = new JSDOM('<!doctype html><div id="content"></div>', { url: 'http://127.0.0.1:9999/reader.html' });
const container = dom.window.document.getElementById('content');
const text = '# 标题\n\n| 项目 | 数值 |\n| --- | ---: |\n| 本地 | 3 |\n\n1. 有序\n   - 嵌套\n\n- [x] 完成\n\n' +
  '```javascript\nconst answer = "<script>";\n```\n\n$E=mc^2$\n\n说明[^a]\n\n[^a]: 脚注内容\n';
try {
  const result = await renderMarkdownInto(container, text, { diagrams: false, idPrefix: 'test-' });
  assert.equal(container.querySelectorAll('table tbody tr').length, 1);
  assert.ok(container.querySelector('ol li ul li'));
  assert.ok(container.querySelector('input[type=checkbox]').disabled);
  assert.ok(container.querySelector('input[type=checkbox]').checked);
  assert.ok(container.querySelector('pre code .hljs-keyword'));
  assert.ok(container.querySelector('.katex'));
  assert.ok(container.querySelector('math'));
  assert.equal(result.headings[0].id, 'test-标题');
  assert.ok(container.querySelector('[id="test-fn1"]'));
  assert.ok(container.querySelector('a[href="#test-fn1"]'));
  assert.equal(container.querySelector('script'), null);
  console.log('PASS Markdown tables, nested lists, tasks, syntax highlighting, math, footnotes and outline');

  await renderMarkdownInto(container, '<img src="https://example.invalid/track" onerror="alert(1)">\n\n' +
    '[unsafe](javascript:alert%281%29)\n\n[safe](https://example.invalid/)\n\n' +
    '![remote](https://example.invalid/track.png)\n\n![local](../private.png)', { diagrams: false });
  assert.equal(container.querySelector('img,script,iframe,object,embed'), null);
  assert.equal(container.querySelector('[onerror]'), null);
  assert.equal(container.querySelector('a[href^="javascript:"]'), null);
  assert.equal(container.querySelector('a[href^="https:"]').rel, 'noopener noreferrer');
  assert.equal(container.querySelectorAll('.md-image-blocked').length, 2);
  console.log('PASS untrusted HTML/URLs are inert and remote images are never fetched');

  const old = renderMarkdownInto(container, '# Old', { diagrams: false });
  const newer = renderMarkdownInto(container, '# Latest', { diagrams: false });
  await Promise.all([old, newer]); assert.equal(container.querySelector('h1').textContent, 'Latest');
  const pending = renderMarkdownInto(container, '# Canceled', { diagrams: false });
  cancelMarkdownRender(container); container.textContent = 'Changed meeting'; await pending;
  assert.equal(container.textContent, 'Changed meeting');
  assert.equal(decodeMarkdown(new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x41])), '# A');
  assert.throws(() => decodeMarkdown(new Uint8Array([0x41, 0, 0x42])), /二进制/);
  console.log('PASS stale Markdown rendering cannot overwrite a new document or meeting');

  const scratch = await mkdtemp(join(tmpdir(), 'babel-markdown-files-'));
  try {
    const docs = join(scratch, 'docs'); const outside = join(scratch, 'outside');
    await mkdir(docs); await mkdir(outside);
    await writeFile(join(docs, 'utf8.md'), '\ufeff# 测试');
    const snapshot = await readMarkdownFile(join(docs, 'utf8.md'));
    assert.equal(snapshot.text, '# 测试');
    await writeFile(join(docs, 'utf16.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 文档', 'utf16le')]));
    assert.equal((await readMarkdownFile(join(docs, 'utf16.md'))).text, '# 文档');
    await writeFile(join(docs, 'sample.png'), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(outside, 'private.png'), Buffer.from('private'));
    assert.equal((await readRelativeImage(snapshot.baseDir, 'sample.png')).mime, 'image/png');
    for (const relative of ['../outside/private.png', '%2e%2e/outside/private.png', 'file:///private.png', 'https://example.invalid/a.png', '/private.png', 'utf8.md']) {
      await assert.rejects(readRelativeImage(snapshot.baseDir, relative));
    }
    await symlink(outside, join(docs, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readRelativeImage(snapshot.baseDir, 'linked/private.png'), /文档目录/);
    await writeFile(join(docs, 'large.md'), Buffer.alloc(MAX_MARKDOWN_BYTES + 1));
    await assert.rejects(readMarkdownFile(join(docs, 'large.md')), /2 MB/);
    await assert.rejects(readMarkdownFile(join(docs, 'sample.png')), /Markdown/);
    assert.equal(isExternalLink('https://example.invalid'), true);
    for (const url of ['file:///C:/private', 'javascript:alert(1)', 'data:text/html,hello']) assert.equal(isExternalLink(url), false);
    console.log('PASS file size, encoding, relative image scope, traversal and symlink escape guards');
  } finally { await rm(scratch, { recursive: true, force: true }); }

  const exported = toMarkdown({ title: 'Export', createdAt: 0, segments: [], minutes: {
    actionItems: [{ task: 'A | B\nnext', owner: 'Test', due: 'Today' }],
  } });
  await renderMarkdownInto(container, exported, { diagrams: false });
  assert.equal(container.querySelectorAll('table tbody td').length, 3);
  assert.match(container.querySelector('table tbody td').textContent, /A \| B next/);
  const prompt = summaryMessages({ previous: 'Previous', newSegments: [{ text: 'Only new facts', start: 0 }], maxChars: 900 });
  assert.match(prompt[0].content, /mermaid/); assert.match(prompt[0].content, /禁止编造/);
  assert.match(prompt[1].content, /Previous/); assert.match(prompt[1].content, /Only new facts/);
  console.log('PASS exported table escaping and factual incremental chart prompts');
} finally { dom.window.close(); }

// Opening .md files from the operating system.
{
  assert.deepEqual(markdownPathsFromArgv(['C:/Apps/巴别回声.exe', '--allow-file-access', 'D:/笔记/会议.md', 'x.txt', 'B.MARKDOWN']), ['D:/笔记/会议.md', 'B.MARKDOWN']);
  assert.deepEqual(markdownPathsFromArgv(['electron', '.', '--reader', 'a.md']), ['a.md']);
  // As delivered to second-instance on Linux: Chromium switches first, then '.', then the file.
  assert.deepEqual(markdownPathsFromArgv(['/x/electron', '--no-sandbox', '--allow-file-access-from-files', '.', '/tmp/note.md']), ['/tmp/note.md']);
  assert.deepEqual(markdownPathsFromArgv(null), []);
  assert.match(macDefaultHandlerScript('com.miaoji.desktop'), /LSSetDefaultRoleHandlerForContentType\(\$\('net\.daringfireball\.markdown'\), \$\.kLSRolesAll, \$\('com\.miaoji\.desktop'\)\)/);
  assert.throws(() => macDefaultHandlerScript("x'); doShellScript('rm"));
  const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(main.includes(`const MAC_BUNDLE_ID = '${pkg.build.appId}';`), 'main.cjs bundle id matches build.appId');
  const docTypes = pkg.build.mac.extendInfo.CFBundleDocumentTypes;
  assert.equal(docTypes[0].LSHandlerRank, 'Alternate', 'installing never takes over .md silently');
  assert.deepEqual(docTypes[0].LSItemContentTypes, [MARKDOWN_UTI]);
  assert.equal(pkg.build.mac.extendInfo.UTImportedTypeDeclarations[0].UTTypeIdentifier, MARKDOWN_UTI);
  const nsis = readFileSync(new URL('../desktop/build/installer.nsh', import.meta.url), 'utf8');
  for (const line of ['Software\\Classes\\.md\\OpenWithProgids', 'Software\\RegisteredApplications" "BabelEcho"', '!macro customUnInstall']) assert.ok(nsis.includes(line.replaceAll('\\\\', '\\')), line);
  console.log('PASS .md file launches, macOS default-handler script and installer registration');
}
