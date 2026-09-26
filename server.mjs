#!/usr/bin/env node
// server.mjs — HTTP + WebSocket host for 巴别回声.
//
// No framework, no build step: node:http serves the static client and a tiny
// JSON API, and lib/ws.mjs speaks WebSocket for the realtime path. Audio
// frames arrive as binary WebSocket messages (raw 16 kHz mono Int16 PCM),
// which keeps the hot path allocation-light.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { isTrustedLocalRequest } from './lib/local-access.mjs';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, extname, normalize } from 'node:path';
import { loadConfig, saveConfig, deleteCustomProvider, ensureDirs, providerStatus, ROOT, UPLOAD_DIR, DEFAULT_CONFIG } from './lib/config.mjs';
import { loadCreds, setLocalCred, LOCAL_CRED_PATH, CRED_PATH } from './lib/env.mjs';
import { createAsrRegistry } from './lib/asr/index.mjs';
import { createLlm } from './lib/llm.mjs';
import { Meeting, toMarkdown, toVtt, formatDuration } from './lib/meeting.mjs';
import * as store from './lib/store.mjs';
import { attachWebSocket } from './lib/ws.mjs';
import { importMedia } from './lib/import.mjs';

// A meeting recorder that dies because of one bad socket is useless, so a
// stray exception is logged loudly and the process carries on.
process.on('uncaughtException', (err) => {
  console.error('[miaoji] uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[miaoji] unhandled rejection:', err && err.stack ? err.stack : err);
});

ensureDirs();
const creds = loadCreds();
const config = loadConfig();
const asr = createAsrRegistry(config, creds);
const llm = createLlm(config, creds);

const MEDIA_RE = /\.(wav|mp3|m4a|mp4|mov|webm|ogg|oga|flac|aac|wma|mkv|avi|opus|amr|aif|aiff|ts|m4v|3gp)$/i;

/** Live meeting objects, keyed by id. */
const meetings = new Map();

function getMeeting(id) {
  if (meetings.has(id)) return meetings.get(id);
  const doc = store.loadMeeting(id);
  if (!doc) return null;
  const m = Meeting.restore(doc, { config, asr, llm, creds });
  meetings.set(id, m);
  return m;
}

function createMeeting(body) {
  const id = randomBytes(6).toString('hex');
  const m = new Meeting({
    id,
    title: body?.title || '未命名会议',
    language: body?.language || 'auto',
    translateTo: body?.translateTo === undefined ? config.translate.target : body.translateTo,
    config,
    asr,
    llm,
    creds,
    source: body?.source || 'live',
  });
  meetings.set(id, m);
  m.save();
  return m;
}

/**
 * Start background transcription of a media file.
 * Fire-and-forget: progress streams over that meeting's WebSocket.
 */
function startImport(meeting, inputPath, removeAfter) {
  importMedia({ meeting, inputPath })
    .then(async () => {
      // Stay in "processing" while the minutes are written, otherwise the UI
      // claims the meeting is finished while the panel is still empty.
      try {
        await meeting.generateMinutes();
      } catch (err) {
        meeting.emit('error', { message: '生成纪要失败：' + err.message, fatal: false });
      }
      meeting.state = 'stopped';
      meeting.emit('status', { state: meeting.state });
      meeting.save();
    })
    .catch((err) => {
      meeting.state = 'stopped';
      meeting.emit('status', { state: meeting.state });
      meeting.emit('error', { message: '导入失败：' + err.message, fatal: true });
    })
    .finally(() => {
      if (removeAfter) {
        try { unlinkSync(inputPath); } catch { /* best effort */ }
      }
    });
}

// -- helpers ----------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 32 * 1024 * 1024)) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

function streamAudio(req, res, id) {
  const found = store.findAudio(id);
  if (!found) return sendJson(res, 404, { error: 'no audio for this meeting' });
  const type = found.ext === '.mp3' ? 'audio/mpeg'
    : found.ext === '.wav' ? 'audio/wav'
    : found.ext === '.webm' ? 'audio/webm'
    : found.ext === '.ogg' ? 'audio/ogg'
    : 'application/octet-stream';

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : found.size - 1;
    if (start >= found.size || end >= found.size || start > end) {
      res.writeHead(416, { 'content-range': 'bytes */' + found.size });
      return res.end();
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': 'bytes ' + start + '-' + end + '/' + found.size,
      'accept-ranges': 'bytes',
    });
    return createReadStream(found.path, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': found.size,
    'accept-ranges': 'bytes',
  });
  createReadStream(found.path).pipe(res);
}

