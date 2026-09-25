// app.js — the 妙记 client.
//
// Plain ES modules, no framework. Everything is driven by one WebSocket to
// the server: control messages go up as JSON, audio goes up as binary
// Int16 PCM frames, and the server pushes state back down (partial text,
// committed segments, rolling summary, minutes, answers).

import { applyStaticTranslations, translate } from './i18n.js';

// --------------------------------------------------------------------------
// tiny DOM helpers
// --------------------------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (sel) => document.querySelector(sel);

function fmtClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const hh = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return hh ? hh + ':' + mm + ':' + ss : mm + ':' + ss;
}

/** Escape then apply the small markdown subset the models actually emit. */
function renderMarkdown(text) {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc(text || '').split(/\r?\n/);
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length + 1);
      out.push('<h' + level + '>' + bold(heading[2]) + '</h' + level + '>');
    } else if (bullet || numbered) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push('<li>' + bold((bullet || numbered)[1]) + '</li>');
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push('<p>' + bold(line) + '</p>');
    }
  }
  closeList();
  return out.join('');
}

// --------------------------------------------------------------------------
// state
// --------------------------------------------------------------------------

const state = {
  uiLanguage: localStorage.getItem('miaoji-ui-language') || 'zh',
  meeting: null,
  segments: [],
  segmentEls: new Map(),
  liveEl: null,
  ws: null,
  retry: 0,
  recording: false,
  paused: false,
  startedAt: 0,
  elapsedBase: 0,
  audioCtx: null,
  stream: null,
  systemStream: null,
  testingMic: false,
  micTestPeak: 0,
  lastAudibleAt: 0,
  quietWarningAt: 0,
  worklet: null,
  activeMicId: null,
  savedMicLabel: '',
  micLabels: new Map(),
  microphoneListLoaded: false,
  listeningDeviceChanges: false,
  settingsOpen: new Set(),
  status: null,
  bars: new Array(160).fill(0),
  sending: true,
  importDone: null,
};

const els = {
  title: $('#title'),
  uiLanguage: $('#uiLanguage'),
  timer: $('#timer'),
  statePill: $('#statePill'),
  engineChip: $('#engineChip'),
  language: $('#language'),
  translateTo: $('#translateTo'),
  microphone: $('#microphone'),
  microphoneStatus: $('#microphoneStatus'),
  btnRefreshMicrophones: $('#btnRefreshMicrophones'),
  btnTestMicrophone: $('#btnTestMicrophone'),
  includeSystemAudio: $('#includeSystemAudio'),
  systemAudioField: $('#systemAudioField'),
  transcript: $('#transcript'),
  transcriptEmpty: $('#transcriptEmpty'),
  segCount: $('#segCount'),
  levelHint: $('#levelHint'),
  meter: $('#meter'),
  player: $('#player'),
  playerWrap: $('#playerWrap'),
  summaryBody: $('#summaryBody'),
  summaryMeta: $('#summaryMeta'),
  minutesBody: $('#minutesBody'),
  minutesMeta: $('#minutesMeta'),
  qaLog: $('#qaLog'),
  qaForm: $('#qaForm'),
  qaInput: $('#qaInput'),
  statsList: $('#statsList'),
  speakerList: $('#speakerList'),
  banner: $('#banner'),
  connState: $('#connState'),
  drawer: $('#drawer'),
  drawerTitle: $('#drawerTitle'),
  drawerBody: $('#drawerBody'),
  drawerClose: $('#drawerClose'),
  btnRecord: $('#btnRecord'),
  btnPause: $('#btnPause'),
  btnStop: $('#btnStop'),
  btnUpload: $('#btnUpload'),
  fileInput: $('#fileInput'),
  btnHistory: $('#btnHistory'),
  btnSettings: $('#btnSettings'),
  btnTheme: $('#btnTheme'),
  btnResummarize: $('#btnResummarize'),
  btnMinutes: $('#btnMinutes'),
  btnResplit: $('#btnResplit'),
};

const DEFAULT_TITLE = '未命名会议';

// Present only inside the Electron shell (see desktop/preload.cjs). When it
// is absent every desktop-only path falls back to plain browser behaviour.
const desktop = (typeof window !== 'undefined' && window.miaojiDesktop) || null;
const t = (key) => translate(key, state.uiLanguage);

function updateUiLanguage() {
  applyStaticTranslations(state.uiLanguage);
  if (!state.meeting && ['未命名会议', 'Untitled meeting', '無題の会議'].includes(els.title.value)) {
    els.title.value = t(DEFAULT_TITLE);
  }
  const labels = { idle: '待机', recording: '录音中', paused: '已暂停', processing: '处理中', stopped: '已结束' };
  els.statePill.textContent = t(labels[els.statePill.dataset.state] || '待机');
  els.btnPause.textContent = t(state.paused ? '继续' : '暂停');
  els.btnRecord.textContent = '● ' + t(state.recording ? '录音中' : '开始录音');
  els.btnTestMicrophone.textContent = t(state.testingMic ? '结束测试' : '测试麦克风');
  els.connState.textContent = t(state.ws?.readyState === WebSocket.OPEN ? '已连接' : '未连接');
  updateCounts();
  if (state.meeting) {
    renderStats(state.meeting.stats);
    renderSpeakers(state.meeting.speakers);
    if (state.meeting.minutes) renderMinutes(state.meeting.minutes);
  }
  if (state.status) applyStatus(state.status);
}

// --------------------------------------------------------------------------
// banner
// --------------------------------------------------------------------------

function showBanner(message, kind) {
  els.banner.hidden = !message;
  els.banner.textContent = message || '';
  els.banner.dataset.kind = kind || 'info';
}

// --------------------------------------------------------------------------
// websocket
// --------------------------------------------------------------------------

function connect(meetingId) {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      /* already closed */
    }
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/ws?meeting=' + encodeURIComponent(meetingId);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) return;
    state.retry = 0;
    els.connState.dataset.state = 'on';
    els.connState.textContent = t('已连接');
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    els.connState.dataset.state = 'off';
    els.connState.textContent = t('连接断开');
    // Reconnect while a recording is meant to be running.
    if (state.recording && state.retry < 6) {
      state.retry += 1;
      setTimeout(() => connect(meetingId), 800 * state.retry);
    }
  };

  ws.onerror = () => {
    if (state.ws !== ws) return;
    els.connState.dataset.state = 'off';
    els.connState.textContent = '连接错误';
  };

  ws.onmessage = (ev) => {
    if (state.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(msg);
  };
}

