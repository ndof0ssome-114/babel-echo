const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

module.exports = async function testReader({ manager, root, check, outputDir, mainWindow, dataDir, serverUrl }) {
  const windows = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-reader-qa-'));
  const wait = async (window, predicate, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (await window.webContents.executeJavaScript(predicate)) return true; } catch { /* Still loading. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  try {
    const { READER_EXAMPLE } = await import(pathToFileURL(path.join(root, 'public/reader-example.js')).href);
    const reader = manager.open({ title: 'Reader QA', text: READER_EXAMPLE }); windows.push(reader);
    const rendered = await wait(reader, 'document.querySelectorAll(".md-chart").length === 2 && !document.getElementById("readerPrint").disabled');
    const status = await reader.webContents.executeJavaScript('document.getElementById("readerStatus")?.textContent');
    check('reader renders flowchart and pie chart before enabling print', rendered, status);
    const probe = await reader.webContents.executeJavaScript('({' +
      'tables:document.querySelectorAll("#readerDocument table").length,' +
      'math:!!document.querySelector("#readerDocument .katex"),' +
      'footnote:!!document.querySelector("#readerDocument .footnotes"),' +
      'code:!!document.querySelector("#readerDocument .hljs-keyword"),' +
      'outline:document.querySelectorAll("#readerToc a").length,' +
      'isolated:typeof require === "undefined" && !window.miaojiDesktop,' +
      'charts:[...document.querySelectorAll(".md-chart")].every(i=>i.complete&&i.naturalWidth>0)})');
    check('reader displays tables, formulas, highlighted code, footnotes and heading navigation',
      probe.tables === 1 && probe.math && probe.footnote && probe.code && probe.outline >= 5);
    check('reader has an isolated bridge without recorder or Node access', probe.isolated);
    check('chart images finish decoding for printing', probe.charts);
    const chartLabels = await reader.webContents.executeJavaScript('(() => {' +
      'const url=document.querySelector(".md-chart")?.src||"";' +
      'const xml=decodeURIComponent(url.slice(url.indexOf(",")+1));' +
      'return new DOMParser().parseFromString(xml,"image/svg+xml").documentElement.textContent;})()');
    check('flowchart labels survive SVG sanitization and printing', ['读取 Markdown', '本地排版', '阅读与目录导航', '打印或保存 PDF'].every((label) => chartLabels.includes(label)));
    await reader.webContents.executeJavaScript('document.getElementById("readerSource").click()');
    const source = await reader.webContents.executeJavaScript('!document.getElementById("readerRaw").hidden && document.getElementById("readerRaw").textContent.includes("flowchart")');
    check('reader source toggle preserves the original Markdown', source);
    // The print stylesheet renders the document even while the source view is selected.
    const pdf = await reader.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    check('reader generates an A4 PDF from the rich document', pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 10000);
    await reader.webContents.executeJavaScript('document.getElementById("readerSource").click()');
    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'reader-print-qa.pdf'), pdf);
      fs.writeFileSync(path.join(outputDir, 'reader-qa.png'), (await reader.webContents.capturePage()).toPNG());
    }
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(scratch, 'pixel.png'), image);
    fs.writeFileSync(path.join(scratch, 'local.md'), '# Local image\n\n![pixel](pixel.png)\n');
    const local = manager.open(await manager.readMarkdownFile(path.join(scratch, 'local.md'))); windows.push(local);
    check('explicitly selected local Markdown resolves contained raster images', await wait(local,
      '!!document.querySelector(".md-image img") && document.querySelector(".md-image img").naturalWidth === 1 && !document.getElementById("readerPrint").disabled'));
    let networkRequests = 0;
    local.webContents.session.webRequest.onBeforeRequest({ urls: ['https://example.invalid/*'] }, (_details, callback) => { networkRequests++; callback({ cancel: true }); });
    const unsafe = manager.open({ title: 'Untrusted Markdown', text: '<script>window.__injected=true</script>\n\n' +
      '![remote](https://example.invalid/pixel.png)\n\n[unsafe](javascript:alert%281%29)\n\n' +
      '```mermaid\nnot-a-diagram broken\n```' }); windows.push(unsafe);
    const settled = await wait(unsafe, 'document.getElementById("readerPrint") && !document.getElementById("readerPrint").disabled');
    const guard = await unsafe.webContents.executeJavaScript('({' +
      'injected:!!window.__injected,' +
      'images:document.querySelectorAll("#readerDocument img").length,' +
      'unsafe:document.querySelectorAll("#readerDocument a[href^=\\"javascript:\\"]").length,' +
      'fallback:!!document.querySelector(".md-diagram pre") && !!document.querySelector(".md-diagram .md-warning")})');
    check('malformed charts keep readable source and do not block printing', settled && guard.fallback);
    check('untrusted Markdown cannot execute script or fetch remote images', !guard.injected && !guard.unsafe && !guard.images && networkRequests === 0);
    local.webContents.session.webRequest.onBeforeRequest(null);
    reader.reload();
    check('reader reload restores its in-memory document and diagrams', await wait(reader,
      'document.querySelectorAll(".md-chart").length === 2 && !document.getElementById("readerPrint").disabled'));
    // Exercise the actual recorder -> reader flow using an isolated QA meeting.
    const meeting = { id: 'reader-demo-qa', title: 'Reader integration QA', state: 'stopped',
      createdAt: Date.now(), language: 'zh', translateTo: '', mode: 'class', notesDetail: 'detailed',
      segments: [{ index: 0, start: 0, end: 1000, speaker: '老师', text: 'TRANSCRIPT-ONLY-QA' }],
      minutes: { mode: 'class', notesDetail: 'detailed', abstract: '课程概述', topics: [{ title: '知识点', detail: '完整解释', points: ['推导步骤'] }],
        keyConcepts: [{ term: '概念', explanation: '概念定义' }], examples: [{ title: '例题', explanation: '解法步骤' }],
        reviewQuestions: [{ question: '复习问题', answer: '原文答案' }] }, summary: READER_EXAMPLE, stats: {} };
    fs.mkdirSync(path.join(dataDir, 'meetings'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'meetings', meeting.id + '.json'), JSON.stringify(meeting));
    await mainWindow.loadURL(serverUrl + '?meeting=' + meeting.id + '&selftest=1');
    check('live summary uses the same rich Markdown and diagram renderer', await wait(mainWindow,
      'document.querySelectorAll("#summaryBody .md-chart").length === 2 && !!document.querySelector("#summaryBody table")'));
    check('classroom selection and detailed notes render the full topics, examples and review answers', await mainWindow.webContents.executeJavaScript(
      'document.getElementById("noteMode").value === "class" && document.getElementById("notesDetail").value === "detailed" && ["完整解释","概念定义","解法步骤","原文答案"].every(t=>document.getElementById("minutesBody").textContent.includes(t))'));
    const before = new Set(manager.readers.keys());
    await mainWindow.webContents.executeJavaScript('document.getElementById("btnReadSummary").click()');
    const summaryReader = [...manager.readers].find(([id]) => !before.has(id))?.[1]?.window;
    if (summaryReader) windows.push(summaryReader);
    check('summary Read/print opens a separate reader with the current summary', !!summaryReader && await wait(summaryReader,
      'document.querySelectorAll(".md-chart").length === 2 && !document.getElementById("readerPrint").disabled'));
    const beforeClean = new Set(manager.readers.keys());
    await mainWindow.webContents.executeJavaScript('document.getElementById("btnReadMinutes").click()');
    let cleanReader;
    const cleanEnd = Date.now() + 10000;
    while (Date.now() < cleanEnd && !cleanReader) {
      cleanReader = [...manager.readers].find(([id]) => !beforeClean.has(id))?.[1]?.window;
      if (!cleanReader) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (cleanReader) windows.push(cleanReader);
    check('Markdown reading and printing omit the transcript when the checkbox is off', !!cleanReader && await wait(cleanReader,
      'document.getElementById("readerDocument").textContent.includes("完整解释") && !document.getElementById("readerDocument").textContent.includes("TRANSCRIPT-ONLY-QA") && !document.getElementById("readerPrint").disabled'));
    await mainWindow.webContents.executeJavaScript('document.getElementById("includeTranscript").click()');
    check('Markdown export explicitly includes transcript only when selected', await mainWindow.webContents.executeJavaScript(
      'document.querySelector("[data-export=md]").href.includes("includeTranscript=1")'));
    const beforeFull = new Set(manager.readers.keys());
    await mainWindow.webContents.executeJavaScript('document.getElementById("btnReadMinutes").click()');
    const end = Date.now() + 10000;
    let fullReader;
    while (Date.now() < end && !fullReader) {
      fullReader = [...manager.readers].find(([id]) => !beforeFull.has(id))?.[1]?.window;
      if (!fullReader) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (fullReader) windows.push(fullReader);
    check('complete meeting Markdown opens with its summary and transcript sections', !!fullReader && await wait(fullReader,
      'document.getElementById("readerDocument").textContent.includes("转写全文") && !document.getElementById("readerPrint").disabled'));
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    if (!scratch.startsWith(path.join(os.tmpdir(), 'babel-reader-qa-'))) throw new Error('Unexpected test cleanup path');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};
