// app.js — the 巴别回声 client.
//
// Plain ES modules, no framework. Everything is driven by one WebSocket to
// the server: control messages go up as JSON, audio goes up as binary
// Int16 PCM frames, and the server pushes state back down (partial text,
// committed segments, rolling summary, minutes, answers).

import { applyStaticTranslations, translate } from './i18n.js';
import { appearanceSettings } from './appearance-settings.js';
import { TASKS, effectiveAsr, routeRepairs, rolesFor, setupState, supportsLanguage, taskProblems } from './quick-setup.js';
import { renderMarkdownInto, cancelMarkdownRender } from './markdown.js';

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

function renderSummary(text) {
  state.summaryText = text || '';
  renderMarkdownInto(els.summaryBody, state.summaryText, { idPrefix: 'summary-' })
    .catch(() => { els.summaryBody.textContent = state.summaryText; });
}

async function openReader(view = '') {
  try {
    const id = state.meeting?.id;
    if (view && !id) return showBanner(t('请先选择会议'), 'warn');
    if (view === 'summary' && !state.summaryText) return showBanner(t('尚未生成'), 'warn');
    if (window.miaojiDesktop?.openMarkdownReader) {
      let text = view === 'summary' ? state.summaryText : '';
      if (view === 'full') {
        const response = await fetch('/api/meetings/' + id + '/export?format=md&includeTranscript=' + (els.includeTranscript.checked ? '1' : '0'));
        if (!response.ok) throw new Error(t('无法读取会议'));
        text = await response.text();
      }
      await window.miaojiDesktop.openMarkdownReader({ text, title: view ? els.title.value : t('Markdown 阅读器'), language: state.uiLanguage });
    } else {
      const query = new URLSearchParams({ ui: state.uiLanguage });
      if (view) { query.set('meeting', id); query.set('view', view); }
      query.set('includeTranscript', els.includeTranscript.checked ? '1' : '0');
      window.open('/reader.html?' + query, '_blank', 'noopener,noreferrer');
    }
  } catch (error) { showBanner(error.message, 'error'); }
}

// --------------------------------------------------------------------------
// state
// --------------------------------------------------------------------------

const state = {
  uiLanguage: localStorage.getItem('miaoji-ui-language') || 'zh',
  meeting: null,
  summaryText: '',
  segments: [],
  segmentEls: new Map(),
  liveEl: null,
  ws: null,
  retry: 0,
  // Audio captured while the socket reconnects; the server is the only
  // place a browser recording is saved, so it must not be dropped.
  pendingAudio: [],
  pendingAudioBytes: 0,
  droppedAudioBytes: 0,
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
  nextStepFor: null,
  minutesPending: false,
  speakerMenu: null,
  settingsWarning: '',
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
  btnReader: $('#btnReader'),
  btnReadSummary: $('#btnReadSummary'),
  btnReadMinutes: $('#btnReadMinutes'),
  noteMode: $('#noteMode'),
  notesDetail: $('#notesDetail'),
  includeTranscript: $('#includeTranscript'),
  exportMenu: $('#exportMenu'),
  exportEmpty: $('#exportEmpty'),
  btnMoreOptions: $('#btnMoreOptions'),
  moreOptions: $('#moreOptions'),
  autoMinutes: $('#autoMinutes'),
  nextStep: $('#nextStep'),
  btnResummarize: $('#btnResummarize'),
  btnMinutes: $('#btnMinutes'),
  btnResplit: $('#btnResplit'),
  btnDiarize: $('#btnDiarize'),
  btnUndoDiarize: $('#btnUndoDiarize'),
};

const DEFAULT_TITLE = '未命名会议';

// Present only inside the Electron shell (see desktop/preload.cjs). When it
// is absent every desktop-only path falls back to plain browser behaviour.
const desktop = (typeof window !== 'undefined' && window.miaojiDesktop) || null;
const t = (key) => translate(key, state.uiLanguage);

function updateUiLanguage() {
  applyStaticTranslations(state.uiLanguage);
  document.title = t('巴别回声') + ' — ' + t('AI 会议记录工作台');
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
  updateNoteLabels();
  updateExportLinks(state.meeting?.id);
  renderNextStep();
}

// --------------------------------------------------------------------------
// banner
// --------------------------------------------------------------------------

// Problems the user fixes in settings: missing keys, unusable engines.
const SETTINGS_HINT = /密钥|API Key|引擎|模型服务|キー|エンジン|provider|\bkey\b|401|403/i;

function showBanner(message, kind) {
  els.banner.hidden = !message;
  els.banner.dataset.kind = kind || 'info';
  els.banner.replaceChildren(h('span', { text: message || '' }));
  if (message && ['error', 'warn'].includes(kind) && SETTINGS_HINT.test(message)) {
    els.banner.append(h('button', { type: 'button', class: 'btn tiny', text: t('去设置'), onclick: () => openSettings('quick') }));
  }
}

// --------------------------------------------------------------------------
// next step after a recording or import ends
// --------------------------------------------------------------------------

function showNextStep() {
  state.nextStepFor = state.meeting?.id || null;
  renderNextStep();
}

function renderNextStep() {
  const m = state.meeting;
  const card = els.nextStep;
  if (!m || state.nextStepFor !== m.id || m.state !== 'stopped') {
    card.hidden = true;
    return;
  }
  const classroom = els.noteMode.value === 'class';
  const notesLabel = classroom ? '课程笔记' : '纪要';
  const openTab = (tab) => document.querySelector(`.tabs button[data-tab="${tab}"]`)?.click();
  const minutes = state.minutesPending
    ? h('button', { type: 'button', class: 'btn primary tiny', disabled: true, text: t('正在生成' + notesLabel + '…') })
    : m.minutes
      ? h('button', { type: 'button', class: 'btn primary tiny', text: t('查看' + notesLabel), onclick: () => openTab('minutes') })
      : h('button', { type: 'button', class: 'btn primary tiny', text: t('生成' + notesLabel), onclick: () => {
        if (!state.segments.length) return showBanner(t('还没有转写内容。'), 'warn');
        requestMinutes();
      } });
  const diarize = !els.btnDiarize.hidden
    ? h('button', { type: 'button', class: 'btn tiny', text: t('整场校正说话人'), onclick: diarizeSpeakers })
    : null;
  card.hidden = false;
  card.replaceChildren(
    h('div', { class: 'next-step-text' },
      h('strong', { text: t('录音已结束') }),
      h('span', { class: 'muted small', text: fmtClock(m.durationMs || state.elapsedBase) + ' · ' + state.segments.length + ' ' + t('条') })),
    h('div', { class: 'next-step-actions' },
      minutes, diarize,
      h('button', { type: 'button', class: 'btn tiny', text: t('导出'), onclick: () => {
        els.exportMenu.open = true;
        els.exportMenu.querySelector('a:not([hidden])')?.focus();
      } }),
      h('button', { type: 'button', class: 'btn tiny', text: t('新建会议'), onclick: () => startNewMeeting() }),
      h('button', { type: 'button', class: 'btn ghost icon tiny', 'aria-label': t('关闭'), text: '×', onclick: () => {
        state.nextStepFor = null;
        renderNextStep();
      } })));
}