function send(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

async function createMeeting(opts) {
  const res = await fetch('/api/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts || {}),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.meeting;
}

// --------------------------------------------------------------------------
// event handling
// --------------------------------------------------------------------------

function handleEvent(evt) {
  switch (evt.type) {
    case 'hello':
      state.meeting = evt.meeting;
      state.status = evt.status;
      applyMeeting(evt.meeting);
      applyStatus(evt.status, evt.asrAvailable);
      break;

    case 'segments':
      state.segments = evt.segments || [];
      renderAllSegments();
      break;

    case 'segment':
      state.segments.push(evt.segment);
      clearLive();
      appendSegment(evt.segment);
      updateCounts();
      break;

    case 'segment-update': {
      const seg = state.segments.find((s) => s.index === evt.index);
      if (seg) {
        seg.translation = evt.translation;
        updateSegmentElement(seg);
      }
      break;
    }

    case 'partial':
      renderLive(evt);
      break;

    case 'summary':
      els.summaryBody.innerHTML = renderMarkdown(evt.summary);
      els.summaryMeta.textContent = '已更新 · ' + new Date().toLocaleTimeString('zh-CN');
      break;

    case 'summary-pending':
      els.summaryMeta.textContent = '正在总结…';
      break;

    case 'minutes':
      renderMinutes(evt.minutes);
      // Native toast when the shell has our attention elsewhere.
      if (desktop) desktop.notify('妙记 · 纪要已生成', els.title.value || '会议纪要');
      break;

    case 'answer':
      renderAnswer(evt);
      break;

    case 'speakers':
      renderSpeakers(evt.speakers);
      break;

    case 'meta':
      if (evt.title) els.title.value = evt.title;
      break;

    case 'status':
      applyState(evt.state);
      if (evt.state === 'stopped' && state.importDone !== null) {
        els.levelHint.textContent = '导入完成，共 ' + state.importDone + ' 条';
      }
      break;

    case 'level':
      pushLevel(evt.rms);
      break;

    case 'import-progress':
      els.levelHint.textContent =
        '正在转写 ' + evt.done + '/' + evt.total + ' 段 · 已处理 ' + fmtClock(evt.seconds * 1000);
      break;

    case 'import-done':
      state.importDone = evt.segments;
      if (state.meeting) state.meeting.durationMs = evt.durationMs;
      els.levelHint.textContent = '转写完成，共 ' + evt.segments + ' 条 · 正在生成纪要…';
      break;

    case 'audio':
      if (evt.audio && state.meeting) {
        els.playerWrap.hidden = false;
        els.player.src = '/api/meetings/' + state.meeting.id + '/audio?v=' + Date.now();
      }
      break;

    case 'stats':
      refreshStats(evt.stats);
      break;

    case 'error':
      showBanner(evt.message, evt.fatal ? 'error' : 'warn');
      if (evt.fatal) {
        stopCapture();
        applyState('stopped');
      }
      break;

    default:
      break;
  }
}

function applyMeeting(m) {
  state.meeting = m;
  state.importDone = null;
  state.segments = m.segments || [];
  els.title.value = m.title || t(DEFAULT_TITLE);
  els.language.value = m.language || 'auto';
  els.translateTo.value = m.translateTo || '';
  state.recording = false;
  state.startedAt = 0;
  state.elapsedBase = m.durationMs || 0;
  applyState(m.state);
  renderAllSegments();
  els.summaryBody.innerHTML = '<p class="muted">会议开始后，摘要会每隔一段时间自动刷新。</p>';
  els.summaryMeta.textContent = '尚未生成';
  if (m.summary) {
    els.summaryBody.innerHTML = renderMarkdown(m.summary);
    els.summaryMeta.textContent = '已恢复';
  }
  els.minutesBody.innerHTML = '<p class="muted">结束录音时会自动生成结构化纪要，也可以随时手动生成。</p>';
  els.minutesMeta.textContent = '尚未生成';
  if (m.minutes) renderMinutes(m.minutes);
  els.qaLog.innerHTML = '<p class="muted">基于本次会议的全部转写内容提问，回答会标注出处时间。</p>';
  if (m.qa && m.qa.length) {
    els.qaLog.innerHTML = '';
    for (const q of m.qa) renderAnswer(q);
  }
  renderSpeakers(m.speakers);
  renderStats(m.stats);
  if (m.audio) {
    els.playerWrap.hidden = false;
    els.player.src = '/api/meetings/' + m.id + '/audio?v=' + Date.now();
  } else {
    els.player.pause();
    els.player.removeAttribute('src');
    els.playerWrap.hidden = true;
  }
  updateExportLinks(m.id);
  updateCounts();
}

function applyStatus(s, asrAvailable) {
  if (!s) return;
  const routes = s.routes || {};
  const lang = els.language.value || 'auto';
  const chosen = s.active && s.active !== 'auto' ? s.active : routes[lang] || routes.auto;
  const wanted = lang === 'auto' ? null : lang;
  const capable = (s.asr || []).filter((p) => p.enabled && p.ready &&
    (!wanted || (p.kind === 'mimo' ? ['zh', 'en'].includes(wanted) :
      (p.languages || []).includes(wanted) || (p.languages || []).includes('auto'))));
  const selected = (s.asr || []).find((p) => p.name === chosen);
  const prov = capable.find((p) => p.name === chosen) || capable[0] || selected;
  if (prov) {
    els.engineChip.textContent = prov.enabled && prov.ready
      ? prov.label + ' · ' + (prov.pricePerHour ? prov.pricePerHour + ' ' + prov.currency + '/' + t('小时') : t('本地'))
      : prov.label + '（' + t('未就绪') + '）';
  } else {
    els.engineChip.textContent = t('无可用引擎');
  }

  // Warn when the requested language has no capable provider - this is the
  // honest failure mode for Japanese on a MiMo-only install.
  if (!capable.length) {
    showBanner(t('当前语言没有可用的语音识别引擎，请在「设置」中启用并填写密钥。'), 'error');
  } else if (lang === 'auto' && prov?.kind === 'mimo') {
    showBanner(t('当前自动识别使用 MiMo，仅适合中文和英文；日语请明确选择「日本語」并启用对应引擎。'), 'warn');
  } else {
    showBanner('');
  }
  if (asrAvailable && !asrAvailable.length) {
    showBanner(t('没有任何可用的语音识别引擎，请检查密钥配置。'), 'error');
  }
}

function applyState(s) {
  const wasPaused = state.paused;
  if (state.meeting) state.meeting.state = s;
  els.statePill.dataset.state = s || 'idle';
  const labels = { idle: '待机', recording: '录音中', paused: '已暂停', processing: '处理中', stopped: '已结束' };
  els.statePill.textContent = t(labels[s] || s);

  // Bank the elapsed time before flipping the flag, otherwise the running
  // segment is lost every time the state changes.
  if (state.recording && state.startedAt && s !== 'recording') {
    state.elapsedBase += Date.now() - state.startedAt;
  }
  state.recording = s === 'recording';
  state.paused = s === 'paused';
  state.startedAt = state.recording ? Date.now() : 0;
  if (state.recording && wasPaused) state.lastAudibleAt = Date.now();
  if (s === 'stopped' && state.stream && !state.testingMic) stopCapture();

  els.btnRecord.disabled = state.recording || state.paused || s === 'processing';
  els.btnPause.disabled = !(state.recording || state.paused);
  els.btnStop.disabled = !(state.recording || state.paused || s === 'processing');
  els.btnPause.textContent = t(state.paused ? '继续' : '暂停');
  els.btnRecord.textContent = '● ' + t(state.recording ? '录音中' : '开始录音');
  els.includeSystemAudio.disabled = state.recording || state.paused || s === 'processing';
  els.btnTestMicrophone.disabled = state.recording || state.paused || s === 'processing';

  if (state.recording) els.levelHint.textContent = '正在聆听…';
  els.timer.textContent = fmtClock(tickBase());
  // Tells the shell to hold a wake lock and flag the tray as recording.
  if (desktop) desktop.setRecording(state.recording);
}

function tickBase() {
  return state.recording && state.startedAt
    ? state.elapsedBase + (Date.now() - state.startedAt)
    : state.elapsedBase;
}

// --------------------------------------------------------------------------
// transcript rendering
// --------------------------------------------------------------------------

function buildSegmentEl(seg) {
  const time = h('div', {
    class: 'seg-time',
    text: fmtClock(seg.start),
    title: '点击跳转到音频位置',
    onclick: () => seek(seg.start),
  });
  const spk = h('div', {
    class: 'seg-speaker',
    text: seg.speaker || t('说话人'),
    title: '点击重命名说话人',
    onclick: () => renameSpeaker(seg.speaker),
  });
  const body = h('div', { class: 'seg-body' }, h('div', { class: 'seg-text', text: seg.text }));
  const el = h('div', { class: 'seg', dataset: { index: seg.index } }, time, spk, body);
  return el;
}

function appendSegment(seg) {
  els.transcriptEmpty.hidden = true;
  const el = buildSegmentEl(seg);
  state.segmentEls.set(seg.index, el);
  els.transcript.append(el);
  scrollTranscript();
}

function updateSegmentElement(seg) {
  const el = state.segmentEls.get(seg.index);
  if (!el) return;
  const body = el.querySelector('.seg-body');
  const existing = body.querySelector('.seg-tr');
  if (seg.translation) {
    if (existing) existing.textContent = seg.translation;
    else body.append(h('div', { class: 'seg-tr', text: seg.translation }));
  } else if (existing) {
    existing.remove();
  }
  if (seg.speaker) el.querySelector('.seg-speaker').textContent = seg.speaker;
}

function renderAllSegments() {
  els.transcript.querySelectorAll('.seg').forEach((n) => n.remove());
  state.segmentEls.clear();
  clearLive();
  if (!state.segments.length) {
    els.transcriptEmpty.hidden = false;
    updateCounts();
    return;
  }
  els.transcriptEmpty.hidden = true;
  for (const seg of state.segments) {
    const el = buildSegmentEl(seg);
    state.segmentEls.set(seg.index, el);
    els.transcript.append(el);
    if (seg.translation) updateSegmentElement(seg);
  }
  updateCounts();
  scrollTranscript();
}

function clearLive() {
  if (state.liveEl) {
    state.liveEl.remove();
    state.liveEl = null;
  }
}

function renderLive(evt) {
  els.transcriptEmpty.hidden = true;
  if (!state.liveEl) {
    state.liveEl = h(
      'div',
      { class: 'seg live' },
      h('div', { class: 'seg-time', text: fmtClock(evt.start) }),
      h('div', { class: 'seg-speaker', text: t('识别中') }),
      h('div', { class: 'seg-body' }, h('div', { class: 'seg-text' })),
    );
    els.transcript.append(state.liveEl);
  }
  state.liveEl.querySelector('.seg-text').textContent = evt.text;
  state.liveEl.querySelector('.seg-time').textContent = fmtClock(evt.start);
  scrollTranscript();
}

function scrollTranscript() {
  const nearBottom =
    els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight < 160;
  if (nearBottom) els.transcript.scrollTop = els.transcript.scrollHeight;
}

function updateCounts() {
  els.segCount.textContent = state.segments.length + ' ' + t('条') + ' · ' + fmtClock(Math.max(tickBase(), lastEnd()));
}

function lastEnd() {
  const last = state.segments[state.segments.length - 1];
  return last ? last.end : 0;
}

function seek(ms) {
  if (!els.player.src) return;
  els.player.currentTime = Math.max(0, ms / 1000);
  els.player.play().catch(() => {});
}

async function renameSpeaker(from) {
  const to = prompt('把这个说话人改成什么名字？', from === '说话人1' ? '' : from);
  if (!to || to === from) return;
  send({ type: 'rename-speaker', from, to });
  for (const seg of state.segments) if (seg.speaker === from) seg.speaker = to;
  for (const [, el] of state.segmentEls) {
    const chip = el.querySelector('.seg-speaker');
    if (chip && chip.textContent === from) chip.textContent = to;
  }
}

// --------------------------------------------------------------------------
// minutes / qa / speakers / stats
// --------------------------------------------------------------------------

function renderMinutes(m) {
  if (!m) return;
  const wrap = h('div', { class: 'minutes' });
  if (m.title) wrap.append(h('h4', { text: m.title }));
  if (m.abstract) wrap.append(h('p', { class: 'abstract', text: m.abstract }));
  if (Array.isArray(m.participants) && m.participants.length) {
    wrap.append(h('h4', { text: t('参与人') }));
    wrap.append(h('div', { class: 'kw' }, m.participants.map((p) => h('span', { text: String(p) }))));
  }
  if (Array.isArray(m.decisions) && m.decisions.length) {
    wrap.append(h('h4', { text: t('关键决议') }));
    wrap.append(
      h(
        'ul',
        null,
        m.decisions.map((d) =>
          h('li', { text: typeof d === 'string' ? d : d.decision + (d.context ? '（' + d.context + '）' : '') }),
        ),
      ),
    );
  }
  if (Array.isArray(m.actionItems) && m.actionItems.length) {
    wrap.append(h('h4', { text: t('待办事项') }));
    const rows = m.actionItems.map((a) =>
      h(
        'tr',
        null,
        h('td', { text: a.task || '' }),
        h('td', { text: a.owner || t('待定') }),
        h('td', { text: a.due || t('未定') }),
      ),
    );
    wrap.append(
      h(
        'table',
        { class: 'todo' },
        h('thead', null, h('tr', null, h('th', { text: t('事项') }), h('th', { text: t('负责人') }), h('th', { text: t('截止') }))),
        h('tbody', null, rows),
      ),
    );
  }
  if (Array.isArray(m.risks) && m.risks.length) {
    wrap.append(h('h4', { text: t('风险与分歧') }));
    wrap.append(
      h('ul', null, m.risks.map((r) => h('li', { text: typeof r === 'string' ? r : r.risk + (r.impact ? '（' + r.impact + '）' : '') }))),
    );
  }
  if (Array.isArray(m.openQuestions) && m.openQuestions.length) {
    wrap.append(h('h4', { text: t('待确认问题') }));
    wrap.append(h('ul', null, m.openQuestions.map((q) => h('li', { text: String(q) }))));
  }
  if (Array.isArray(m.chapters) && m.chapters.length) {
    wrap.append(h('h4', { text: t('章节') }));
    wrap.append(
      h(
        'ul',
        null,
        m.chapters.map((c) => h('li', null, h('strong', { text: (c.start ? c.start + ' ' : '') + (c.title || '') }), h('div', { text: c.summary || '' }))),
      ),
    );
  }
  if (Array.isArray(m.keywords) && m.keywords.length) {
    wrap.append(h('h4', { text: t('关键词') }));
    wrap.append(h('div', { class: 'kw' }, m.keywords.map((k) => h('span', { text: String(k) }))));
  }
  els.minutesBody.replaceChildren(wrap);
  els.minutesMeta.textContent = t('生成于') + ' ' + new Date(m.generatedAt || Date.now()).toLocaleTimeString(state.uiLanguage === 'zh' ? 'zh-CN' : state.uiLanguage) + ' · ' + (m.model || '');
}

function renderAnswer(entry) {
  const item = h(
    'div',
    { class: 'qa-item' },
    h('div', { class: 'qa-q', text: entry.question }),
    h('div', { class: 'qa-a', text: entry.answer }),
  );
  els.qaLog.append(item);
  els.qaLog.scrollTop = els.qaLog.scrollHeight;
}

function renderSpeakers(speakers) {
  const entries = Object.values(speakers || {});
  if (!entries.length) {
    els.speakerList.replaceChildren(h('p', { class: 'muted small', text: t('还没有识别出说话人。') }));
    return;
  }
  els.speakerList.replaceChildren(
    ...entries.map((s) =>
      h(
        'div',
        { class: 'speaker-row' },
        h('input', {
          value: s.name,
          onchange: (e) => send({ type: 'rename-speaker', from: s.name, to: e.target.value.trim() || s.name }),
        }),
      ),
    ),
  );
}

function renderStats(stats) {
  if (!stats) return;
  const s = stats;
  const rows = [
    ['语音识别调用', (s.asrCalls || 0) + ' ' + t('次')],
    ['识别音频时长', fmtClock((s.asrSeconds || 0) * 1000)],
    ['识别耗时', (Math.round((s.asrMs || 0) / 100) / 10) + ' ' + t('秒')],
    ['识别费用', (Math.round((s.asrCost || 0) * 10000) / 10000) + ' ' + (s.asrCostCurrency || '')],
    ['文本模型调用', (s.llmCalls || 0) + ' ' + t('次')],
    ['文本耗时', (Math.round((s.llmMs || 0) / 100) / 10) + ' ' + t('秒')],
    ['翻译片段', (s.translateHits || 0) + ' ' + t('条')],
    ['输入 / 输出 token', (s.promptTokens || 0) + ' / ' + (s.completionTokens || 0)],
  ];
  els.statsList.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: t(k) }), h('dd', { text: v })]));
}

