// prompts.mjs — every prompt the product sends, in one place.
//
// Two product constraints shape these:
//   * The user studies in Japan, so meetings are routinely mixed
//     Chinese/Japanese/English and translation is a first-class feature,
//     not an afterthought.
//   * Summaries are re-generated while the meeting runs, so each prompt has
//     to be cheap and incremental: feed the previous summary plus only the
//     new transcript, never the whole meeting.

const LANGS = {
  zh: '简体中文',
  ja: '日本語',
  en: 'English',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  auto: '与原文一致',
};

export function langName(code) {
  return LANGS[code] || code;
}

function ts(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}

/** Render transcript lines with speakers and timestamps. */
export function renderTranscript(segments) {
  return segments
    .map((s) => '[' + ts(s.start) + '] ' + (s.speaker || '说话人') + '：' + s.text)
    .join('\n');
}

/** Rolling summary: previous summary + the transcript added since. */
export function summaryMessages({ previous, newSegments, maxChars, title }) {
  const body = renderTranscript(newSegments);
  const system = [
    '你是一名资深会议记录员，正在为一场进行中的会议生成「实时摘要」。',
    '要求：',
    '1. 只写已经明确出现的信息，绝对不要推测或补充不存在的内容。',
    '2. 用 Markdown，层级扁平：二级标题 + 短要点。',
    '3. 保留具体的数字、金额、日期、人名、产品名、专有名词（原文照抄，不要改写）。',
    '4. 若出现分歧、未定事项、明确结论，单独标注。',
    '5. 输出的是「更新后的完整摘要」，覆盖旧摘要，不要写成增量变更说明。',
    '6. 篇幅控制在 ' + maxChars + ' 字以内，宁可精炼也不要注水。',
    '7. 直接输出摘要正文，不要任何寒暄或解释。',
  ].join('\n');

  const parts = [];
  if (title) parts.push('会议主题：' + title);
  parts.push('【已有摘要】');
  parts.push(previous ? previous : '（暂无，这是第一版摘要）');
  parts.push('');
  parts.push('【新增转写内容】');
  parts.push(body || '（无）');
  parts.push('');
  parts.push('请输出覆盖了上述全部内容的、更新后的会议摘要。');

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ];
}

const MINUTES_SCHEMA = {
  title: '一句话会议主题',
  abstract: '3-6 句的整体摘要',
  participants: ['出现的说话人/人名'],
  decisions: [{ decision: '已明确达成的结论', context: '依据' }],
  actionItems: [{ task: '待办事项', owner: '负责人，未提及则写"待定"', due: '截止时间，未提及则写"未定"' }],
  risks: [{ risk: '风险、分歧或阻塞', impact: '影响' }],
  openQuestions: ['尚未解决的问题'],
  keywords: ['关键词/专有名词'],
  chapters: [{ title: '章节标题', start: '起始时间 mm:ss', summary: '这一段的要点' }],
};

/** Final structured minutes. */
export function minutesMessages({ segments, title, summary, targetLang }) {
  const system = [
    '你是一名专业的商务会议纪要撰写者。',
    '你会收到一段完整的会议转写记录（含时间戳与说话人），需要产出一份结构化「智能纪要」。',
    '硬性要求：',
    '1. 只使用转写中出现的信息，禁止编造人名、数字、日期或结论。',
    '2. 待办事项的负责人和截止时间只能来自原文；原文没提到就写「待定」「未定」。',
    '3. 章节划分按话题转折，通常 2-6 个章节。',
    '4. 输出语言：' + langName(targetLang || 'zh') + '。',
    '5. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。',
  ].join('\n');

  const user = [
    title ? '会议主题（用户填写）：' + title : '',
    summary ? '【实时摘要（参考，可修正）】\n' + summary : '',
    '【完整转写记录】',
    renderTranscript(segments),
    '',
    '请严格按以下 JSON 结构输出（字段名保持英文，值用目标语言）：',
    JSON.stringify(MINUTES_SCHEMA, null, 2),
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Batch translation of newly finalised segments. */
export function translateMessages({ segments, target }) {
  const system = [
    '你是专业会议口译员。你会收到若干条带编号的会议转写片段。',
    '要求：',
    '1. 翻译成 ' + langName(target) + '，保持口语自然、术语准确。',
    '2. 保留原有语气与信息量，不要总结、不要增删。',
    '3. 只有在该条内容确实已经是' + langName(target) + '时才原样返回；其余一律翻译，短句也必须翻译。',
    '4. 专业名词、产品名、人名按业界习惯处理（可保留原文并加括号）。',
    '5. 只输出 JSON：{"translations":[{"id":<编号>,"text":"<译文>"}]}，不要代码块，不要解释。',
  ].join('\n');

  const items = segments.map((s) => ({ id: s.index, text: s.text }));
  return [
    { role: 'system', content: system },
    { role: 'user', content: '待翻译片段：\n' + JSON.stringify(items, null, 2) },
  ];
}

/** Grounded Q&A over the meeting transcript. */
export function askMessages({ question, segments, summary, history }) {
  const system = [
    '你是这场会议的助理。你只能依据提供的转写记录和摘要回答。',
    '要求：',
    '1. 如果转写里没有相关信息，直接说「会议记录中没有提到」，不要编造。',
    '2. 回答要引用时间戳，例如「（12:34）」。',
    '3. 简洁，用要点列出，不要重复整段原文。',
  ].join('\n');

  const conv = (history || [])
    .slice(-6)
    .map((h) => (h.role === 'user' ? '用户：' : '助手：') + h.content)
    .join('\n');

  const user = [
    summary ? '【会议摘要】\n' + summary : '',
    '【转写记录】',
    renderTranscript(segments),
    conv ? '【此前的问答】\n' + conv : '',
    '【当前问题】',
    question,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Split a flat transcript into plausible speaker turns. */
export function speakerSplitMessages({ segments, speakers }) {
  const system = [
    '你会收到一段会议转写，其中所有内容都被标成了同一个说话人。',
    '请根据称呼、语气、应答、问答关系等语言线索，把片段归到不同的说话人。',
    '不要修改任何文字内容，只做归属。',
    '只输出 JSON：{"assignments":[{"id":<片段编号>,"speaker":"说话人N"}]}，不要解释。',
    '若确实无法区分，全部归为「说话人1」。',
  ].join('\n');
  const items = segments.map((s) => ({ id: s.index, start: s.start, text: s.text }));
  return [
    { role: 'system', content: system },
    { role: 'user', content: '已知说话人：' + (speakers || []).join('、') + '\n\n片段：\n' + JSON.stringify(items, null, 2) },
  ];
}

export { ts as formatTimestamp };