// -- static files -----------------------------------------------------------

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = normalize(rel).replace(/^([.]{2}[\\/])+/, '');
  const file = join(ROOT, 'public', safe);
  if (!file.startsWith(join(ROOT, 'public'))) return sendJson(res, 403, { error: 'forbidden' });
  if (!existsSync(file) || !statSync(file).isFile()) return sendJson(res, 404, { error: 'not found' });
  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

// -- API --------------------------------------------------------------------

function bootstrap(lite = false) {
  return {
    status: providerStatus(config, creds),
    llmStats: llm.stats,
    ...(lite ? { hasMeetings: store.hasMeetings() } : { meetings: store.listMeetings() }),
    defaults: {
      translate: config.translate,
      realtime: config.realtime,
      summary: config.summary,
    },
  };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const rest = parts.slice(1);
  const method = req.method || 'GET';

  if (rest[0] === 'bootstrap' && method === 'GET') return sendJson(res, 200, bootstrap(url.searchParams.has('lite')));

  // Lightweight polling endpoint for the desktop shell: the tray icon, the
  // sleep blocker and notifications all key off this.
  if (rest[0] === 'live' && method === 'GET') {
    const list = [...meetings.values()].map((m) => ({
      id: m.id,
      title: m.title,
      state: m.state,
      durationMs: Math.round(m.durationMs),
      segments: m.segments.length,
      summary: !!m.summary,
      hasMinutes: !!m.minutes,
      source: m.source,
      watched: m.listeners.size,
    }));
    return sendJson(res, 200, {
      recording: list.some((m) => m.state === 'recording'),
      processing: list.some((m) => m.state === 'processing'),
      meetings: list,
      upstream: [...meetings.values()].map((m) => m.upstream).find(Boolean) || null,
      llmStats: llm.stats,
    });
  }

  if (rest[0] === 'credentials') {
    if (method === 'GET') {
      // Report which refs are satisfied, never the values themselves.
      return sendJson(res, 200, {
        sources: { central: CRED_PATH, local: LOCAL_CRED_PATH },
        configured: Object.keys(creds).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k)),
      });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      const value = String(body.value || '').trim();
      if (!name) return sendJson(res, 400, { error: '缺少 name' });
      try {
        const result = setLocalCred(name, value);
        // A new key can change which providers are constructible.
        asr.instances.clear();
        asr.failures.clear();
        return sendJson(res, 200, { ok: true, ...result, status: providerStatus(config, creds) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
  }

  if (rest[0] === 'config') {
    if (method === 'GET') return sendJson(res, 200, config);
    if (method === 'POST' || method === 'PATCH') {
      try {
        const patch = await readJson(req);
        const next = saveConfig(patch);
        // Hot-apply provider toggles without restarting the process.
        asr.config = next;
        asr.instances.clear();
        llm.config = next;
        if (patch.summary) {
          for (const meeting of meetings.values()) {
            if (['recording', 'paused'].includes(meeting.state)) meeting.startSummaryTimer();
          }
        }
        return sendJson(res, 200, { ok: true, status: providerStatus(next, creds) });
      } catch (err) { return sendJson(res, 400, { error: err.message }); }
    }
  }

  if (rest[0] === 'providers' && ['llm', 'asr'].includes(rest[1]) && rest[3] === 'models' && method === 'GET') {
    const provider = config[rest[1]].providers[rest[2]];
    if (!provider) return sendJson(res, 404, { error: '引擎不存在' });
    try {
      const key = creds[provider.keyRef];
      if (!key && !provider.noAuth) return sendJson(res, 400, { error: '请先配置 API Key' });
      const response = await fetch(provider.baseUrl.replace(/\/+$/, '') + '/models', {
        headers: key ? { authorization: (provider.kind === 'deepgram' ? 'Token ' : 'Bearer ') + key } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return sendJson(res, 502, { error: '读取模型列表失败：HTTP ' + response.status });
      const body = await response.json();
      const models = [...new Set((Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [])
        .map((item) => typeof item === 'string' ? item : item?.id || item?.name || item?.model)
        .filter((id) => typeof id === 'string' && id.trim()))].slice(0, 200);
      return sendJson(res, 200, { models });
    } catch (err) { return sendJson(res, 502, { error: '无法连接模型服务：' + err.message }); }
  }

  if (rest[0] === 'providers' && method === 'DELETE') {
    try {
      const next = deleteCustomProvider(rest[1], rest[2]);
      asr.config = next;
      asr.instances.clear();
      llm.config = next;
      return sendJson(res, 200, { ok: true, status: providerStatus(next, creds) });
    } catch (err) { return sendJson(res, 400, { error: err.message }); }
  }

  if (rest[0] === 'meetings') {
    const id = rest[1];

    if (!id) {
      if (method === 'GET') return sendJson(res, 200, { meetings: store.listMeetings() });
      if (method === 'POST') {
        const body = await readJson(req);
        const m = createMeeting(body);
        return sendJson(res, 200, { meeting: m.snapshot() });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const live = meetings.get(id);
    const doc = live ? live.snapshot() : store.loadMeeting(id);

    if (rest.length === 2) {
      if (method === 'GET') {
        if (!doc) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, { meeting: doc });
      }
      if (method === 'DELETE') {
        const m = meetings.get(id);
        if (m) {
          m.stopTimers();
          meetings.delete(id);
        }
        return sendJson(res, 200, { ok: store.deleteMeeting(id) });
      }
    }

    const action = rest[2];

    if (action === 'audio' && method === 'GET') return streamAudio(req, res, id);

    if (action === 'export' && method === 'GET') {
      if (!doc) return sendJson(res, 404, { error: 'not found' });
      const format = url.searchParams.get('format') || 'md';
      const base = (doc.title || 'meeting').replace(/[\\/:*?"<>|]/g, '_');
      if (format === 'json') {
        const text = JSON.stringify(doc, null, 2);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="' + encodeURIComponent(base) + '.json"',
        });
        return res.end(text);
      }
      if (format === 'vtt' || format === 'srt') {
        const useTr = url.searchParams.get('translated') === '1';
        const text = toVtt(doc, useTr);
        res.writeHead(200, {
          'content-type': 'text/vtt; charset=utf-8',
          'content-disposition': 'attachment; filename="' + encodeURIComponent(base) + '.vtt"',
        });
        return res.end(text);
      }
      if (format === 'txt') {
        const text = (doc.segments || [])
          .map((s) => '[' + formatDuration(s.start) + '] ' + s.speaker + ': ' + s.text)
          .join('\n');
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="' + encodeURIComponent(base) + '.txt"',
        });
        return res.end(text);
      }
      const text = toMarkdown(doc);
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="' + encodeURIComponent(base) + '.md"',
      });
      return res.end(text);
    }

    const m = getMeeting(id);
    if (!m) return sendJson(res, 404, { error: 'not found' });

    if (action === 'summarize' && method === 'POST') {
      const summary = await m.summarize();
      return sendJson(res, 200, { summary });
    }

    if (action === 'minutes' && method === 'POST') {
      try {
        const minutes = await m.generateMinutes();
        return sendJson(res, 200, { minutes });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (action === 'ask' && method === 'POST') {
      const body = await readJson(req);
      try {
        const entry = await m.ask(String(body.question || '').slice(0, 2000));
        return sendJson(res, 200, { entry });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (action === 'speakers' && method === 'POST') {
      const body = await readJson(req);
      if (body.action === 'rename') {
        m.renameSpeaker(body.from, body.to);
        return sendJson(res, 200, { speakers: m.speakers });
      }
      if (body.action === 'resplit') {
        try {
          const speakers = await m.resplitSpeakers();
          return sendJson(res, 200, { speakers, segments: m.segments });
        } catch (err) {
          return sendJson(res, 500, { error: err.message });
        }
      }
      return sendJson(res, 400, { error: 'unknown speakers action' });
    }

    if ((action === 'import' || action === 'import-path') && method === 'POST') {
      if (m.state === 'recording' || m.state === 'paused' || m.state === 'processing') {
        return sendJson(res, 409, { error: '请先等待当前录音或导入结束' });
      }

      let inputPath;
      let removeAfter = true;

      if (action === 'import-path') {
        // Desktop build only: the user picked a file with a native dialog, so
        // the server reads it off local disk instead of pushing hundreds of
        // megabytes through the IPC channel.
        const body = await readJson(req);
        const raw = String(body.path || '');
        if (!raw || !existsSync(raw) || !statSync(raw).isFile()) {
          return sendJson(res, 400, { error: '文件不存在或不可读' });
        }
        if (!MEDIA_RE.test(raw)) {
          return sendJson(res, 400, { error: '不支持的媒体格式' });
        }
        inputPath = raw;
        removeAfter = false;
      } else {
        const buf = await readBody(req, 2048 * 1024 * 1024);
        if (!buf.length) return sendJson(res, 400, { error: '上传内容为空' });
        const name = url.searchParams.get('name') || 'upload.bin';
        const safe = name.replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-80);
        inputPath = join(UPLOAD_DIR, id + '-' + Date.now() + '-' + safe);
        mkdirSync(UPLOAD_DIR, { recursive: true });
        writeFileSync(inputPath, buf);
      }

      m.state = 'processing';
      m.source = 'upload';
      m.emit('status', { state: m.state });
      startImport(m, inputPath, removeAfter);
      return sendJson(res, 202, { accepted: true, state: m.state });
    }
  }

  return sendJson(res, 404, { error: 'unknown api route' });
}

// -- HTTP server ------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  try {
    if (!isTrustedLocalRequest(req)) return sendJson(res, 403, { error: 'local request required' });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

// -- WebSocket --------------------------------------------------------------

attachWebSocket(server, {
  path: '/ws',
  allowRequest: isTrustedLocalRequest,
  onConnection(ws, req, url) {
    const id = url.searchParams.get('meeting');
    let meeting = id ? getMeeting(id) : null;

    if (!meeting && url.searchParams.get('new') === '1') {
      meeting = createMeeting({
        title: url.searchParams.get('title') || '未命名会议',
        language: url.searchParams.get('language') || 'auto',
        translateTo: url.searchParams.get('translateTo') || config.translate.target,
      });
    }
    if (!meeting) {
      ws.send({ type: 'error', message: '会议不存在', fatal: true });
      return ws.close(1008, 'unknown meeting');
    }

    ws.data.meeting = meeting;
    const send = (evt) => ws.send(evt);
    const unsubscribe = meeting.on(send);

    ws.send({
      type: 'hello',
      meeting: meeting.snapshot(),
      status: providerStatus(config, creds),
      asrAvailable: asr.available(),
    });
    // Replay the transcript so a late joiner sees the meeting so far.
    ws.send({ type: 'segments', segments: meeting.segments });

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) {
        // Wire format: raw little-endian Int16 PCM at config.audio.sampleRate.
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
        meeting.ingest(new Int16Array(ab));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case 'start':
            if (msg.title) meeting.title = msg.title;
            if (msg.language) meeting.language = msg.language;
            if (msg.translateTo !== undefined) meeting.translateTo = msg.translateTo;
            meeting.start();
            break;
          case 'pause':
            meeting.pause();
            break;
          case 'resume':
            meeting.resume();
            break;
          case 'stop':
            await meeting.stop();
            // The button says "结束并生成纪要", so actually generate them.
            try {
              await meeting.generateMinutes();
            } catch (err) {
              ws.send({ type: 'error', message: '生成纪要失败：' + err.message, fatal: false });
            }
            ws.send({ type: 'stats', stats: meeting.stats });
            break;
          case 'config-patch':
            if (msg.language) meeting.language = msg.language;
            if (msg.translateTo !== undefined) meeting.translateTo = msg.translateTo;
            if (msg.title) meeting.title = msg.title;
            meeting.emit('meta', {
              title: meeting.title,
              language: meeting.language,
              translateTo: meeting.translateTo,
            });
            meeting.scheduleSave();
            break;
          case 'summarize':
            await meeting.summarize();
            break;
          case 'minutes':
            await meeting.generateMinutes(msg.targetLang);
            break;
          case 'ask':
            await meeting.ask(String(msg.question || '').slice(0, 2000));
            break;
          case 'rename-speaker':
            meeting.renameSpeaker(msg.from, msg.to);
            break;
          case 'resplit-speakers':
            await meeting.resplitSpeakers();
            break;
          case 'stats':
            ws.send({ type: 'stats', stats: meeting.stats });
            break;
          case 'ping':
            ws.send({ type: 'pong' });
            break;
          default:
            break;
        }
      } catch (err) {
        ws.send({ type: 'error', message: err.message, fatal: false });
      }
    });

    ws.on('error', () => {
      // Socket-level noise must never take down a meeting in progress.
    });

    ws.on('close', () => {
      unsubscribe();
      const m = ws.data.meeting;
      // An abandoned live recording is stopped so its audio is flushed.
      if (m && m.state === 'recording' && m.listeners.size === 0) {
        setTimeout(() => {
          if (m.listeners.size === 0 && m.state === 'recording') m.stop().catch(() => {});
        }, 20000).unref?.();
      }
    });
  },
});