function requestMinutes() {
  state.minutesPending = true;
  els.minutesMeta.textContent = t('正在生成…');
  send({ type: 'minutes' });
  renderNextStep();
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
  // Buffered audio belongs to the meeting it was captured for.
  if (state.wsMeetingId !== meetingId) clearPendingAudio();
  state.wsMeetingId = meetingId;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/ws?meeting=' + encodeURIComponent(meetingId);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) return;
    state.retry = 0;
    flushPendingAudio();
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
    } else if (state.recording) {
      // The server stops an abandoned recording shortly after this; keep the
      // UI honest instead of pretending the capture is still being saved.
      clearPendingAudio();
      stopCapture();
      applyState('stopped');
      showBanner(t('与本机服务的连接已断开，录音已停止。断开前的内容已保存，可在历史记录中查看。'), 'error');
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

// About five minutes of 16 kHz mono Int16 audio.
const MAX_PENDING_AUDIO_BYTES = 16000 * 2 * 300;

function flushPendingAudio() {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || !state.pendingAudio.length) return;
  for (const buffer of state.pendingAudio.splice(0)) ws.send(buffer);
  state.pendingAudioBytes = 0;
  if (state.droppedAudioBytes) {
    const seconds = Math.round(state.droppedAudioBytes / 32000);
    showBanner(t('连接中断时间过长，约 ') + seconds + t(' 秒录音未能保存'), 'warn');
    state.droppedAudioBytes = 0;
  }
}

/** Send one captured PCM frame, buffering it while the socket reconnects. */
function sendAudio(buffer) {
  if (!state.recording) return;
  const ws = state.ws;
  if (ws?.readyState === WebSocket.OPEN) {
    if (state.pendingAudio.length) flushPendingAudio();
    ws.send(buffer);
    return;
  }
  state.pendingAudio.push(buffer);
  state.pendingAudioBytes += buffer.byteLength;
  while (state.pendingAudioBytes > MAX_PENDING_AUDIO_BYTES && state.pendingAudio.length) {
    const dropped = state.pendingAudio.shift();
    state.pendingAudioBytes -= dropped.byteLength;
    state.droppedAudioBytes += dropped.byteLength;
  }
}

function clearPendingAudio() {
  state.pendingAudio = [];
  state.pendingAudioBytes = 0;
  state.droppedAudioBytes = 0;
}

async function createMeeting(opts) {
  const res = await fetch('/api/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: els.noteMode.value, notesDetail: els.notesDetail.value, ...(opts || {}) }),
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
        // Updates carry either a translation or a sentence that grew.
        if ('translation' in evt) seg.translation = evt.translation;
        if ('text' in evt) seg.text = evt.text;
        if ('end' in evt) seg.end = evt.end;
        if ('open' in evt) seg.open = evt.open;
        if ('speaker' in evt) seg.speaker = evt.speaker;
        updateSegmentElement(seg);
        if ('speaker' in evt) renderSpeakers(state.meeting?.speakers);
      }
      break;
    }

    case 'partial':
      renderLive(evt);
      break;

    case 'summary':
      if (state.meeting) { state.meeting.summary = evt.summary; state.meeting.summaryMode = evt.summaryMode; }
      renderSummary(evt.summary);
      els.summaryMeta.textContent = '已更新 · ' + new Date().toLocaleTimeString('zh-CN');
      break;

    case 'summary-pending':
      els.summaryMeta.textContent = '正在总结…';
      break;

    case 'minutes-pending':
      state.minutesPending = true;
      els.minutesMeta.textContent = t('正在生成…');
      renderNextStep();
      break;

    case 'minutes':
      state.minutesPending = false;
      renderMinutes(evt.minutes);
      renderNextStep();
      // Native toast when the shell has our attention elsewhere.
      if (desktop) desktop.notify('巴别回声 · 纪要已生成', els.title.value || '会议纪要');
      break;

    case 'answer':
      renderAnswer(evt);
      break;

    case 'speakers':
      if (state.meeting) {
        state.meeting.speakers = evt.speakers;
        if ('speakerBackup' in evt) state.meeting.speakerBackup = evt.speakerBackup;
      }
      renderSpeakers(evt.speakers);
      updateDiarizeButtons();
      break;

    case 'diarize-pending':
      showBanner(t('正在用整段录音校正说话人…'));
      break;

    case 'diarize-done':
      showBanner(t('说话人已校正') + '：' + evt.speakers + ' ' + t('位说话人') + ' · ' + evt.changed + ' ' + t('段有变化'));
      break;

    case 'meta':
      if (evt.title) els.title.value = evt.title;
      if (state.meeting) Object.assign(state.meeting, evt);
      if (evt.mode) els.noteMode.value = evt.mode;
      if (evt.notesDetail) els.notesDetail.value = evt.notesDetail;
      updateNoteLabels();
      break;

    case 'status': {
      const was = state.meeting?.state;
      applyState(evt.state);
      // A recording or import that just ended offers what to do next.
      if (evt.state === 'stopped' && ['recording', 'paused', 'processing'].includes(was)) showNextStep();
      else renderNextStep();
      if (evt.state === 'stopped' && state.importDone !== null) {
        els.levelHint.textContent = '导入完成，共 ' + state.importDone + ' 条';
      }
      break;
    }

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
        state.meeting.audio = evt.audio;
        updateDiarizeButtons();
        els.playerWrap.hidden = false;
        els.player.src = '/api/meetings/' + state.meeting.id + '/audio?v=' + Date.now();
      }
      break;

    case 'stats':
      refreshStats(evt.stats);
      break;

    case 'error':
      showBanner(evt.message, evt.fatal ? 'error' : 'warn');
      if (evt.minutes && state.minutesPending) {
        // A failed minutes run leaves them retryable from the card.
        state.minutesPending = false;
        els.minutesMeta.textContent = t('尚未生成');
        renderNextStep();
      }
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
  state.minutesPending = false;
  closeSpeakerMenu();
  state.segments = m.segments || [];
  els.title.value = m.title || t(DEFAULT_TITLE);
  els.language.value = m.language || 'auto';
  els.noteMode.value = m.mode || 'meeting';
  els.notesDetail.value = m.notesDetail || 'detailed';
  updateNoteLabels();
  els.translateTo.value = m.translateTo || '';
  state.recording = false;
  state.startedAt = 0;
  state.elapsedBase = m.durationMs || 0;
  applyState(m.state);
  renderAllSegments();
  cancelMarkdownRender(els.summaryBody);
  state.summaryText = m.summary || '';
  els.summaryBody.innerHTML = '<p class="muted">会议开始后，摘要会每隔一段时间自动刷新。</p>';
  els.summaryMeta.textContent = '尚未生成';
  if (m.summary) {
    renderSummary(m.summary);
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
  updateNoteLabels();
  renderSpeakers(m.speakers);
  updateDiarizeButtons();
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
  if (s === 'stopped') clearPendingAudio();

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
  updateDiarizeButtons();
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
    title: t('点击更改说话人'),
    role: 'button',
    tabIndex: 0,
    onclick: (e) => openSpeakerMenu(seg.index, e.currentTarget),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSpeakerMenu(seg.index, e.currentTarget); } },
  });
  const body = h('div', { class: 'seg-body' }, h('div', { class: 'seg-text', text: seg.text }));
  const el = h('div', { class: 'seg', dataset: { index: seg.index } }, time, spk, body);
  // An unfinished sentence may still grow; it is translated once complete.
  el.classList.toggle('open', !!seg.open);
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
  body.querySelector('.seg-text').textContent = seg.text;
  el.classList.toggle('open', !!seg.open);
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