function refreshStats(stats) {
  if (!stats) return;
  if (state.meeting) state.meeting.stats = stats;
  renderStats(stats);
}

function updateExportLinks(id) {
  document.querySelectorAll('[data-export]').forEach((a) => {
    a.href = '/api/meetings/' + id + '/export?format=' + a.dataset.export;
  });
}

// --------------------------------------------------------------------------
// level meter
// --------------------------------------------------------------------------

function pushLevel(rms) {
  state.bars.push(rms);
  if (state.bars.length > 160) state.bars.shift();
  if (state.testingMic) state.micTestPeak = Math.max(state.micTestPeak, rms);
  if (state.recording && !state.paused) {
    if (rms >= 0.003) state.lastAudibleAt = Date.now();
    else if (Date.now() - state.lastAudibleAt > 10000 && Date.now() - state.quietWarningAt > 15000) {
      state.quietWarningAt = Date.now();
      showBanner('输入音量持续过低。请检查麦克风选择、系统输入音量和电脑播放声音。', 'warn');
    }
  }
  drawMeter();
}

function drawMeter() {
  const c = els.meter;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 400;
  const hgt = c.clientHeight || 40;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(hgt * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);

  const n = state.bars.length;
  const barW = w / n;
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim() || '#2f6df6';
  const idle = style.getPropertyValue('--border').trim() || '#ddd';

  // threshold guide
  ctx.fillStyle = idle;
  ctx.fillRect(0, hgt - 1, w, 1);

  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.sqrt(state.bars[i]) * 2.5);
    const bh = Math.max(1, v * (hgt - 6));
    ctx.fillStyle = state.bars[i] >= 0.003 ? accent : idle;
    ctx.fillRect(i * barW, hgt - bh, Math.max(1, barW - 1), bh);
  }
}