// Port 0 means "let the OS pick one", which is what the desktop shell uses
// so two copies of the app never fight over 8777. The real port is reported
// over stdout in the MIAOJI_READY handshake below.
const requestedPort = Number(process.env.MIAOJI_PORT || process.argv[2] || config.server.port);
const host = process.env.MIAOJI_HOST || config.server.host;
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('巴别回声测试版只能监听本机回环地址（127.0.0.1、localhost 或 ::1）');
}

server.listen(requestedPort, host, () => {
  const actualPort = server.address().port;
  const url = 'http://' + (host === '::1' ? '[::1]' : host) + ':' + actualPort + '/';
  // Machine-readable readiness line, must stay a single line on stdout.
  console.log('MIAOJI_READY ' + JSON.stringify({
    url,
    host,
    port: actualPort,
    pid: process.pid,
    cwd: process.cwd(),
  }));
  console.log('');
  console.log('  巴别回声 Babel Echo — AI 会议记录工作台');
  console.log('  ' + url);
  console.log('');
  console.log('  语音识别:');
  const status = providerStatus(config, creds);
  for (const p of status.asr) {
    const mark = p.enabled ? (p.ready ? '[可用]' : '[缺少密钥 ' + p.keyRef + ']') : '[已关闭]';
    console.log('    ' + mark + ' ' + p.name + ' — ' + p.label);
  }
  console.log('  路由: ' + JSON.stringify(status.routes));
  console.log('  文本模型:');
  for (const p of status.llm) {
    console.log('    ' + (p.ready ? '[可用]' : '[缺少密钥 ' + p.keyRef + ']') + ' ' + p.name + ' — ' + p.label);
  }
  console.log('  角色: ' + JSON.stringify(status.roles));
  console.log('');
});

// -- lifecycle --------------------------------------------------------------

/** Stop every live recording so its audio and transcript are flushed. */
async function shutdown(reason) {
  for (const m of meetings.values()) {
    if (m.state === 'recording' || m.state === 'paused') {
      try {
        await m.stop();
      } catch {
        /* best effort */
      }
    }
  }
  try {
    server.close();
  } catch {
    /* already closing */
  }
  console.log('[miaoji] 已退出（' + reason + '）');
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    shutdown(sig).finally(() => process.exit(0));
  });
}

// When spawned by the Electron shell, a dying parent closes our stdin. That
// is the only reliable orphan watchdog on Windows, where there is no process
// group to kill.
if (process.env.MIAOJI_PARENT_WATCHDOG === '1') {
  process.stdin.resume();
  process.stdin.on('close', () => {
    shutdown('parent gone').finally(() => process.exit(0));
  });
  process.stdin.on('end', () => {
    shutdown('parent gone').finally(() => process.exit(0));
  });
}

export { server, meetings, config, creds, asr, llm };