function speakerNamesInUse() {
  const names = new Map();
  for (const seg of state.segments) if (seg.speaker) names.set(seg.speaker, (names.get(seg.speaker) || 0) + 1);
  for (const s of Object.values(state.meeting?.speakers || {})) if (!names.has(s.name)) names.set(s.name, 0);
  return names;
}

function closeSpeakerMenu() {
  state.speakerMenu?.remove();
  state.speakerMenu = null;
}

/**
 * One sentence's speaker: move it to another speaker, a new one, or rename
 * this speaker everywhere (renaming to an existing name merges the two).
 * Inline rather than prompt(), which Electron does not implement.
 */
function openSpeakerMenu(index, anchor) {
  closeSpeakerMenu();
  const seg = state.segments.find((s) => s.index === index);
  if (!seg) return;
  const names = speakerNamesInUse();
  const current = seg.speaker || '';
  const setSpeaker = (name) => {
    closeSpeakerMenu();
    if (name && name !== current) send({ type: 'set-segment-speaker', index, speaker: name });
  };
  const fresh = h('input', { placeholder: t('新说话人名字'), maxLength: 60,
    onkeydown: (e) => { if (e.key === 'Enter') setSpeaker(fresh.value.trim()); } });
  const rename = h('input', { value: current, maxLength: 60, 'aria-label': t('重命名'),
    onkeydown: (e) => { if (e.key === 'Enter') renameAll(); } });
  const renameAll = () => {
    const to = rename.value.trim();
    closeSpeakerMenu();
    if (!to || to === current) return;
    if (names.has(to) && !confirm(t('已有同名说话人，两者会合并。继续吗？'))) return;
    send({ type: 'rename-speaker', from: current, to });
  };
  const menu = h('div', { class: 'speaker-menu', role: 'dialog', 'aria-label': t('更改说话人') },
    h('div', { class: 'speaker-menu-title', text: t('这句话的说话人') }),
    h('div', { class: 'speaker-menu-list' }, ...[...names.keys()].map((name) => h('button', {
      type: 'button', class: 'btn tiny' + (name === current ? ' primary' : ''), text: name,
      'aria-pressed': String(name === current), onclick: () => setSpeaker(name) }))),
    h('div', { class: 'speaker-menu-row' }, fresh,
      h('button', { type: 'button', class: 'btn tiny', text: t('设为新说话人'), onclick: () => setSpeaker(fresh.value.trim()) })),
    current ? h('div', { class: 'speaker-menu-title', text: t('重命名「') + current + t('」（共 ') + (names.get(current) || 0) + t(' 句）') }) : null,
    current ? h('div', { class: 'speaker-menu-row' }, rename,
      h('button', { type: 'button', class: 'btn tiny primary', text: t('全部改名'), onclick: renameAll })) : null);
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 16);
  menu.style.width = width + 'px';
  menu.style.left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8)) + 'px';
  const below = box.bottom + 6;
  menu.style.top = (below + menu.offsetHeight > window.innerHeight ? Math.max(8, box.top - menu.offsetHeight - 6) : below) + 'px';
  state.speakerMenu = menu;
  menu.querySelector('button')?.focus();
}

function renameSpeaker(from, to) {
  to = String(to || '').trim();
  if (!from || !to || to === from) return;
  if (speakerNamesInUse().has(to) && !confirm(t('已有同名说话人，两者会合并。继续吗？'))) return renderSpeakers(state.meeting?.speakers);
  send({ type: 'rename-speaker', from, to });
}

// --------------------------------------------------------------------------
// minutes / qa / speakers / stats
// --------------------------------------------------------------------------

function renderMinutes(m) {
  if (!m) return;
  if (state.meeting) state.meeting.minutes = m;
  const wrap = h('div', { class: 'minutes' });
  if (m.title) wrap.append(h('h4', { text: m.title }));
  if (m.abstract) wrap.append(h('p', { class: 'abstract', text: m.abstract }));
  for (const topic of Array.isArray(m.topics) ? m.topics : []) {
    if (!topic || typeof topic !== 'object') continue;
    wrap.append(h('h4', { text: topic.title || t('内容详解') }));
    if (topic.detail) wrap.append(h('p', { text: topic.detail }));
    if (Array.isArray(topic.points)) wrap.append(h('ul', null, topic.points.map((p) => h('li', { text: String(p) }))));
  }
  for (const [key, heading, name, detail] of [
    ['keyConcepts', '核心概念与公式', 'term', 'explanation'],
    ['examples', '例题与案例', 'title', 'explanation'],
    ['reviewQuestions', '复习问答', 'question', 'answer'],
  ]) {
    if (!Array.isArray(m[key]) || !m[key].length) continue;
    wrap.append(h('h4', { text: t(heading) }));
    for (const item of m[key]) if (item && typeof item === 'object') wrap.append(h('p', null, h('strong', { text: item[name] || '' }), h('br'), document.createTextNode(item[detail] || '')));
  }
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
  updateNoteLabels();
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

/** Whole-recording correction needs a finished meeting with saved audio. */
function updateDiarizeButtons() {
  const m = state.meeting;
  const finished = !!m && !state.recording && !state.paused && els.statePill.dataset.state === 'stopped';
  els.btnDiarize.hidden = !(finished && m.audio && state.segments.length);
  els.btnUndoDiarize.hidden = !(finished && m.speakerBackup);
}

async function diarizeSpeakers() {
  const m = state.meeting;
  if (!m) return;
  let provider = null;
  try {
    const config = await (await fetch('/api/config')).json();
    provider = config.asr?.providers?.[config.speakers?.provider || 'deepgram'];
  } catch { /* the server reports a missing engine itself */ }
  const hours = (m.durationMs || 0) / 3600000;
  const cost = provider?.pricePerHour ? ' ≈ ' + (Math.ceil(hours * provider.pricePerHour * 100) / 100) + ' ' + (provider.currency || '') : '';
  const question = t('将把整段录音发送给 Deepgram 重新区分说话人，按音频时长计费一次') + cost + '。' +
    t('转写文字和翻译不变，可以撤销。继续吗？');
  if (!confirm(question)) return;
  send({ type: 'diarize-speakers' });
}

function renderSpeakers(speakers) {
  const entries = Object.values(speakers || {});
  if (!entries.length) {
    els.speakerList.replaceChildren(h('p', { class: 'muted small', text: t('还没有识别出说话人。') }));
    return;
  }
  const counts = speakerNamesInUse();
  const names = [...new Set(entries.map((s) => s.name))];
  els.speakerList.replaceChildren(
    ...names.map((name) =>
      h(
        'div',
        { class: 'speaker-row' },
        h('input', {
          value: name, maxLength: 60, 'aria-label': t('重命名') + ' ' + name,
          onchange: (e) => renameSpeaker(name, e.target.value),
        }),
        h('span', { class: 'muted small', text: (counts.get(name) || 0) + ' ' + t('句') }),
        names.length > 1 ? h('select', { 'aria-label': t('合并到'), onchange: (e) => {
          if (e.target.value) renameSpeaker(name, e.target.value);
          e.target.value = '';
        } }, h('option', { value: '', text: t('合并到…') }),
        ...names.filter((other) => other !== name).map((other) => h('option', { value: other, text: other }))) : null,
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
    ['文本请求（含重试）', (s.llmCalls || 0) + ' ' + t('次')],
    ['文本耗时', (Math.round((s.llmMs || 0) / 100) / 10) + ' ' + t('秒')],
    ['翻译片段', (s.translateHits || 0) + ' ' + t('条')],
    ['输入 / 输出 token', (s.promptTokens || 0) + ' / ' + (s.completionTokens || 0)],
    ['其中思考 token（服务返回）', s.reasoningReportedCalls ? String(s.reasoningTokens || 0) : t('未单独报告')],
    ['缓存命中输入 token', String(s.cachedInputTokens || 0)],
    ['未返回完整用量的请求', String(s.llmUnreportedCalls || 0)],
  ];
  for (const [task, usage] of Object.entries(s.llmByTask || {})) {
    const label = { summary: '摘要', translate: '翻译', minutes: '纪要', ask: '回答', speakers: 'AI 分角色' }[task] || task;
    rows.push([label, (usage.calls || 0) + ' ' + t('次') + ' · ' + (usage.promptTokens || 0) + ' / ' + (usage.completionTokens || 0) + ' token']);
  }
  if (s.historicalUsageIncomplete || (s.llmCalls && !s.tokenStatsVersion)) rows.push(['用量说明', t('旧会议用量不完整，仅新增请求按任务统计。')]);
  els.statsList.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: t(k) }), h('dd', { text: v })]));
}

