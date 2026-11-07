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

export const normalizeMode = (mode) => mode === 'class' ? 'class' : 'meeting';
export const normalizeNotesDetail = (detail) => detail === 'standard' ? 'standard' : 'detailed';

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
export function summaryMessages({ previous, newSegments, maxChars, title, mode }) {
  const classroom = normalizeMode(mode) === 'class';
  const body = renderTranscript(newSegments);
  const system = [
    classroom ? '你是一名严谨的学习笔记助手，正在为一堂课生成「课堂摘要」。重点保留知识框架、概念定义、公式条件、推导步骤、例题方法、老师强调的重点、易错点和明确布置的作业；不要套用商务会议的决议、负责人和风险模板。' : '你是一名资深会议记录员，正在为一场进行中的会议生成「实时摘要」。重点保留议题、论据、讨论分歧、决策依据、行动与未决问题。',
    '要求：',
    '1. 只写已经明确出现的信息，绝对不要推测或补充不存在的内容。',
    '2. 用 Markdown 二级标题和短要点；适合比较的事实可整理成表格，明确待办可用任务列表。',
    '3. 保留具体的数字、金额、日期、人名、产品名、专有名词（原文照抄，不要改写）。',
    '4. 若出现分歧、未定事项、明确结论，单独标注。',
    '5. 输出的是「更新后的完整摘要」，覆盖旧摘要，不要写成增量变更说明。',
    '6. 篇幅控制在 ' + maxChars + ' 字以内，宁可精炼也不要注水。',
    '7. 直接输出摘要正文，不要任何寒暄或解释。',
    '8. 若存在明确的流程或关系，可用一张简短的 ```mermaid 流程图（flowchart LR）；只有原文提供明确数值时才可用 pie 数据图。简单内容不必画图，优先可读性，不强行凑图表。',
    '9. 图表与表格只能重排已有事实，禁止编造节点关系、数字或比例；用简短 ASCII 节点 ID，中文标签放在双引号内；不输出初始化配置、click、外部资源或 HTML。图表代码也计入篇幅，保持精简。',
  ].join('\n');

  const parts = [];
  if (title) parts.push((classroom ? '课程主题：' : '会议主题：') + title);
  parts.push('【已有摘要】');
  parts.push(previous ? previous : '（暂无，这是第一版摘要）');
  parts.push('');
  parts.push('【新增转写内容】');
  parts.push(body || '（无）');
  parts.push('');
  parts.push('请输出覆盖了上述全部内容的、更新后的' + (classroom ? '课堂摘要。' : '会议摘要。'));

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
export function minutesMessages({ segments, title, summary, targetLang, mode, notesDetail }) {
  const classroom = normalizeMode(mode) === 'class';
  const detailed = normalizeNotesDetail(notesDetail) === 'detailed';
  const system = [
    classroom ? '你是一名严谨的课堂笔记整理者。请把完整课堂转写整理成可用于复习的课程笔记，而不是商务会议纪要。' : '你是一名专业的会议记录撰写者。请把完整会议转写整理成信息充分、能回溯讨论过程的结构化纪要。',
    '你会收到完整转写（含时间戳与说话人），实时摘要仅供参考，不能代替完整转写或作为删减信息的依据。',
    detailed ? '详细模式：不要压缩成几个结论。按实际讲授/讨论顺序完整覆盖主要话题，topics 写清背景、解释、依据、过程、例子、限制与结论，points 保留具体步骤和细节；概述在素材充分时写 6–12 句，但不能凑字。' : '标准模式：保留每个主要话题及必要解释、依据和关键细节，合并重复表达；不要只列无解释的关键词。',
    classroom ? '课堂重点：知识框架、定义与适用条件、公式符号含义、推导过程、例题步骤与解法、概念间关系、易错点、老师强调内容、作业与明确的考试提示。keyConcepts 解释概念；examples 保留讲过的例子和步骤；reviewQuestions 只根据已讲内容整理复习问答，答案不能引入课外知识。未提及考试重点时禁止自行标成必考。没有真正的决议/负责人时，对应会议字段留空。' : '会议重点：各方观点及依据、备选方案与取舍、关键决议的背景、执行细节、风险的影响和待确认问题。不能把未定讨论写成已达成的共识。',
    '硬性要求：',
    '1. 只使用转写中出现的信息，禁止编造人名、数字、日期或结论。',
    '2. 待办事项的负责人和截止时间只能来自原文；原文没提到就写「待定」「未定」。',
    '3. 章节按真实话题转折与时间戳划分，不固定为 2–6 章；长内容允许更多章节。保留信息量但不逐字抄写转写，不添加未出现的内容；无依据的字段使用空数组。',
    '4. 输出语言：' + langName(targetLang || 'zh') + '。',
    '5. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。',
  ].join('\n');

  const user = [
    title ? (classroom ? '课程主题（用户填写）：' : '会议主题（用户填写）：') + title : '',
    summary ? '【实时摘要（参考，可修正）】\n' + summary : '',
    '【完整转写记录】',
    renderTranscript(segments),
    '',
    '请严格按以下 JSON 结构输出（字段名保持英文，值用目标语言）：',
    JSON.stringify({ ...MINUTES_SCHEMA,
      title: classroom ? '课程主题' : MINUTES_SCHEMA.title,
      abstract: detailed ? '素材充分时用6–12句概述，覆盖主要内容；禁止补写事实' : '整体概述，包含主要内容与必要背景',
      topics: [{ title: '话题或知识点标题', detail: '完整解释、依据、过程、条件与结论', points: ['具体细节、步骤与原文例子'] }],
      chapters: [{ title: '章节标题', start: '原文起始时间 mm:ss', summary: '该章的内容、解释与具体细节' }],
      ...(classroom ? {
        keyConcepts: [{ term: '原文概念或公式', explanation: '定义、符号含义和适用条件' }],
        examples: [{ title: '原文例题或案例', explanation: '原文条件、步骤、方法和结果' }],
        reviewQuestions: [{ question: '基于所讲内容的复习问题', answer: '只依据原文的回答' }],
      } : {}),
    }, null, 2),
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Batch translation of newly finalised segments. */
export function translateMessages({ segments, target, context = [] }) {
  const system = [
    '你是专业会议口译员。你会收到若干条带编号的会议转写片段。',
    '要求：',
    '1. 翻译成 ' + langName(target) + '，保持口语自然、术语准确。',
    '2. 保留原有语气与信息量，不要总结、不要增删。',
    '3. 只有在该条内容确实已经是' + langName(target) + '时才原样返回；其余一律翻译，短句也必须翻译。',
    '4. 专业名词、产品名、人名按业界习惯处理（可保留原文并加括号）。',
    '5. 只输出 JSON：{"translations":[{"id":<编号>,"text":"<译文>"}]}，不要代码块，不要解释。',
    '6. 片段按时间顺序排列，可能承接上文；结合前文理解指代和省略，但每条只翻译它自己的内容。',
  ].join('\n');

  const items = segments.map((s) => ({ id: s.index, text: s.text }));
  // Earlier sentences are context only: they cost a few tokens and fix
  // pronouns, omitted subjects and sentences that continue across segments.
  const before = context.length ? '前文（仅供理解，不要翻译）：\n' + context.join('\n') + '\n\n' : '';
  return [
    { role: 'system', content: system },
    { role: 'user', content: before + '待翻译片段：\n' + JSON.stringify(items, null, 2) },
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