// --------------------------------------------------------------------------
// audio capture
// --------------------------------------------------------------------------

const MIC_STORAGE_KEY = 'miaoji-microphone-device';

function saveMicrophonePreference(deviceId, label = '') {
  state.savedMicLabel = deviceId === 'default' ? '' : label;
  localStorage.setItem(MIC_STORAGE_KEY, deviceId);
  if (desktop?.setMicrophonePreference) {
    desktop.setMicrophonePreference({ deviceId, label: state.savedMicLabel,
      includeSystemAudio: els.includeSystemAudio.checked }).catch((err) => {
      showBanner('麦克风已选择，但保存偏好失败：' + err.message, 'warn');
    });
  }
}

async function refreshMicrophones(requestPermission = false) {
  const media = navigator.mediaDevices;
  if (!media?.enumerateDevices) {
    els.microphoneStatus.textContent = t('此环境不支持设备列表');
    return;
  }
  if (!state.listeningDeviceChanges && media.addEventListener) {
    media.addEventListener('devicechange', () => {
      if (state.microphoneListLoaded || state.stream) refreshMicrophones().catch(() => {});
    });
    state.listeningDeviceChanges = true;
  }
  let selected = els.microphone.value || 'default';
  if (requestPermission && !state.stream) {
    // Device labels are hidden until the browser has microphone permission.
    let probe;
    try {
      probe = await media.getUserMedia({
        audio: selected === 'default' ? true : { deviceId: { exact: selected } },
      });
    } catch (err) {
      if (selected === 'default') throw err;
      probe = await media.getUserMedia({ audio: true });
    }
    probe.getTracks().forEach((track) => track.stop());
  }
  const inputs = (await media.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  state.microphoneListLoaded = true;
  const named = inputs.filter((device) => device.deviceId && device.deviceId !== 'default');
  state.micLabels = new Map(named.map((device) => [device.deviceId, device.label]));
  if (selected !== 'default' && !named.some((device) => device.deviceId === selected) && state.savedMicLabel) {
    const sameName = named.find((device) => device.label === state.savedMicLabel);
    if (sameName) {
      selected = sameName.deviceId;
      saveMicrophonePreference(selected, sameName.label);
    }
  }
  const options = [h('option', { value: 'default', text: t('系统默认麦克风') })];
  named.forEach((device, index) => {
    options.push(h('option', { value: device.deviceId, text: device.label || '麦克风 ' + (index + 1) }));
  });
  const missing = selected !== 'default' && !named.some((device) => device.deviceId === selected);
  if (missing && (!requestPermission || state.stream)) {
    options.push(h('option', { value: selected, text: '已保存的麦克风（尚未检测到）' }));
  }
  els.microphone.replaceChildren(...options);
  if (missing && requestPermission && !state.stream) {
    els.microphone.value = 'default';
    saveMicrophonePreference('default');
    showBanner('之前选择的麦克风未找到，已切换到系统默认。', 'warn');
  } else {
    els.microphone.value = selected;
  }
  if (!state.stream) {
    els.microphoneStatus.textContent = inputs.some((device) => device.label)
      ? t('找到') + ' ' + named.length + ' ' + t('个麦克风')
      : t('点击“刷新设备”显示名称');
  }
  return !missing;
}

function microphoneError(err) {
  if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return '麦克风权限被拒绝，请在系统或浏览器设置中允许访问。';
  if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return '所选麦克风未找到，请刷新设备列表并重新选择。';
  if (err.name === 'NotReadableError') return '麦克风无法打开，可能正被其他程序占用。';
  return err.message || String(err);
}

function disposeCapture(capture) {
  try {
    if (capture.worklet) {
      if (capture.worklet.port) capture.worklet.port.postMessage({ type: 'mute', value: true });
      capture.worklet.disconnect();
    }
  } catch {
    /* nothing useful to do */
  }
  try {
    if (capture.stream) capture.stream.getTracks().forEach((track) => track.stop());
  } catch {
    /* the context still needs closing */
  }
  try {
    if (capture.audioCtx) capture.audioCtx.close();
  } catch {
    /* already closed */
  }
}

async function startCapture(deviceId = els.microphone.value) {
  const audio = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
  const next = { stream: null, audioCtx: null, worklet: null };
  try {
    next.stream = await navigator.mediaDevices.getUserMedia({ audio });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    next.audioCtx = new Ctx({ sampleRate: 16000 });
    if (next.audioCtx.state === 'suspended') await next.audioCtx.resume();
    const mixed = next.audioCtx.createGain();
    next.audioCtx.createMediaStreamSource(next.stream).connect(mixed);
    if (state.systemStream) {
      const system = next.audioCtx.createGain();
      system.gain.value = 0.7;
      next.audioCtx.createMediaStreamSource(state.systemStream).connect(system).connect(mixed);
    }

    if (next.audioCtx.audioWorklet) {
      await next.audioCtx.audioWorklet.addModule('/pcm-worklet.js');
      const node = new AudioWorkletNode(next.audioCtx, 'pcm-capture');
      node.port.onmessage = (e) => {
        if (state.stream !== next.stream) return;
        const frame = e.data;
        if (state.recording && state.ws?.readyState === WebSocket.OPEN) state.ws.send(frame.buffer);
        let sum = 0;
        for (let i = 0; i < frame.length; i += 4) {
          const v = frame[i] / 32768;
          sum += v * v;
        }
        pushLevel(Math.sqrt(sum / Math.ceil(frame.length / 4)));
      };
      mixed.connect(node);
      // Pull the graph without echoing the microphone through the speakers.
      const mute = next.audioCtx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(next.audioCtx.destination);
      if (state.paused) node.port.postMessage({ type: 'mute', value: true });
      next.worklet = node;
    } else {
      const proc = next.audioCtx.createScriptProcessor(2048, 1, 1);
      let carry = new Float32Array(0);
      proc.onaudioprocess = (e) => {
        if (state.stream !== next.stream) return;
        const input = e.inputBuffer.getChannelData(0);
        const merged = new Float32Array(carry.length + input.length);
        merged.set(carry, 0);
        merged.set(input, carry.length);
        let off = 0;
        while (merged.length - off >= 1024) {
          const out = new Int16Array(1024);
          for (let i = 0; i < 1024; i++) {
            const s = state.paused ? 0 : Math.max(-1, Math.min(1, merged[off + i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          if (state.recording && state.ws?.readyState === WebSocket.OPEN) state.ws.send(out.buffer);
          let power = 0;
          for (let i = 0; i < out.length; i += 4) power += (out[i] / 32768) ** 2;
          pushLevel(Math.sqrt(power / (out.length / 4)));
          off += 1024;
        }
        carry = merged.slice(off);
      };
      mixed.connect(proc);
      proc.connect(next.audioCtx.destination);
      next.worklet = proc;
    }

    const old = { stream: state.stream, audioCtx: state.audioCtx, worklet: state.worklet };
    state.stream = next.stream;
    state.audioCtx = next.audioCtx;
    state.worklet = next.worklet;
    state.activeMicId = deviceId || 'default';
    disposeCapture(old);
    const track = next.stream.getAudioTracks()[0];
    els.microphoneStatus.textContent = '已连接：' + (track?.label || '所选麦克风');
    saveMicrophonePreference(state.activeMicId, track?.label || state.micLabels.get(state.activeMicId) || '');
    track?.addEventListener('ended', () => {
      if (state.stream === next.stream) {
        els.microphoneStatus.textContent = '麦克风已断开';
        showBanner('麦克风已断开，请刷新设备并选择另一个。', 'error');
      }
    });
    refreshMicrophones().catch(() => {});
  } catch (err) {
    disposeCapture(next);
    throw new Error(microphoneError(err));
  }
}

function stopCapture() {
  disposeCapture({ stream: state.stream, audioCtx: state.audioCtx, worklet: state.worklet });
  state.systemStream?.getTracks().forEach((track) => track.stop());
  state.systemStream = null;
  state.worklet = null;
  state.stream = null;
  state.audioCtx = null;
  state.activeMicId = null;
  els.microphoneStatus.textContent = '未连接';
  for (let i = 0; i < state.bars.length; i++) state.bars[i] = 0;
  drawMeter();
}

function systemAudioError(err) {
  if (err?.name === 'NotAllowedError') return '电脑声音采集未获授权。请允许屏幕共享，或取消勾选「同时录电脑声音」。';
  return '无法采集电脑声音：' + (err?.message || String(err));
}

async function openSystemAudio() {
  if (!els.includeSystemAudio.checked) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (!stream.getAudioTracks().length) throw new Error('系统未提供音频轨道，请检查电脑的播放设备。');
    state.systemStream = stream;
    const onEnded = () => {
      if (state.systemStream === stream && state.recording) showBanner('电脑声音采集已中断，请结束录音后重新开始。', 'error');
    };
    stream.getTracks().forEach((track) => track.addEventListener('ended', onEnded));
  } catch (err) {
    stream?.getTracks().forEach((track) => track.stop());
    throw new Error(systemAudioError(err));
  }
}

async function toggleMicrophoneTest() {
  if (state.testingMic) {
    state.testingMic = false;
    stopCapture();
    els.btnTestMicrophone.textContent = t('测试麦克风');
    els.microphoneStatus.textContent = state.micTestPeak >= 0.003
      ? '测试通过：检测到声音' : '音量过低：请换麦克风或提高输入音量';
    return;
  }
  state.testingMic = true;
  state.micTestPeak = 0;
  try {
    await startCapture();
    els.btnTestMicrophone.textContent = t('结束测试');
    els.microphoneStatus.textContent = '请对着麦克风说话，观察下方音量条';
  } catch (err) {
    state.testingMic = false;
    stopCapture();
    showBanner('麦克风测试失败：' + err.message, 'error');
  }
}

// --------------------------------------------------------------------------
// controls
// --------------------------------------------------------------------------

async function onRecord() {
  try {
    if (state.testingMic) await toggleMicrophoneTest();
    // getDisplayMedia must be requested from the record button's user gesture.
    await openSystemAudio();
    if (els.microphone.value !== 'default' && !(await refreshMicrophones(true))) {
      throw new Error('所选麦克风未找到，请刷新设备列表并重新选择。');
    }
    if (!state.meeting || state.meeting.state === 'stopped') {
      const created = await createMeeting({
        title: els.title.value || DEFAULT_TITLE,
        language: els.language.value,
        translateTo: els.translateTo.value,
      });
      await openMeeting(created.id);
    }
    await startCapture();
    state.lastAudibleAt = Date.now();
    state.quietWarningAt = 0;
    send({ type: 'start', title: els.title.value, language: els.language.value, translateTo: els.translateTo.value });
  } catch (err) {
    showBanner('无法开始录音：' + err.message, 'error');
    stopCapture();
  }
}

async function onStop() {
  send({ type: 'stop' });
  stopCapture();
  els.btnStop.disabled = true;
  // The server renders minutes on stop; give it a moment then refresh stats.
  setTimeout(() => {
    send({ type: 'stats' });
  }, 1500);
}

async function openMeeting(id) {
  const res = await fetch('/api/meetings/' + id);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  connect(id);
  applyMeeting(json.meeting);
  // Recording and import commands must not race the new socket handshake.
  const ws = state.ws;
  if (ws.readyState !== WebSocket.OPEN) {
    await new Promise((resolve, reject) => {
      if (ws.readyState >= WebSocket.CLOSING) return reject(new Error('会议连接已关闭'));
      const timer = setTimeout(() => finish(new Error('会议连接超时')), 10000);
      const onOpen = () => finish();
      const onFail = () => finish(new Error('会议连接失败'));
      const finish = (err) => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onFail);
        ws.removeEventListener('close', onFail);
        if (err) reject(err);
        else resolve();
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onFail);
      ws.addEventListener('close', onFail);
    });
  }
}

/**
 * Desktop: ask the shell for a native file dialog and hand the server the
 * path. Shipping a multi-gigabyte recording through IPC would be wasteful, so
 * the server reads it straight off disk.
 */
async function pickFileToImport() {
  if (!desktop) {
    els.fileInput.click();
    return;
  }
  try {
    const filePath = await desktop.pickFile();
    if (filePath) await importByPath(filePath);
  } catch (err) {
    showBanner('导入失败：' + err.message, 'error');
  }
}

async function importByPath(filePath) {
  const name = filePath.split(/[\\/]/).pop() || '导入的文件';
  let meetingId = state.meeting && state.meeting.state !== 'stopped' ? state.meeting.id : null;
  if (!meetingId) {
    const created = await createMeeting({
      title: name.replace(/\.[^.]+$/, '') || DEFAULT_TITLE,
      language: els.language.value,
      translateTo: els.translateTo.value,
      source: 'upload',
    });
    meetingId = created.id;
    await openMeeting(meetingId);
  }
  els.levelHint.textContent = '正在导入 ' + name + ' …';
  const res = await fetch('/api/meetings/' + meetingId + '/import-path', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  els.levelHint.textContent = '已开始后台转写，进度会实时显示。';
}

function onUpload(file) {
  if (!file) return;
  const id = state.meeting && state.meeting.state !== 'stopped' ? state.meeting.id : null;
  (async () => {
    let meetingId = id;
    if (!meetingId) {
      const created = await createMeeting({
        title: file.name.replace(/\.[^.]+$/, '') || DEFAULT_TITLE,
        language: els.language.value,
        translateTo: els.translateTo.value,
        source: 'upload',
      });
      meetingId = created.id;
      await openMeeting(meetingId);
    }
    els.levelHint.textContent = '正在上传 ' + file.name + ' …';
    const res = await fetch('/api/meetings/' + meetingId + '/import?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    els.levelHint.textContent = '已开始后台转写，进度会实时显示。';
  })().catch((err) => showBanner('上传失败：' + err.message, 'error'));
}

function bindControls() {
  els.uiLanguage.onchange = () => {
    state.uiLanguage = els.uiLanguage.value;
    localStorage.setItem('miaoji-ui-language', state.uiLanguage);
    updateUiLanguage();
    if (!els.drawer.hidden) {
      if (els.drawer.dataset.view === 'settings') rebuildDrawer(openSettings).catch(() => {});
      else if (els.drawer.dataset.view === 'history') rebuildDrawer(openHistory).catch(() => {});
    }
  };
  els.btnRecord.onclick = onRecord;
  els.btnStop.onclick = onStop;
  els.btnTestMicrophone.onclick = toggleMicrophoneTest;
  els.includeSystemAudio.onchange = () => saveMicrophonePreference(
    els.microphone.value, state.micLabels.get(els.microphone.value) || state.savedMicLabel);
  els.microphone.onchange = async () => {
    const selected = els.microphone.value;
    if (!state.stream) {
      saveMicrophonePreference(selected, state.micLabels.get(selected) || '');
      els.microphoneStatus.textContent = selected === 'default' ? '将使用系统默认麦克风' : '已选择麦克风';
      return;
    }
    const previous = state.activeMicId;
    els.microphone.disabled = true;
    try {
      await startCapture(selected);
      showBanner('已切换麦克风：' + (state.stream.getAudioTracks()[0]?.label || '所选设备'));
    } catch (err) {
      els.microphone.value = previous;
      showBanner('切换麦克风失败：' + err.message, 'error');
    } finally {
      els.microphone.disabled = false;
    }
  };
  els.btnRefreshMicrophones.onclick = async () => {
    els.btnRefreshMicrophones.disabled = true;
    try {
      await refreshMicrophones(true);
    } catch (err) {
      showBanner('无法读取麦克风列表：' + microphoneError(err), 'error');
    } finally {
      els.btnRefreshMicrophones.disabled = false;
    }
  };
  // Enumerating devices during startup launches Chromium's audio and video
  // services even when the user only wants to read an old meeting. Populate
  // the list on first use; the saved choice stays visible meanwhile.
  els.microphone.addEventListener('focus', () => {
    if (!state.microphoneListLoaded) refreshMicrophones().catch(() => {});
  });
  els.btnPause.onclick = () => {
    // The microphone stays open and keeps sending frames; the worklet just
    // emits silence while paused, which keeps the recording timeline intact.
    const muted = !state.paused;
    if (state.worklet && state.worklet.port) {
      state.worklet.port.postMessage({ type: 'mute', value: muted });
    }
    send({ type: state.paused ? 'resume' : 'pause' });
  };
  els.btnUpload.onclick = () => pickFileToImport();
  els.fileInput.onchange = () => {
    onUpload(els.fileInput.files[0]);
    els.fileInput.value = '';
  };

  els.title.onchange = () => send({ type: 'config-patch', title: els.title.value });
  els.language.onchange = () => {
    send({ type: 'config-patch', language: els.language.value });
    applyStatus(state.status);
  };
  els.translateTo.onchange = () => send({ type: 'config-patch', translateTo: els.translateTo.value });

  els.btnResummarize.onclick = () => send({ type: 'summarize' });
  els.btnMinutes.onclick = () => {
    els.minutesMeta.textContent = '正在生成…';
    send({ type: 'minutes' });
  };
  const resplit = () => {
    if (!state.segments.length) return showBanner('还没有转写内容。', 'warn');
    showBanner('正在用语言线索推断说话人…');
    send({ type: 'resplit-speakers' });
  };
  els.btnResplit.onclick = resplit;
  $('#btnResplitHead').onclick = resplit;

  els.qaForm.onsubmit = (e) => {
    e.preventDefault();
    const q = els.qaInput.value.trim();
    if (!q) return;
    renderAnswer({ question: q, answer: '思考中…' });
    send({ type: 'ask', question: q });
    els.qaInput.value = '';
  };

  // drag & drop anywhere
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) onUpload(f);
  });

  // tabs
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.tab-panel').forEach((p) =>
        p.classList.toggle('active', p.dataset.panel === b.dataset.tab),
      );
      if (b.dataset.tab === 'stats') send({ type: 'stats' });
    };
  });

  // theme
  const savedTheme = localStorage.getItem('miaoji-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  els.btnTheme.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('miaoji-theme', next);
    drawMeter();
  };

  els.btnHistory.onclick = () => (els.drawer.hidden ? openHistory() : closeDrawer());
  els.btnSettings.onclick = () => (els.drawer.hidden ? openSettings() : closeDrawer());

  // A modal with no way out is a trap: provide all three conventional exits.
  els.drawerClose.onclick = () => closeDrawer();
  els.drawer.addEventListener('mousedown', (e) => {
    // mousedown (not click) so a drag that ends outside doesn't close it.
    if (e.target === els.drawer) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.drawer.hidden) closeDrawer();
  });

  if (desktop) {
    // The global shortcut and the tray both funnel through here.
    desktop.onToggleRecord(() => {
      if (state.recording || state.paused) onStop();
      else onRecord();
    });
    desktop.onImport(() => pickFileToImport());
  }

  window.addEventListener('beforeunload', () => {
    if (state.recording) send({ type: 'stop' });
  });
}