function refreshStats(stats) {
  if (!stats) return;
  if (state.meeting) state.meeting.stats = stats;
  renderStats(stats);
}

function updateExportLinks(id) {
  els.exportEmpty.hidden = !!id;
  els.exportMenu.querySelector('.export-option').hidden = !id;
  document.querySelectorAll('[data-export]').forEach((a) => {
    a.hidden = !id;
    if (!id) return a.removeAttribute('href');
    a.href = '/api/meetings/' + id + '/export?format=' + a.dataset.export;
    if (a.dataset.export === 'md') a.href += '&includeTranscript=' + (els.includeTranscript.checked ? '1' : '0');
  });
}

function updateNoteLabels() {
  const classroom = els.noteMode.value === 'class';
  document.querySelector('[data-tab="minutes"]').textContent = t(classroom ? '课程笔记' : '智能纪要');
  document.querySelector('[data-tab="summary"]').textContent = t(classroom ? '课堂摘要' : '实时摘要');
  const summaryChanged = state.meeting?.summary && (state.meeting.summaryMode || 'meeting') !== els.noteMode.value;
  if (summaryChanged) { els.summaryMeta.textContent = t('场景已切换，请重新总结'); els.summaryMeta.dataset.contextWarning = '1'; }
  else if (els.summaryMeta.dataset.contextWarning) { delete els.summaryMeta.dataset.contextWarning; els.summaryMeta.textContent = t('已恢复'); }
  const minutes = state.meeting?.minutes;
  const minutesChanged = minutes && ((minutes.mode || 'meeting') !== els.noteMode.value || (minutes.notesDetail || 'standard') !== els.notesDetail.value);
  if (minutesChanged) { els.minutesMeta.textContent = t('选项已改变，请重新生成纪要'); els.minutesMeta.dataset.contextWarning = '1'; }
  else if (els.minutesMeta.dataset.contextWarning) { delete els.minutesMeta.dataset.contextWarning; els.minutesMeta.textContent = t('已恢复'); }
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
        sendAudio(frame.buffer);
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
          sendAudio(out.buffer);
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
  if (err?.name === 'NotAllowedError') {
    if (desktop?.platform === 'darwin') return '电脑声音采集未获授权。请在 macOS「系统设置 → 隐私与安全性」中允许屏幕与系统音频录制，然后重新打开应用。';
    return '电脑声音采集未获授权。请允许屏幕共享，或取消勾选「同时录电脑声音」。';
  }
  return '无法采集电脑声音：' + (err?.message || String(err));
}

async function openSystemAudio() {
  if (!els.includeSystemAudio.checked) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (!stream.getAudioTracks().length) throw new Error('系统未提供音频轨道，请检查电脑的播放设备。');
    // Chromium requires a display track to request loopback audio. Keeping it
    // alive wastes GPU/CPU and shows an unnecessary screen-capture indicator;
    // the meeting stores audio only, so stop video as soon as audio exists.
    stream.getVideoTracks().forEach((track) => track.stop());
    state.systemStream = stream;
    const onEnded = () => {
      if (state.systemStream === stream && state.recording) showBanner('电脑声音采集已中断，请结束录音后重新开始。', 'error');
    };
    stream.getAudioTracks().forEach((track) => track.addEventListener('ended', onEnded));
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
  send({ type: 'stop', minutes: els.autoMinutes.checked });
  stopCapture();
  els.btnStop.disabled = true;
  // Give the server a moment to finish, then refresh stats.
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
  els.includeTranscript.onchange = () => {
    try { localStorage.setItem('babel-md-include-transcript', String(els.includeTranscript.checked)); } catch { /* In memory. */ }
    if (state.meeting) updateExportLinks(state.meeting.id);
  };
  for (const control of [els.noteMode, els.notesDetail]) control.onchange = () => {
    if (state.meeting && state.ws?.readyState !== WebSocket.OPEN) {
      els.noteMode.value = state.meeting.mode || 'meeting';
      els.notesDetail.value = state.meeting.notesDetail || 'detailed';
      return showBanner(t('连接断开，请重连后再切换'), 'warn');
    }
    const options = { mode: els.noteMode.value, notesDetail: els.notesDetail.value };
    try { localStorage.setItem('babel-note-options-v1', JSON.stringify(options)); } catch { /* In memory. */ }
    if (state.meeting) {
      send({ type: 'config-patch', ...options });
      showBanner(t('已切换整理选项；已有内容保留，请手动重新生成摘要或纪要。'));
    }
    updateNoteLabels();
  };
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
  els.btnReader.onclick = () => openReader();
  els.btnReadSummary.onclick = () => openReader('summary');
  els.btnReadMinutes.onclick = () => openReader('full');
  els.btnMinutes.onclick = () => requestMinutes();
  const resplit = () => {
    if (!state.segments.length) return showBanner('还没有转写内容。', 'warn');
    showBanner('正在用语言线索推断说话人…');
    send({ type: 'resplit-speakers' });
  };
  els.btnResplit.onclick = resplit;
  $('#btnResplitHead').onclick = resplit;
  els.btnDiarize.onclick = diarizeSpeakers;
  els.btnUndoDiarize.onclick = () => {
    if (!confirm(t('恢复校正前的说话人标注？'))) return;
    send({ type: 'undo-diarize' });
  };

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
  // Light/dark lives in Settings → Appearance; the top bar keeps only navigation.
  els.btnMoreOptions.onclick = () => {
    const open = els.moreOptions.hidden;
    els.moreOptions.hidden = !open;
    els.btnMoreOptions.setAttribute('aria-expanded', String(open));
  };
  els.autoMinutes.onchange = () => {
    try { localStorage.setItem('babel-auto-minutes', String(els.autoMinutes.checked)); } catch { /* In memory. */ }
  };
  // The export menu closes on a choice, an outside click or Escape.
  els.exportMenu.addEventListener('click', (e) => { if (e.target.closest('a[data-export]')) els.exportMenu.open = false; });
  document.addEventListener('mousedown', (e) => {
    if (els.exportMenu.open && !els.exportMenu.contains(e.target)) els.exportMenu.open = false;
    if (state.speakerMenu && !state.speakerMenu.contains(e.target) && !e.target.closest('.seg-speaker')) closeSpeakerMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (els.exportMenu.open) els.exportMenu.open = false;
    closeSpeakerMenu();
  });
  els.transcript.addEventListener('scroll', () => closeSpeakerMenu(), { passive: true });
  window.addEventListener('appearancechange', () => drawMeter());

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

const SETTINGS_TABS = [['quick', '快速设置'], ['advanced', '高级设置'], ['appearance', '外观']];
const SETTINGS_TAB_KEY = 'babel-settings-tab';
const LANGUAGE_LABELS = { zh: '中文', en: '英文', ja: '日本語', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', auto: '自动检测' };
const TASK_LABELS = { summary: '摘要', minutes: '纪要', translate: '翻译', ask: '问答' };

function settingsTab(requested) {
  const known = (tab) => SETTINGS_TABS.some(([id]) => id === tab);
  if (known(requested)) {
    try { localStorage.setItem(SETTINGS_TAB_KEY, requested); } catch { /* per-session only */ }
    return requested;
  }
  try {
    const saved = localStorage.getItem(SETTINGS_TAB_KEY);
    if (known(saved)) return saved;
  } catch { /* storage unavailable */ }
  return 'quick';
}

async function openSettings(requestedTab) {
  const tab = settingsTab(requestedTab);
  const boot = await (await fetch('/api/bootstrap?lite=1')).json();
  const s = boot.status;
  state.status = s;
  const catalog = new Map();
  const body = openDrawer(t('设置'));
  els.drawer.dataset.view = 'settings';
  els.drawer.dataset.settingsTab = tab;
  if (requestedTab) body.scrollTop = 0;

  const tabs = h('div', { class: 'settings-tabs', role: 'tablist', 'aria-label': t('设置') },
    ...SETTINGS_TABS.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: 'settings-tab', 'data-tab': id,
      'aria-selected': String(id === tab), text: t(label), onclick: () => { if (id !== tab) openSettings(id); } })));
  body.append(tabs, tab === 'appearance' ? appearanceSettings(h, t)
    : tab === 'advanced' ? advancedSettings(s, catalog) : quickSettings(s, catalog));
}

// --- quick settings: pick a service, paste a key, done --------------------

const QUICK_NOTES = {
  'asr:mimo': '适合中文和英文会议',
  'asr:groq': '适合日语和多语言，价格最低',
  'asr:deepgram': '能区分说话人，也用于整场说话人校正',
  'asr:local': '免费离线，需要先在本机启动 whisper.cpp 服务',
  'llm:deepseek': '推荐：摘要、纪要、翻译和问答',
  'llm:mimo': '与小米语音识别共用同一个密钥',
  'llm:local': '免费离线，需要先启动 Ollama 或 LM Studio',
};

function priceLabel(p) {
  if (!p.pricePerHour) return '';
  return '≈ ' + (p.currency === 'CNY' ? '¥' : '$') + p.pricePerHour + '/h';
}

function quickSettings(s, catalog) {
  const language = els.language.value || 'auto';
  const overall = setupState(s, language);
  const asrUse = new Map();
  for (const lang of ['zh', 'en', 'ja']) {
    const p = effectiveAsr(s, lang);
    if (p) asrUse.set(p.name, [...(asrUse.get(p.name) || []), t(LANGUAGE_LABELS[lang])]);
  }
  const llmUse = new Map();
  for (const task of TASKS) {
    const name = s.roles[task]?.provider;
    if (!overall.problems.includes(task)) llmUse.set(name, [...(llmUse.get(name) || []), t(TASK_LABELS[task])]);
  }
  const overview = h('div', { class: 'quick-overview', 'data-level': overall.level, role: 'status' },
    h('strong', { text: t(overall.message) }),
    h('dl', {},
      ...['zh', 'en', 'ja'].flatMap((lang) => [h('dt', { text: t(LANGUAGE_LABELS[lang]) }),
        h('dd', { text: effectiveAsr(s, lang)?.label || t('未配置') })]),
      h('dt', { text: t('文本任务') }),
      h('dd', { text: overall.problems.length
        ? t('不可用：') + overall.problems.map((task) => t(TASK_LABELS[task])).join(t('、'))
        : s.llm.find((p) => p.name === s.roles.summary.provider)?.label || '' })));

  return h('div', { class: 'quick-settings' },
    overview,
    h('section', { class: 'settings-section' },
      h('div', { class: 'settings-section-head' }, h('h4', { text: t('1. 语音识别') }), h('span', { text: t('至少配置一个') })),
      h('p', { class: 'settings-note', text: t('粘贴 API Key 后自动启用，并按语言自动选择引擎。') }),
      ...s.asr.map((p) => quickProviderCard('asr', p, s, catalog, asrUse.get(p.name)))),
    h('section', { class: 'settings-section' },
      h('div', { class: 'settings-section-head' }, h('h4', { text: t('2. 文本模型') }), h('span', { text: t('摘要 · 纪要 · 翻译 · 问答') })),
      ...s.llm.map((p) => quickProviderCard('llm', p, s, catalog, llmUse.get(p.name)))),
    quickSpeakers(s),
    h('div', { class: 'quick-footer' },
      h('span', { text: t('密钥保存在本机，不会显示原文。') + ' ' + t('需要自定义接口、调整识别节奏或给每个任务单独选模型？') }),
      h('button', { type: 'button', class: 'btn tiny', text: t('打开高级设置'), onclick: () => openSettings('advanced') })));
}

/** After a provider changes, keep routes and task models pointing at something that works. */
async function settleProviders(category, provider, result) {
  const status = result?.status;
  if (!status) return result;
  if (category === 'asr') {
    const routes = routeRepairs(status);
    if (Object.keys(routes).length) result = await patchConfig({ asr: { routes } });
  } else if (isDeepSeekProvider(provider) && taskProblems(status).length) {
    const fresh = status.llm.find((p) => p.name === provider.name);
    if (fresh?.enabled && fresh.ready) result = await patchConfig({ llm: { roles: rolesFor(provider.name, '', true) } });
  }
  return result;
}