// --------------------------------------------------------------------------
// drawer: history + settings
// --------------------------------------------------------------------------

function openDrawer(title) {
  els.drawerTitle.textContent = title;
  els.drawer.hidden = false;
  els.drawerBody.replaceChildren();
  document.body.classList.add('drawer-open');
  return els.drawerBody;
}

function closeDrawer() {
  els.drawer.hidden = true;
  document.body.classList.remove('drawer-open');
}

/**
 * Rebuild the drawer without losing the reader's place. Toggling a switch and
 * being thrown back to the top is the difference between "it works" and "I
 * cannot change anything" once the list is taller than the card.
 */
async function rebuildDrawer(render) {
  const previous = els.drawerBody.scrollTop;
  await render();
  els.drawerBody.scrollTop = previous;
}

async function openHistory() {
  const body = openDrawer(t('会议历史'));
  els.drawer.dataset.view = 'history';
  body.append(h('div', { class: 'row', onclick: () => startNewMeeting() },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title', text: '＋ ' + t('新建会议') }),
      h('div', { class: 'row-sub', text: t('开始一次新的录音') }))));

  const res = await fetch('/api/meetings');
  const json = await res.json();
  const list = json.meetings || [];
  if (!list.length) {
    body.append(h('div', { class: 'section' }, h('p', { class: 'muted', text: t('还没有任何会议记录。') })));
    return;
  }
  for (const m of list) {
    const row = h('div', { class: 'row' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title', text: m.title || t(DEFAULT_TITLE) }),
        h('div', { class: 'row-sub', text: (m.preview || '') + (m.hasMinutes ? '  · ' + t('已有纪要') : '') })),
      h('div', { class: 'row-meta', text: fmtClock(m.durationMs) }),
      h('button', { class: 'btn tiny danger', text: t('删除'), onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(t('删除这次会议？'))) return;
        await fetch('/api/meetings/' + m.id, { method: 'DELETE' });
        closeDrawer();
        openHistory();
      } }));
    row.onclick = async () => {
      closeDrawer();
      await openMeeting(m.id);
    };
    body.append(row);
  }
}