function quickProviderCard(category, p, s, catalog, usedFor) {
  const card = h('div', { class: 'quick-card setting-card', 'data-provider': category + ':' + p.name });
  const status = !p.enabled ? ['off', '未启用'] : p.ready ? ['ok', '已就绪'] : ['miss', '需要密钥'];
  const note = h('small', { class: 'settings-note quick-result', role: 'status' });
  const enable = (on) => settingsAction(async () =>
    settleProviders(category, p, await patchConfig({ [category]: { providers: { [p.name]: { enabled: on } } } })), on ? '已启用' : '已停用');
  const key = h('input', { type: 'password', placeholder: t('粘贴 API Key'), autocomplete: 'new-password', spellcheck: false,
    'aria-label': p.label + ' API Key', onkeydown: (e) => { if (e.key === 'Enter') saveKey(); } });
  const saveKey = () => {
    if (!key.value.trim()) return showBanner(t('请先粘贴 API Key。'), 'warn');
    settingsAction(async () => {
      await setCredential(p.keyRef, key.value.trim());
      return settleProviders(category, p, await patchConfig({ [category]: { providers: { [p.name]: { enabled: true } } } }));
    }, '已保存并启用');
  };
  const keyRow = h('div', { class: 'key-row', hidden: p.noAuth || p.hasKey }, key,
    h('button', { type: 'button', class: 'btn tiny primary', text: t('保存并启用'), onclick: saveKey }));
  const test = async () => {
    note.textContent = t('连接中…');
    delete note.dataset.state;
    try {
      const res = await fetch('/api/providers/' + category + '/' + encodeURIComponent(p.name) + '/models');
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
      note.textContent = t('连接成功') + ' · ' + (data.models || []).length + ' ' + t('个模型');
      note.dataset.state = 'ok';
      if (data.models?.length) catalog.set(category + ':' + p.name + ':' + p.baseUrl, Promise.resolve(data.models));
    } catch (err) {
      note.textContent = err.message + ' — ' + t('部分服务不提供模型列表，失败不一定代表密钥无效。');
      note.dataset.state = 'error';
    }
  };
  const actions = h('div', { class: 'settings-actions' },
    p.enabled ? null : (p.ready ? h('button', { type: 'button', class: 'btn tiny primary', text: t('启用'), onclick: () => enable(true) }) : null),
    p.ready ? h('button', { type: 'button', class: 'btn tiny', text: t('测试连接'), onclick: test }) : null,
    p.hasKey ? h('button', { type: 'button', class: 'btn tiny', text: t('更换密钥'), onclick: () => { keyRow.hidden = false; key.focus(); } }) : null,
    p.enabled ? h('button', { type: 'button', class: 'btn tiny ghost', text: t('停用'), onclick: () => enable(false) }) : null);

  card.append(
    h('div', { class: 'quick-card-head' },
      h('div', { class: 'provider-heading' },
        h('strong', { text: p.label }),
        h('small', { text: [t(QUICK_NOTES[category + ':' + p.name] || (p.custom ? '自定义引擎' : '')), priceLabel(p)].filter(Boolean).join(' · ') })),
      h('span', { class: 'badge ' + status[0], text: t(status[1]) })),
    ...(usedFor?.length ? [h('div', { class: 'quick-used', text: t('用于：') + usedFor.join(t('、')) })] : []),
    keyRow, actions, note);

  // A ready text service the tasks are not using can take all of them at once.
  const tasksElsewhere = TASKS.some((task) => s.roles[task]?.provider !== p.name);
  if (category === 'llm' && p.enabled && p.ready && tasksElsewhere) {
    const deepseek = isDeepSeekProvider(p);
    const picker = deepseek ? null : modelPicker('llm', p, '', catalog);
    const chooser = h('div', { class: 'quick-model', hidden: true },
      picker ? settingsField('选择模型', picker.element) : null,
      h('button', { type: 'button', class: 'btn tiny primary', text: t('确认'), onclick: () => {
        if (!picker.value()) return showBanner(t('输入模型 ID'), 'warn');
        settingsAction(() => patchConfig({ llm: { roles: rolesFor(p.name, picker.value()) } }), '设置已保存');
      } }));
    actions.prepend(h('button', { type: 'button', class: 'btn tiny', text: t('所有任务改用此服务'), onclick: () => {
      if (deepseek) return settingsAction(() => patchConfig({ llm: { roles: rolesFor(p.name, '', true) } }), '设置已保存');
      chooser.hidden = false;
      picker.setProvider(p);
    } }));
    card.append(chooser);
  }
  return card;
}

function quickSpeakers(s) {
  const engine = s.asr.find((p) => p.name === (s.speakers?.provider || 'deepgram'));
  const ready = !!engine && engine.enabled && engine.ready;
  const auto = h('input', { type: 'checkbox', checked: !!s.speakers?.autoDiarize, disabled: !ready && !s.speakers?.autoDiarize,
    'data-field': 'autoDiarize', onchange: (e) => settingsAction(() => patchConfig({ speakers: { autoDiarize: e.target.checked } }), '设置已保存') });
  return h('section', { class: 'settings-section', 'data-settings': 'speakers' },
    h('div', { class: 'settings-section-head' }, h('h4', { text: t('3. 说话人区分（可选）') }),
      h('span', { text: t(ready ? '可用' : '需要 Deepgram 密钥') })),
    h('div', { class: 'quick-card setting-card' },
      h('label', { class: 'settings-check' }, auto, ' ', t('录音或导入结束后自动用整段录音校正说话人')),
      h('small', { class: 'settings-note', text: ready
        ? t('整段录音会再发送给 Deepgram 一次，按时长计费；可在转写区撤销。')
        : t('先在上方配置 Deepgram 密钥（无需设为主要识别引擎）。') })));
}

// --- advanced settings: everything, grouped and collapsed -----------------

function settingsGroup(id, title, meta, ...children) {
  const key = 'group-' + id;
  return h('details', { class: 'settings-section settings-group', 'data-settings': id, open: state.settingsOpen.has(key),
    ontoggle: (e) => { if (e.target.open) state.settingsOpen.add(key); else state.settingsOpen.delete(key); } },
  h('summary', { class: 'settings-section-head' }, h('h4', { text: t(title) }), meta ? h('span', { text: meta }) : null),
  h('div', { class: 'settings-group-body' }, ...children));
}

/** Save on change without rebuilding the drawer, so focus and typing survive. */
async function autosave(status, patch) {
  status.textContent = t('保存中…');
  delete status.dataset.state;
  try {
    const result = await patchConfig(patch);
    if (result?.status) state.status = result.status;
    applyStatus(state.status);
    status.textContent = t('已自动保存');
    status.dataset.state = 'ok';
  } catch (err) {
    status.textContent = err.message;
    status.dataset.state = 'error';
  }
}

function advancedSettings(s, catalog) {
  const readyCount = (list) => list.filter((p) => p.enabled && p.ready).length + '/' + list.length + ' ' + t('可用');
  return h('div', { class: 'advanced-settings' },
    h('div', { class: 'settings-intro' },
      h('strong', { text: t('高级设置') }),
      h('p', { text: t('设置项会自动保存；连接设置和密钥需要点击保存。') + ' ' + t('服务必须由你自行启动；接口地址填写到 /v1，不含具体方法名。') })),
    settingsGroup('asr', '语音识别引擎', readyCount(s.asr),
      ...s.asr.map((p) => providerCard('asr', p, catalog)),
      customProviderForm('asr'),
      h('h5', { class: 'settings-subhead', text: t('按语言路由') }),
      h('div', { class: 'route-grid' }, ...Object.entries(s.routes).flatMap(([lang, selected]) => [
        h('label', { text: t(LANGUAGE_LABELS[lang] || lang) }), h('select', {
          onchange: (e) => settingsAction(() => patchConfig({ asr: { routes: { [lang]: e.target.value } } }), '设置已保存'),
        }, ...s.asr.map((p) => h('option', {
          value: p.name, selected: p.name === selected, disabled: !supportsLanguage(p, lang),
          text: p.label + (supportsLanguage(p, lang) ? '' : ' · ' + lang + ' ✕') + (p.enabled && p.ready ? '' : ' · ' + t('不可用')),
        })))]))),
    settingsGroup('llm', '文本模型与任务', readyCount(s.llm),
      ...s.llm.map((p) => providerCard('llm', p, catalog)),
      customProviderForm('llm'),
      h('h5', { class: 'settings-subhead', text: t('任务模型') }),
      h('p', { class: 'settings-note', text: t('为每个任务选择服务和模型；列表不可用时可手动输入模型 ID。思考开关仅适用于 DeepSeek 官方接口。') }),
      ...Object.entries(s.roles).map(([roleName, role]) => taskModelSettings(roleName, role, s.llm, catalog))),
    realtimeSettings(s.realtime),
    summarySettings(s.summary),
    speakerSettings(s.speakers, s.asr));
}

function realtimeSettings(realtime) {
  const specs = [
    ['stepMs', '预览发送间隔（秒）', 2, 60],
    ['silenceMs', '停顿定稿时间（秒）', 0.4, 3],
    ['maxUtteranceMs', '最长单句（秒）', 10, 60],
    ['overlapMs', '硬切衔接音频（秒）', 0, 3],
  ];
  const status = h('small', { class: 'settings-note autosave-state', role: 'status' });
  const save = () => {
    const patch = {};
    for (const [key] of specs) {
      const value = Number(inputs[key].value);
      if (!Number.isFinite(value) || inputs[key].value === '' || !inputs[key].checkValidity()) {
        status.textContent = t('请输入有效的时间数值');
        status.dataset.state = 'error';
        return;
      }
      patch[key] = Math.round(value * 1000);
    }
    autosave(status, { realtime: patch });
  };
  const inputs = Object.fromEntries(specs.map(([key, label, min, max]) => [key,
    h('input', { type: 'number', min, max, step: 0.1, value: ((realtime[key] ?? 0) / 1000).toFixed(1),
      'aria-label': t(label), onchange: save })]));
  return settingsGroup('realtime', '实时识别节奏', null,
    h('div', { class: 'settings-grid' }, ...specs.map(([key, label]) => settingsField(label, inputs[key]))),
    h('p', { class: 'settings-note', text: t('预览按间隔更新；停顿后立即定稿。长句优先等停顿，必须硬切时用重叠音频衔接。Groq 预览最短为 10 秒。') }),
    status);
}

function summarySettings(summary = {}) {
  const specs = [
    ['autoMs', '自动摘要间隔（秒，0 为关闭）', 0, 3600, (summary.autoMs ?? 180000) / 1000],
    ['minNewChars', '自动摘要最少新增字数', 0, 10000, summary.minNewChars ?? 200],
    ['maxChars', '摘要目标字数', 200, 3000, summary.maxChars ?? 900],
  ];
  const status = h('small', { class: 'settings-note autosave-state', role: 'status' });
  const save = () => {
    if (specs.some(([key]) => !inputs[key].value || !inputs[key].checkValidity())) {
      status.textContent = t('请输入有效的时间数值');
      status.dataset.state = 'error';
      return;
    }
    autosave(status, { summary: {
      autoMs: Number(inputs.autoMs.value) * 1000,
      minNewChars: Number(inputs.minNewChars.value), maxChars: Number(inputs.maxChars.value),
    } });
  };
  const inputs = Object.fromEntries(specs.map(([key, label, min, max, value]) =>
    [key, h('input', { type: 'number', min, max, step: 1, value, 'data-field': key, 'aria-label': t(label), onchange: save })]));
  return settingsGroup('summary', '摘要与用量', null,
    h('div', { class: 'settings-grid' }, ...specs.map(([key, label]) => settingsField(label, inputs[key]))),
    h('p', { class: 'settings-note', text: t('开启时至少间隔 30 秒。仅发送上一版摘要和新增转写；新增字数不足时跳过自动摘要，手动总结不受此限制。目标字数由模型遵循，可能略有超出。') }),
    status);
}

function speakerSettings(speakers = {}, providers = []) {
  const engine = providers.find((p) => p.name === (speakers.provider || 'deepgram'));
  const ready = !!engine && engine.enabled && engine.ready;
  const status = h('small', { class: 'settings-note autosave-state', role: 'status' });
  const auto = h('input', { type: 'checkbox', checked: !!speakers.autoDiarize, 'data-field': 'autoDiarize',
    onchange: (e) => autosave(status, { speakers: { autoDiarize: e.target.checked } }) });
  return settingsGroup('speakers', '说话人校正', t(ready ? '可用' : '需要 Deepgram 密钥'),
    h('label', { class: 'settings-check' }, auto, ' ', t('录音或导入结束后自动用整段录音校正说话人')),
    h('p', { class: 'settings-note', text: t('逐句识别时，每次请求都会重新给说话人编号，所以大多数句子会被标成说话人1。校正会把整段录音再发送给 Deepgram 一次（按时长计费），按时间重新分配说话人；文字和翻译不变，可撤销。也可以在转写区手动点击「整场校正说话人」。') }),
    status);
}

function isDeepSeekProvider(provider) {
  try { return new URL(provider?.baseUrl).hostname === 'api.deepseek.com'; } catch { return false; }
}