async function startNewMeeting() {
  closeDrawer();
  const created = await createMeeting({
    title: t(DEFAULT_TITLE),
    language: els.language.value,
    translateTo: els.translateTo.value,
  });
  await openMeeting(created.id);
  showBanner('已新建会议，点击「开始录音」。');
}

async function openSettings() {
  const body = openDrawer(t('设置'));
  els.drawer.dataset.view = 'settings';
  const boot = await (await fetch('/api/bootstrap?lite=1')).json();
  const s = boot.status;
  state.status = s;

  body.append(
    h('div', { class: 'settings-intro' },
      h('strong', { text: t('自定义引擎') }),
      h('p', { text: t('密钥保存在本机，不会显示原文。') + ' ' + t('服务必须由你自行启动；接口地址填写到 /v1，不含具体方法名。') })),
    realtimeSettings(s.realtime),
    h('section', { class: 'settings-section' },
      h('div', { class: 'settings-section-head' }, h('h4', { text: t('语音识别引擎') }), h('span', { text: s.asr.length + ' ASR' })),
      ...s.asr.map((p) => providerCard('asr', p)),
      customProviderForm('asr')),
    h('section', { class: 'settings-section' },
      h('div', { class: 'settings-section-head' }, h('h4', { text: t('按语言路由') })),
      h('div', { class: 'route-grid' }, ...Object.entries(s.routes).flatMap(([lang, selected]) => {
        const label = t({ zh: '中文', en: '英文', ja: '日本語', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', auto: '自动检测' }[lang] || lang);
        const supports = (p) => lang === 'auto' || (p.kind === 'mimo'
          ? ['zh', 'en'].includes(lang)
          : p.languages?.includes(lang) || p.languages?.includes('auto'));
        return [h('label', { text: label }), h('select', {
          onchange: (e) => settingsAction(() => patchConfig({ asr: { routes: { [lang]: e.target.value } } }), '设置已保存'),
        }, ...s.asr.map((p) => h('option', {
          value: p.name, selected: p.name === selected, disabled: !supports(p),
          text: p.label + (supports(p) ? '' : ' · ' + lang + ' ✕'),
        })))];
      }))),
    h('section', { class: 'settings-section' },
      h('div', { class: 'settings-section-head' }, h('h4', { text: t('文本模型') }), h('span', { text: s.llm.length + ' LLM' })),
      ...s.llm.map((p) => providerCard('llm', p)),
      customProviderForm('llm')),
    h('section', { class: 'settings-section' },
      h('div', { class: 'settings-section-head' }, h('h4', { text: t('任务模型') })),
      ...Object.entries(s.roles).map(([roleName, role]) => {
        const provider = h('select', {}, ...s.llm.map((p) => h('option', {
          value: p.name, selected: p.name === role.provider, text: p.label + (p.ready && p.enabled ? '' : ' ⚠'),
        })));
        const model = h('input', { value: role.model, placeholder: 'model-id', spellcheck: false });
        const roleLabel = { summary: '摘要', minutes: '纪要', translate: '翻译', ask: '回答' }[roleName] || roleName;
        return h('div', { class: 'role-row' }, h('strong', { text: t(roleLabel) }), provider, model,
          h('button', { class: 'btn tiny', text: t('保存'), onclick: () => settingsAction(
            () => patchConfig({ llm: { roles: { [roleName]: { provider: provider.value, model: model.value.trim() } } } }), '设置已保存') }));
      })),
    h('section', { class: 'settings-section' },
      h('div', { class: 'settings-section-head' }, h('h4', { text: t('界面外观') })),
      h('label', { class: 'settings-field' }, h('span', { text: t('界面外观') }),
        h('select', { onchange: (e) => {
          if (e.target.value === 'auto') {
            document.documentElement.removeAttribute('data-theme');
            localStorage.removeItem('miaoji-theme');
          } else {
            document.documentElement.dataset.theme = e.target.value;
            localStorage.setItem('miaoji-theme', e.target.value);
          }
          drawMeter();
        } }, ...[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([value, label]) =>
          h('option', { value, selected: value === (localStorage.getItem('miaoji-theme') || 'auto'), text: t(label) }))))),
  );
}

function realtimeSettings(realtime) {
  const specs = [
    ['stepMs', '预览发送间隔（秒）', 2, 60],
    ['silenceMs', '停顿定稿时间（秒）', 0.4, 3],
    ['maxUtteranceMs', '最长单句（秒）', 10, 60],
    ['overlapMs', '硬切衔接音频（秒）', 0, 3],
  ];
  const inputs = Object.fromEntries(specs.map(([key, label, min, max]) => [key,
    h('input', { type: 'number', min, max, step: 0.1, value: ((realtime[key] ?? 0) / 1000).toFixed(1),
      'aria-label': t(label) })]));
  return h('section', { class: 'settings-section' },
    h('div', { class: 'settings-section-head' }, h('h4', { text: t('实时识别节奏') })),
    h('div', { class: 'settings-grid' }, ...specs.map(([key, label]) => settingsField(label, inputs[key]))),
    h('p', { class: 'settings-note', text: t('预览按间隔更新；停顿后立即定稿。长句优先等停顿，必须硬切时用重叠音频衔接。Groq 预览最短为 10 秒。') }),
    h('button', { class: 'btn tiny primary', text: t('保存配置'), onclick: () => {
      const patch = {};
      for (const [key] of specs) {
        const value = Number(inputs[key].value);
        if (!Number.isFinite(value) || inputs[key].value === '') return showBanner(t('请输入有效的时间数值'), 'error');
        patch[key] = Math.round(value * 1000);
      }
      settingsAction(() => patchConfig({ realtime: patch }), '设置已保存');
    } }),
  );
}

function settingsField(label, input) {
  return h('label', { class: 'settings-field' }, h('span', { text: t(label) }), input);
}

async function settingsAction(action, success) {
  try {
    const result = await action();
    if (result?.status) state.status = result.status;
    await rebuildDrawer(openSettings);
    applyStatus(state.status);
    showBanner(t(success));
  } catch (err) { showBanner(err.message, 'error'); }
}

function providerCard(category, provider) {
  const id = category + '-' + provider.name;
  const card = h('div', { class: 'prov-block setting-card' });
  const enabled = h('input', { type: 'checkbox', checked: provider.enabled !== false, 'aria-label': t('启用') + ' ' + provider.label,
    onchange: (e) => settingsAction(() => patchConfig({ [category]: { providers: { [provider.name]: { enabled: e.target.checked } } } }), '设置已保存') });
  const badge = provider.noAuth ? t('无需 API Key') : provider.hasKey ? t('密钥已配置') : t('需要密钥');
  card.append(h('div', { class: 'provider-head' }, enabled,
    h('div', { class: 'provider-heading' }, h('strong', { text: provider.label }),
      h('small', { text: provider.name + ' · ' + provider.kind + (provider.model ? ' · ' + provider.model : '') })),
    h('span', { class: 'badge ' + (provider.ready ? 'ok' : 'miss'), text: badge })));

  const label = h('input', { value: provider.label, maxLength: 120 });
  const baseUrl = h('input', { value: provider.baseUrl, type: 'url', spellcheck: false });
  const noAuth = h('input', { type: 'checkbox', checked: provider.noAuth,
    disabled: !['openai-audio', 'openai-chat'].includes(provider.kind) });
  const model = category === 'asr' ? h('input', { value: provider.model || '', spellcheck: false }) : null;
  const languages = category === 'asr' ? h('input', { value: (provider.languages || []).join(', '), spellcheck: false }) : null;
  const kind = provider.custom ? h('select', { onchange: (e) => {
    noAuth.disabled = !['openai-audio', 'openai-chat'].includes(e.target.value);
    if (noAuth.disabled) noAuth.checked = false;
    if (category === 'asr' && e.target.value === 'mimo') languages.value = 'zh, en';
  } }, ...(category === 'asr'
    ? [['openai-audio', 'OpenAI Audio'], ['deepgram', 'Deepgram'], ['mimo', 'MiMo']]
    : [['openai-chat', 'OpenAI Chat']]).map(([value, text]) =>
    h('option', { value, selected: value === provider.kind, text }))) : null;
  const key = h('input', { type: 'password', placeholder: provider.keyRef || 'API Key', autocomplete: 'new-password', spellcheck: false });
  const modelList = h('div', { class: 'model-list' });
  const saveProvider = () => settingsAction(() => patchConfig({ [category]: { providers: { [provider.name]: {
    label: label.value.trim(), baseUrl: baseUrl.value.trim().replace(/\/+$/, ''), noAuth: noAuth.checked,
    ...(kind ? { kind: kind.value } : {}),
    ...(category === 'asr' ? { model: model.value.trim(), languages: languages.value.split(/[\s,，]+/).filter(Boolean) } : {}),
  } } } }), '设置已保存');
  const details = h('details', { class: 'provider-details', open: state.settingsOpen.has(id),
    ontoggle: (e) => { if (e.target.open) state.settingsOpen.add(id); else state.settingsOpen.delete(id); } },
    h('summary', { text: t('连接设置') }),
    h('div', { class: 'settings-grid' },
      settingsField('引擎名称', label), kind ? settingsField('协议', kind) : null,
      settingsField('接口地址', baseUrl), category === 'asr' ? settingsField('模型名称', model) : null,
      category === 'asr' ? settingsField('支持语言', languages) : null,
      h('label', { class: 'settings-check' }, noAuth, t('无需 API Key'))),
    h('div', { class: 'settings-actions' },
      h('button', { class: 'btn tiny primary', text: t('保存配置'), onclick: saveProvider }),
      category === 'llm' ? h('button', { class: 'btn tiny', text: t('查看模型'), onclick: async () => {
        modelList.textContent = t('连接中…');
        try {
          const response = await fetch('/api/providers/llm/' + provider.name + '/models');
          const data = await response.json();
          if (data.error) throw new Error(data.error);
          modelList.replaceChildren(...data.models.map((name) => h('code', { text: name })));
          if (!data.models.length) modelList.textContent = t('没有返回模型，请手动填写模型 ID。');
        } catch (err) { modelList.textContent = err.message; }
      } }) : null,
      provider.custom ? h('button', { class: 'btn tiny danger', text: t('移除'), onclick: () => {
        if (!confirm(t('删除这个自定义引擎？'))) return;
        settingsAction(async () => {
          const res = await fetch('/api/providers/' + category + '/' + provider.name, { method: 'DELETE' });
          const json = await res.json();
          if (json.error) throw new Error(json.error);
          state.settingsOpen.delete(id);
          return json;
        }, '引擎已移除');
      } }) : null),
    category === 'llm' ? modelList : null,
    h('div', { class: 'key-row' }, key,
      h('button', { class: 'btn tiny', text: t(provider.hasKey ? '更新密钥' : '保存密钥'), onclick: () => {
        if (!key.value.trim()) return showBanner(t('请先粘贴 API Key。'), 'warn');
        settingsAction(() => setCredential(provider.keyRef, key.value.trim()), '密钥已保存');
      } }),
      h('button', { class: 'btn tiny ghost', text: t('清除本机密钥'), onclick: () =>
        settingsAction(() => setCredential(provider.keyRef, ''), '本机密钥已清除') })));
  card.append(details);
  return card;
}

function customProviderForm(category) {
  const id = 'new-' + category;
  const label = h('input', { placeholder: category === 'asr' ? 'Local Whisper' : 'Local LLM', maxLength: 120 });
  const baseUrl = h('input', { type: 'url', value: category === 'asr' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:11434/v1', spellcheck: false });
  const model = category === 'asr' ? h('input', { value: 'whisper-1', spellcheck: false }) : null;
  const languages = category === 'asr' ? h('input', { value: 'zh, ja, en, auto', spellcheck: false }) : null;
  const key = h('input', { type: 'password', placeholder: 'API Key (' + t('无需 API Key') + ')', autocomplete: 'new-password' });
  const noAuth = h('input', { type: 'checkbox', checked: true });
  const kind = category === 'asr' ? h('select', { onchange: (e) => {
    noAuth.disabled = e.target.value !== 'openai-audio';
    if (noAuth.disabled) noAuth.checked = false;
    if (e.target.value === 'mimo') languages.value = 'zh, en';
  } },
    h('option', { value: 'openai-audio', text: 'OpenAI Audio' }),
    h('option', { value: 'deepgram', text: 'Deepgram' }),
    h('option', { value: 'mimo', text: 'MiMo' })) : null;
  const details = h('details', { class: 'add-provider', open: state.settingsOpen.has(id),
    ontoggle: (e) => { if (e.target.open) state.settingsOpen.add(id); else state.settingsOpen.delete(id); } },
    h('summary', { text: '+ ' + t(category === 'asr' ? '新增语音引擎' : '新增文本引擎') }),
    h('div', { class: 'settings-grid' }, settingsField('引擎名称', label), kind ? settingsField('协议', kind) : null,
      settingsField('接口地址', baseUrl), model ? settingsField('模型名称', model) : null,
      languages ? settingsField('支持语言', languages) : null,
      settingsField('保存密钥', key), h('label', { class: 'settings-check' }, noAuth, t('无需 API Key'))),
    h('button', { class: 'btn tiny primary', text: t('新增'), onclick: () => settingsAction(async () => {
      const name = 'custom_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      const keyRef = 'MIAOJI_' + category.toUpperCase() + '_' + name.slice(7).toUpperCase() + '_KEY';
      const provider = {
        kind: kind?.value || 'openai-chat', label: label.value.trim(), enabled: true,
        baseUrl: baseUrl.value.trim().replace(/\/+$/, ''), keyRef, noAuth: noAuth.checked,
        ...(category === 'asr' ? { model: model.value.trim(), languages: languages.value.split(/[\s,，]+/).filter(Boolean), pricePerHour: 0, currency: 'USD' } : {}),
      };
      const result = await patchConfig({ [category]: { providers: { [name]: provider } } });
      if (key.value.trim()) await setCredential(keyRef, key.value.trim());
      state.settingsOpen.delete(id);
      state.settingsOpen.add(category + '-' + name);
      return result;
    }, '引擎已添加') }));
  return details;
}

async function setCredential(name, value) {
  const res = await fetch('/api/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, value }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

async function patchConfig(patch) {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------

async function boot() {
  bindControls();
  const requestedUi = new URLSearchParams(location.search).get('ui');
  if (['zh', 'ja', 'en'].includes(requestedUi)) state.uiLanguage = requestedUi;
  if (!['zh', 'ja', 'en'].includes(state.uiLanguage)) state.uiLanguage = 'zh';
  els.uiLanguage.value = state.uiLanguage;
  updateUiLanguage();
  let desktopPreference = null;
  try {
    desktopPreference = await desktop?.getMicrophonePreference?.();
  } catch {
    /* browser storage remains available */
  }
  const savedMicrophone = desktopPreference?.deviceId || localStorage.getItem(MIC_STORAGE_KEY);
  const systemSupported = desktop?.platform === 'win32' || (!desktop && !!navigator.mediaDevices?.getDisplayMedia);
  els.systemAudioField.hidden = !systemSupported;
  els.includeSystemAudio.checked = systemSupported && (desktopPreference?.includeSystemAudio ?? desktop?.platform === 'win32');
  state.savedMicLabel = desktopPreference?.label || '';
  if (savedMicrophone && savedMicrophone !== 'default') {
    els.microphone.append(h('option', { value: savedMicrophone, text: '已保存的麦克风' }));
    els.microphone.value = savedMicrophone;
  }
  els.microphoneStatus.textContent = t('点击“刷新设备”显示名称');
  drawMeter();
  setInterval(() => {
    els.timer.textContent = fmtClock(tickBase());
  }, 1000);

  els.connState.dataset.state = 'off';
  els.connState.textContent = t('待机');

  // Show provider readiness before the first meeting exists.
  try {
    const res = await fetch('/api/bootstrap?lite=1');
    const boot = await res.json();
    state.status = boot.status;
    applyStatus(boot.status, boot.status.asr.filter((p) => p.enabled && p.ready).map((p) => p.name));
    if (!boot.hasMeetings && els.banner.hidden) {
      showBanner(t('可在设置中选择语音与文本模型，并配置本地服务。'));
    }
  } catch {
    /* server not reachable yet */
  }

  // Deep links: ?meeting=<id> opens a meeting, ?settings=1 and ?history=1
  // open the matching drawer (also makes these states screenshot-able).
  const params = new URLSearchParams(location.search);
  const id = params.get('meeting');
  if (id) await openMeeting(id).catch(() => {});
  if (params.get('history') === '1') await openHistory();
  if (params.get('settings') === '1') await openSettings();
}

if (new URLSearchParams(location.search).has('selftest')) {
  window.miaojiSelfTest = { state, startCapture, stopCapture, toggleMicrophoneTest };
}

boot();