// Selection is independent of discovery: services without GET /models still
// accept exact model IDs. Never replace a user's edit when discovery completes.
function modelPicker(category, initialProvider, current, catalog) {
  let provider = initialProvider;
  let generation = 0;
  const manualId = '__manual_model__';
  const input = h('input', { value: current, spellcheck: false, placeholder: t('输入模型 ID'), 'aria-label': t('输入模型 ID'), 'data-field': 'model-id' });
  const select = h('select', { 'aria-label': t('选择模型'), 'data-field': 'model-select', onchange: () => {
    input.hidden = select.value !== manualId;
    if (input.hidden) input.value = select.value;
  } });
  const note = h('small', { class: 'settings-note', role: 'status' });
  const value = () => select.value === manualId ? input.value.trim() : select.value;
  const populate = (ids, selected, manual = false) => {
    const names = [...new Set([selected, ...ids].filter(Boolean))];
    select.replaceChildren(...names.map((id) => h('option', { value: id, text: isDeepSeekProvider(provider) && id === 'deepseek-flash'
      ? 'DeepSeek 4.1 Flash · ' + id : isDeepSeekProvider(provider) && id === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro · ' + id : id })),
    h('option', { value: manualId, text: t('手动输入模型 ID') }));
    select.value = !manual && selected ? selected : manualId;
    input.value = selected || '';
    input.hidden = select.value !== manualId;
  };
  const seeds = () => category === 'llm' && isDeepSeekProvider(provider) ? ['deepseek-flash', 'deepseek-v4-pro'] : [];
  const load = async (refresh = false) => {
    const ticket = ++generation;
    const key = category + ':' + provider?.name + ':' + provider?.baseUrl;
    note.textContent = t('连接中…');
    try {
      if (!provider) throw new Error(t('请先选择服务'));
      if (refresh || !catalog.has(key)) {
        const pending = (async () => {
          const res = await fetch('/api/providers/' + category + '/' + encodeURIComponent(provider.name) + '/models');
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
          return data.models || [];
        })();
        catalog.set(key, pending);
        pending.catch(() => { if (catalog.get(key) === pending) catalog.delete(key); });
      }
      const models = await catalog.get(key);
      if (ticket !== generation) return;
      populate([...seeds(), ...models], value(), select.value === manualId);
      note.textContent = models.length ? t('已读取模型列表') : t('没有返回模型，请手动填写模型 ID。');
    } catch (err) {
      if (ticket === generation) note.textContent = t('列表不可用，可手动输入模型 ID。') + ' ' + err.message;
    }
  };
  populate(seeds(), current);
  return {
    element: h('div', { class: 'model-picker' }, select, input,
      h('button', { type: 'button', class: 'btn tiny', text: t('读取模型列表'), onclick: () => load(true) }), note),
    value,
    setProvider(next) {
      generation++;
      provider = next;
      populate(seeds(), seeds()[0] || '');
      void load();
    },
  };
}

function taskModelSettings(roleName, role, providers, catalog) {
  const labels = { summary: '摘要', minutes: '纪要', translate: '翻译', ask: '问答' };
  const selectedProvider = () => providers.find((p) => p.name === provider.value);
  const model = modelPicker('llm', providers.find((p) => p.name === role.provider), role.model || '', catalog);
  const thinking = h('select', { 'data-field': 'thinking', 'aria-label': t('思考模式') },
    ...[['default', '遵循服务默认'], ['disabled', '关闭思考（节省用量）'], ['enabled', '开启思考']].map(([value, label]) =>
      h('option', { value, selected: value === (role.thinking || 'default'), text: t(label) })));
  const provider = h('select', { 'data-field': 'provider', 'aria-label': t('服务'), onchange: () => {
    model.setProvider(selectedProvider());
    thinking.disabled = !isDeepSeekProvider(selectedProvider());
  } }, ...providers.map((p) => h('option', { value: p.name, selected: p.name === role.provider, text: p.label + (p.enabled ? '' : ' · ' + t('未启用')) })));
  thinking.disabled = !isDeepSeekProvider(selectedProvider());
  const status = h('small', { class: 'settings-note autosave-state', role: 'status' });
  // Changes bubble up from the provider, model and thinking controls; the
  // provider's own handler has already reset the model by the time this runs.
  const save = () => {
    if (!model.value()) {
      status.textContent = t('输入模型 ID');
      status.dataset.state = 'error';
      return;
    }
    autosave(status, { llm: { roles: { [roleName]: {
      provider: provider.value, model: model.value(), thinking: thinking.value,
    } } } });
  };
  return h('div', { class: 'task-model-card setting-card', 'data-task': roleName, onchange: save },
    h('strong', { text: t(labels[roleName] || roleName) }),
    h('div', { class: 'settings-grid' }, settingsField('服务', provider), settingsField('选择模型', model.element), settingsField('思考模式', thinking)),
    status);
}

function settingsField(label, input) {
  return h(input.tagName === 'DIV' ? 'div' : 'label', { class: 'settings-field' }, h('span', { text: t(label) }), input);
}

async function settingsAction(action, success) {
  state.settingsWarning = '';
  try {
    const result = await action();
    if (result?.status) state.status = result.status;
    await rebuildDrawer(openSettings);
    applyStatus(state.status);
    // A warning raised during the action (a damaged key file) outranks the success note.
    if (state.settingsWarning) showBanner(state.settingsWarning, 'warn');
    else showBanner(t(success));
  } catch (err) { showBanner(err.message, 'error'); }
}

function providerCard(category, provider, catalog) {
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
  const model = category === 'asr' ? modelPicker(category, provider, provider.model || '', catalog) : null;
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
  const saveProvider = () => settingsAction(() => patchConfig({ [category]: { providers: { [provider.name]: {
    label: label.value.trim(), baseUrl: baseUrl.value.trim().replace(/\/+$/, ''), noAuth: noAuth.checked,
    ...(kind ? { kind: kind.value } : {}),
    ...(category === 'asr' ? { model: model.value(), languages: languages.value.split(/[\s,，]+/).filter(Boolean) } : {}),
  } } } }), '设置已保存');
  const details = h('details', { class: 'provider-details', open: state.settingsOpen.has(id),
    ontoggle: (e) => { if (e.target.open) state.settingsOpen.add(id); else state.settingsOpen.delete(id); } },
    h('summary', { text: t('连接设置') }),
    h('div', { class: 'settings-grid' },
      settingsField('引擎名称', label), kind ? settingsField('协议', kind) : null,
      settingsField('接口地址', baseUrl), category === 'asr' ? settingsField('模型名称', model.element) : null,
      category === 'asr' ? settingsField('支持语言', languages) : null,
      h('label', { class: 'settings-check' }, noAuth, t('无需 API Key'))),
    h('div', { class: 'settings-actions' },
      h('button', { class: 'btn tiny primary', text: t('保存配置'), onclick: saveProvider }),
      category === 'llm' ? h('button', { class: 'btn tiny', text: t('选择任务模型'), onclick: () => {
        const target = els.drawerBody.querySelector('[data-task="summary"]');
        const group = target?.closest('details');
        if (group) group.open = true;
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        target?.querySelector('select')?.focus({ preventScroll: true });
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
  // The old key file was unreadable and has been backed up; other keys need re-entering.
  if (json.warning) {
    state.settingsWarning = json.warning;
    showBanner(json.warning, 'warn');
  }
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
  try {
    const saved = JSON.parse(localStorage.getItem('babel-note-options-v1') || '{}');
    if (['meeting', 'class'].includes(saved.mode)) els.noteMode.value = saved.mode;
    if (['standard', 'detailed'].includes(saved.notesDetail)) els.notesDetail.value = saved.notesDetail;
    els.includeTranscript.checked = localStorage.getItem('babel-md-include-transcript') === 'true';
    els.autoMinutes.checked = localStorage.getItem('babel-auto-minutes') !== 'false';
  } catch { /* Defaults: meeting, detailed, no transcript in Markdown. */ }
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
  const systemSupported = ['win32', 'darwin'].includes(desktop?.platform) || (!desktop && !!navigator.mediaDevices?.getDisplayMedia);
  els.systemAudioField.hidden = !systemSupported;
  els.includeSystemAudio.checked = systemSupported && (desktopPreference?.includeSystemAudio ?? ['win32', 'darwin'].includes(desktop?.platform));
  if (desktop?.platform === 'darwin') {
    els.systemAudioField.title = t('首次使用会请求 macOS 的屏幕与系统音频录制权限；应用不会保存画面。');
  }
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
  const settings = params.get('settings');
  if (settings) await openSettings(settings === '1' ? undefined : settings);
}

if (new URLSearchParams(location.search).has('selftest')) {
  window.miaojiSelfTest = { state, startCapture, stopCapture, toggleMicrophoneTest };
}

boot();
