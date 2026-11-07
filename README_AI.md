# 巴别回声 Babel Echo — 开发者与 AI 接手文档

> 本文供维护者与 AI 编程助手阅读。面向使用者的中英文介绍和上手步骤见 [README.md](README.md)。

这里保留项目架构、协议、数据模型、测试流程、已知限制与排障记录。
接手修改代码前，**请先读 §3「接手须知」**，再查阅相关章节中的不变量和已踩过的坑。

**源码版本：`0.1.0-beta.10`（公开预发布）。** 源码采用根目录 Apache-2.0 许可证，尚未发布稳定版。安装包见 [Releases](https://github.com/ndof0ssome-114/babel-echo/releases)。本仓库是私有开发仓库中 `apps/desktop` 的发布快照，开发在私有仓库进行，每次公开发布时同步。

统一验证入口为 `npm run test:offline`（语法检查及 13 组离线测试），推送或 PR 到 `main` 时由根目录 `.github/workflows/desktop-ci.yml` 在 Windows 与 Ubuntu 上运行。Electron/打包依赖建议 Node.js 24 LTS；核心服务最低 Node.js 20。Mac CI 位于根 `.github/workflows/desktop-macos.yml`，不在本应用子目录；`desktop-v*` 标签生成未签名测试包和不含用户数据的测试资料，真机验证仍须执行 Mac 交接清单。

品牌图标根据项目使用者提供的角色参考图生成，源图与各尺寸图标见 `desktop/build/`。仓库公开不表示授予第三方复用该角色或图标的许可；再分发前应确认相应授权。

---

## 目录

| 章节 | 内容 |
| --- | --- |
| [1](#1-这是什么) | 这是什么 · 能力清单 |
| [2](#2-五分钟跑起来) | 五分钟跑起来 |
| [3](#3-接手须知先读这段) | **接手须知（先读）** |
| [4](#4-技术选型与约束) | 技术选型与约束 |
| [5](#5-目录结构与文件职责) | 目录结构与文件职责 |
| [6](#6-架构与数据流) | 架构与数据流 |
| [7](#7-数据模型) | 数据模型 |
| [8](#8-http-api-参考) | HTTP API 参考 |
| [9](#9-websocket-协议参考) | WebSocket 协议参考 |
| [10](#10-模块-api-参考) | 模块 API 参考 |
| [11](#11-关键不变量不要破坏) | **关键不变量** |
| [12](#12-已踩过的坑不要再踩) | **已踩过的坑** |
| [13](#13-测试与验证) | 测试与验证 |
| [14](#14-开发工作流) | 开发工作流 |
| [15](#15-环境与打包) | 环境与打包 |
| [16](#16-已知限制与路线图) | 已知限制与路线图 |
| [17](#17-排障手册) | 排障手册 |
| [18](#18-术语与文件速查) | 术语与文件速查 |

---

## 1. 这是什么

一个单机运行的会议记录工具。浏览器或桌面端采集麦克风音频，
服务端做静音切分（VAD）→ 分段调用 ASR → 用 LLM 滚动总结 / 生成结构化纪要 / 逐句翻译。

### 能力清单

| 功能 | 状态 | 实现位置 |
| --- | --- | --- |
| 实时转写（边说边出字） | ✅ | `lib/meeting.mjs` 的 interim 重识别 |
| 实时总结（滚动刷新） | ✅ | `Meeting.summarize()` + 定时器 |
| 智能纪要（结构化 JSON） | ✅ | `Meeting.generateMinutes()` |
| 逐句翻译 | ✅ | `Meeting.flushTranslation()` |
| 会议问答（带时间戳引用） | ✅ | `Meeting.ask()` |
| 说话人区分 | ⚠️ 部分 | Deepgram 用真分离；其余靠停顿推断 + AI 重排 |
| 音视频文件导入 | ✅ | `lib/import.mjs`（ffmpeg 转码） |
| 音频回放 / 点时间戳跳转 | ✅ | `GET /api/meetings/:id/audio`（支持 Range） |
| 导出 Markdown / VTT / 双语字幕 / TXT / JSON | ✅ | `toMarkdown()` / `toVtt()` |
| 历史会议 | ✅ | `lib/store.mjs` |
| 桌面端（全局快捷键 / 防休眠 / 托盘 / 通知） | ✅ | `desktop/main.cjs` |
| 实时翻译字幕（边说边译） | ❌ | 目前是句子结束后翻译 |
| 说话人声纹识别 | ❌ | 见 §16 路线图 |
| 多用户 / 云端部署 | ❌ | 单进程内存态，个人工具定位 |

### 语言支持矩阵

| 引擎 | 中文 | 英文 | 日语 | 价格 | 实测速度 |
| --- | --- | --- | --- | --- | --- |
| MiMo `mimo-v2.5-asr` | 极好 | 好 | **不支持** | ¥0.5/小时 | — |
| Groq `whisper-large-v3-turbo` | 好 | 好 | **最好**（正确日文字形） | $0.04/小时 | 快（1.35s / 27s 音频） |
| Deepgram `nova-3` | 好 | 好 | 好 + **真说话人分离** | ~$0.26/小时 | 快 |

> MiMo 官方将 ASR 用于中文和英文；`asr_options.language` 只接受 `zh`/`en`/`auto`。`auto` 不是日语支持承诺。明确选择日语时，应用会禁止路由到 MiMo，并提示启用 Groq、Deepgram 或支持日语的本地引擎。

---

## 2. 五分钟跑起来

### 纯服务 + 浏览器

```powershell
cd <你的项目目录>\babel-echo
npm ci --prefix desktop     # 首次生成本地 Markdown 资源
node server.mjs 8777          # 或 .\start.ps1
# 打开终端打印的 http://127.0.0.1:8777/?token=… 链接（每次启动的令牌不同）
```

密钥默认只从「设置」中保存的本应用凭据读取。仅在显式设置 `MIAOJI_ALLOW_ENV_CREDENTIALS=1` 时，才额外读取以 `_KEY` 结尾的环境变量；不读取 DeepSeek Harness 或其他应用的凭据文件。首次使用云端模型时需要配置对应的密钥。
Electron 桌面窗口提供原生「编辑」菜单和文本右键菜单，可在输入框及已选文字上使用撤销、剪切、复制、粘贴和全选。macOS 的菜单与鼠标操作仍需在目标系统复测。

录音前可在顶部「麦克风」下拉框选择输入设备；点击「刷新设备」可授权并显示设备名称。点击「测试麦克风」并说话，确认音量条有反应。Windows 与 macOS 13+ 桌面版默认勾选「同时录电脑声音」，把所选麦克风与系统播放声音混合录入；可在开始前取消勾选。macOS 会请求屏幕与系统音频权限，但取得音频轨道后立即停止视频轨道，不保存或传输画面。
录音中也可切换，界面会显示实际连接的麦克风。桌面版会记住选择，并在下次启动时按设备名称重新匹配。
录音、暂停、结束和导入集中在上方操作区；语言、麦克风和电脑声音放在下方采集设置区。窄窗口会将转写与摘要上下排列，并允许整页滚动。外观支持浅色、深色和跟随系统；半透明玻璃面板只在主要区域使用模糊，减少渲染负担。

### 自定义模型与界面语言

- 「设置 → 外观」是独立标签页，支持默认玻璃主题与 Endspace 风格主题，并可调整强调色、阅读字号、圆角、间距和纹理。主题与明暗模式独立；浏览器用 `babel-echo-appearance-v1` localStorage，读取时兼容旧 `miaoji-theme`。Electron 通过 `miaoji:appearance-get/set` IPC 以 userData 中原子保存的 `appearance.json` 为准，跨随机端口持久化；首次从当前 origin 的偏好初始化。实现由 `public/appearance.js`、`appearance-settings.js` 和 `appearance.css` 管理；不修改会议/模型配置，不加载外部字体或媒体。详细 schema、范围与来源见 [主题说明](../../docs/UI_THEMES.md)，离线验证命令为 `npm run test:appearance`。

- 底部状态栏的「界面语言」可切换简体中文、日本語和 English；语音识别与翻译另支持韩语、法语、德语、西班牙语。
- 「设置 → 语音识别引擎」可启用、编辑模型 ID 与接口地址、更新 API Key，或新增 OpenAI Audio / Deepgram / MiMo 协议的自定义引擎。按语言路由决定每种语音使用哪个引擎。
- 「设置 → 实时识别节奏」可调整预览发送间隔、停顿定稿时间、最长单句和硬切时保留的衔接音频。预览刷新与句子定稿独立：停顿可提前定稿；Groq 预览由于请求额度最低按 10 秒间隔发送。
- 分句策略参考 [Deepgram 的可调静音端点](https://developers.deepgram.com/docs/endpointing)、[whisper.cpp 的 `--keep` 重叠音频](https://github.com/ggml-org/whisper.cpp/blob/941bdabb/examples/stream/stream.cpp) 和 [Whisper-Streaming 的局部确认与句末裁剪](https://arxiv.org/html/2307.14743v2)。当前应用用本地音量门限判停顿；长句到上限后最多再等 5 秒寻找停顿，仍不停顿才保留默认 1.2 秒重叠音频并去除可确定的重复文字。噪声大或多人同时说话时，纯音量门限仍可能误判，原始音频会完整保存。
- 「设置 → 文本模型」可编辑 DeepSeek、MiMo 和本地引擎，也可新增 OpenAI Chat Completions 兼容服务。「任务模型」分别选择摘要、纪要、翻译和问答的服务与模型；「读取模型列表」请求 `/api/providers/:category/:name/models`，无法发现时仍可手动输入 ID。切换服务会清空旧模型，异步列表不会覆盖已输入的 ID。语音引擎也支持模型列表。
- 「设置 → 摘要与用量」控制 `summary.autoMs`（0 或 30000–3600000）、`minNewChars`（0–10000）、`maxChars`（200–3000，为提示词目标）。新配置默认 180 秒 / 200 字，已有间隔保留。手动总结不受新增字数门限限制。
- 摘要与翻译默认 `thinking: disabled`，仅向 `api.deepseek.com` 发送 `thinking.type`；其他服务不注入该字段。任务可选择 `default` / `enabled` / `disabled`。每次 HTTP 尝试通过 `onUsage` 统计，包括 JSON 修复与失败响应；`completionTokens` 包含服务计入其中的思考 token，不能再加一次 `reasoningTokens`。未返回 usage 的请求记入 `llmUnreportedCalls`，旧会议标记历史不完整。输出截断或不确定的网络错误不会提高输出上限并重发；明确可重试 HTTP 状态仍最多尝试 3 次。
- 摘要使用请求发起时的片段游标，成功后只推进到该游标；`summaryUpTo` / `summaryAt` 随会议保存。缺少旧游标的历史摘要在下一次手动总结时从转写重建，避免漏掉尾部。
- 本地文本模型示例：[Ollama](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx) 的接口地址为 `http://127.0.0.1:11434/v1`；[LM Studio](https://lmstudio.ai/docs/developer/openai-compat) 常用 `http://127.0.0.1:1234/v1`。启动本地服务并确保模型已加载，再勾选引擎，在「任务模型」中填写其模型 ID。支持无密钥服务；需要鉴权时取消「无需 API Key」并保存密钥。
- 本地语音模型示例：提供 OpenAI 兼容 `/audio/transcriptions` 的服务可填入 `http://127.0.0.1:8080/v1`，具体模型 ID 以该服务为准。应用不会自动下载或启动本地模型。

### 免安装桌面窗口（零下载）

```powershell
.\start-app.ps1
```

用 Chrome/Edge 的 `--app` 模式开一个无地址栏独立窗口，关窗自动停服务。

### Electron 桌面版

```powershell
cd desktop
npm install        # 仅一次，约 250MB
npm start
```

### 打包 exe

```powershell
cd desktop
npm run dist              # → ../dist/BabelEcho-0.1.0-beta.9-setup.exe（安装向导）
npm run dist:portable     # → ../dist/BabelEcho-0.1.0-beta.9-portable.exe（单文件）
npm run dist:mac          # → ../dist/BabelEcho-0.1.0-beta.9-mac-arm64.dmg / .zip（需在 Mac 上运行）
```

安装版会弹出向导，选择安装范围和目录后再安装；已有安装升级时沿用原目录。卸载会先确认，再询问是否保留本机会议录音、转写、存档和设置，默认保留；选择删除才会在卸载完成后移除当前用户的应用数据（包括 API Key）。静默卸载和版本升级始终保留数据。

单文件 portable exe 每次启动会先解压 Electron，适合临时携带。经常使用时建议安装版，或将 `win-unpacked` 文件夹解压一次后直接运行其中的 `巴别回声.exe`。空载启动不会扫描麦克风；打开麦克风下拉框或点击「刷新设备」时才读取设备列表。

从旧版「妙记」升级：桌面版继续使用 `%APPDATA%\miaoji-desktop` 保存会议、录音、密钥和界面偏好，并保留原安装身份；安装新版后无需手动搬迁数据。`MIAOJI_*` 环境变量、`miaoji:*` IPC 名称及本地存储键属于兼容标识，不是界面品牌。

---

## 3. 接手须知（先读这段）

### 3.1 三十秒理解架构

```
浏览器 / Electron 渲染进程
  │  getUserMedia → AudioWorklet → 16kHz 单声道 Int16 PCM
  │  ── WebSocket 二进制帧 ──▶
  │
服务端（单进程 Node，零依赖）
  ├─ server.mjs        HTTP 路由 + WS 分发 + 静态资源
  ├─ lib/ws.mjs        手写 RFC6455（Node 没内置 WS 服务端）
  ├─ lib/meeting.mjs   会话状态机 ← 核心，改这里要小心
  ├─ lib/asr/*         ASR 适配器（MiMo / OpenAI 兼容 / Deepgram）
  ├─ lib/llm.mjs       OpenAI Chat Completions 兼容的 LLM 客户端
  ├─ lib/prompts.mjs   所有提示词
  └─ lib/store.mjs     JSON 落盘
  │
  └─ 出网：MiMo ASR / Groq ASR / Deepgram ASR / DeepSeek LLM
```

**没有数据库，没有前端应用框架。核心服务无 npm 运行时依赖；富 Markdown 的第三方资源需一次本地构建，安装桌面依赖时自动生成。** 会议就是 `data/meetings/<id>.json`。

### 3.2 改代码的正确顺序

1. 改完先 `node --check <file>`（所有 .mjs / .cjs 都是 ESM 或 CJS，能被语法检查）
2. 跑 `node scripts/test-adapters.mjs`（1 秒，不联网，覆盖 ASR 适配器和路由）
   和 `node scripts/test-regressions.mjs`（不联网，覆盖翻译关闭、导入进度、WS 统计请求）
3. 涉及流水线的改动跑 `node scripts/e2e.mjs`（约 3 分钟，需要真实 key）
4. 涉及前端的改动跑 `cd desktop; npm test`（有麦克风时 70 项，包含真实 UI 点击）
5. **改了前端一定要截图肉眼确认**（见 §14.3）

### 3.3 最容易破坏的三件事

1. **`saveConfig()` 必须原地修改配置对象**，不能替换引用 —— 见 §11.1
2. **ASR 调度不能丢音频** —— 见 §11.4
3. **`pick()` 不能把某语言发给未声明支持它的引擎** —— 见 §11.3

---

## 4. 技术选型与约束

| 决定 | 理由 | 代价 |
| --- | --- | --- |
| **零 npm 依赖（核心服务）** | 目标环境的沙箱 `pnpm/npm install` 不稳定；单文件可拷贝即跑 | 手写了 WebSocket 服务端、WAV 编解码、multipart 上传发送 |
| **手写 RFC6455** | Node 只内置 WS 客户端 | `lib/ws.mjs` 约 280 行需自己维护 |
| **原生 ES 模块前端，无框架** | 应用源码直接加载；Markdown 第三方依赖由 esbuild 构建为本地模块 | DOM 用手写 `h()` helper；状态管理靠手写 |
| **服务端做 VAD 与分句** | 单一事实来源，多客户端可同时观看同一会议 | 音频必须原样上行（不能只传压缩包） |
| **整段重发做 interim** | 结果自洽，不需要前后缀对齐算法 | 音频用量约 3 倍（但对 $0.04/小时无所谓） |
| **Electron 用 `ELECTRON_RUN_AS_NODE` 跑内嵌服务** | 打包后不需要用户装 Node | 主进程要多管一个子进程生命周期 |
| **ASR 可插拔 + 按语言路由** | 一家厂商无法同时覆盖中文与日语的最优 | 多一层抽象与配置 |

### 明确不做的事

- ❌ 不引入数据库（JSON 足够，且便于人工排查）
- ❌ 不做用户系统 / 多租户（个人工具）
- ❌ 不引入 webpack/vite（核心服务保持零构建）

---

## 5. 目录结构与文件职责

```
babel-echo/
├── server.mjs                  HTTP + WebSocket 入口、全部 REST 路由
├── package.json                核心服务，scripts 里没有任何 dependencies
├── config.json                 运行时配置（首次启动生成，gitignored）
├── start.ps1                   纯服务启动（含端口保留范围检查）
├── start-app.ps1               免安装桌面模式（Chrome/Edge --app）
│
├── lib/
│   ├── ws.mjs                  手写 RFC6455 WebSocket 服务端
│   ├── wav.mjs                 WAV 头读写、Float32→Int16、RMS、静音切片
│   ├── env.mjs                 本应用凭据加载/写入 + 显式选择的环境变量
│   ├── config.mjs              配置默认值 / 加载 / 原地保存 / provider 状态
│   ├── llm.mjs                 LLM 客户端（固定输出上限、逐次用量、JSON 修复）
│   ├── prompts.mjs             全部提示词，改提示词只改这个文件
│   ├── meeting.mjs             ★ 实时会话状态机（核心，26KB）
│   ├── import.mjs              音视频文件导入（ffmpeg → 切片 → ASR）
│   ├── store.mjs               会议 JSON 落盘 / 列表 / 删除 / 音频路径
│   └── asr/
│       ├── index.mjs           AsrRegistry：实例缓存 + 按语言路由
│       ├── mimo.mjs            小米 MiMo（chat/completions + input_audio）
│       ├── openai-audio.mjs    OpenAI 兼容 /audio/transcriptions（Groq/OpenAI/SiliconFlow/本地）
│       └── deepgram.mjs        Deepgram /listen（唯一带真说话人分离）
│
├── public/                     前端（原生 ES 模块，无构建）
│   ├── index.html              结构
│   ├── styles.css              样式（CSS 变量主题，light/dark）
│   ├── app.js                  ★ 全部前端逻辑（38KB）
│   └── pcm-worklet.js          AudioWorklet：麦克风 → Int16 PCM
│
├── desktop/                    Electron 外壳
│   ├── main.cjs                主进程：起服务/托盘/快捷键/休眠锁/通知/自检/截图
│   ├── preload.cjs             contextBridge（页面唯一可见的原生接口）
│   ├── package.json            含 electron-builder 打包配置
│   └── build/                  图标 icon.png / icon.ico / icon.html
│
├── scripts/                    测试与调研脚本（见 §13）
│   ├── make-fixture.mjs        MiMo TTS 合成中文会议 fixture
│   ├── make-ja-fixture.ps1     Windows SAPI 合成日语 fixture
│   ├── e2e.mjs                 实时链路端到端（14 项）
│   ├── test-import.mjs         文件导入链路（10 项）
│   ├── test-adapters.mjs       适配器 + 路由 mock 测试（25 项）
│   ├── test-japanese.mjs       日语路由与真实转写验证
│   ├── confirm-tts-hypothesis.mjs  证明"乱码"来自 TTS 而非 ASR
│   └── probe*.mjs              最初的 API 调研脚本（历史证据，保留）
│
├── data/                       ← 运行时产生，gitignored
│   ├── meetings/<id>.json      会议文档
│   ├── audio/<id>.mp3|wav      会议音频
│   ├── tmp/<id>.pcm            录音中的裸 PCM（结束后转成 wav/mp3）
│   ├── uploads/                上传的原始文件（转写后删除）
│   └── credentials.json        界面上保存的 key（最高优先级）
│
└── dist/                       ← 打包产物，gitignored
```

---

## 6. 架构与数据流

### 6.1 实时录音链路（时序）

```
浏览器                        服务端                        外部 API
  │
  │ getUserMedia                 │
  │ AudioContext(16000)          │
  │ AudioWorklet                 │
  │ 每 1024 帧（64ms）打包 Int16 │
  │ ── WS 二进制帧 ─────────────▶│ Meeting.ingest(int16)
  │                              │   ├─ writePcm() 落到 data/tmp/<id>.pcm
  │                              │   ├─ rms16() 算音量
  │                              │   └─ tick() 决定下一步
  │ ◀── {type:'level'} ──────────│
  │                              │
  │                     每 3s（stepMs）且新增 ≥1.5s：
  │                              │ ── ASR ─────────────────▶ 转写当前整句
  │ ◀── {type:'partial'} ────────│ ◀───────────────────────
  │  （临时文本，会被下一次替换）
  │                              │
  │                     静音 ≥1.2s（silenceMs）：
  │                              │ ── ASR ─────────────────▶ 定稿这一句
  │ ◀── {type:'segment'} ────────│
  │                              │   ├─ 入队翻译
  │                              │   └─ scheduleSave()
  │ ◀── {type:'segment-update'}──│ ◀── LLM 翻译 ───────────
  │                              │
  │                     每 180s（summary.autoMs，已有配置保留）：
  │ ◀── {type:'summary'} ────────│ ◀── LLM 滚动总结 ───────
  │  （只把「上次摘要 + 新增文本」发给模型）
  │
  │ {type:'stop'} ──────────────▶│ stop()
  │                              │   ├─ closeUtterance() 押最后一句
  │                              │   ├─ whenIdle() 等 ASR 清空
  │                              │   ├─ flushTranslation(true)
  │                              │   ├─ writeAudio() 补 WAV 头 → ffmpeg 转 mp3
  │                              │   └─ 生成智能纪要
  │ ◀── {type:'minutes'} ────────│
```

### 6.2 文件导入链路

```
POST /api/meetings/:id/import?name=x.mp3   （原始 body）
POST /api/meetings/:id/import-path         {path:"D:\\a.m4a"}  ← 桌面端原生对话框
        │
        ▼
  lib/import.mjs
   1. ffmpeg 归一化：任意格式 → 16kHz 单声道 PCM WAV
   2. readFileSync + parseWav 拿到时长
   3. sliceOnSilence() 按【第一个自然停顿】切分（最长 25s，最短 3s）
   4. 逐块 ASR（每块失败重试 1 次；峰值 < 0.008 的静音块直接跳过）
   5. 每块 pushSegment() → 走和实时链路完全相同的段落模型
   6. attachAudio() 把 wav 转成 mp3 存为会议音频
   7. 全部完成后 generateMinutes()
   进度通过 WS 的 import-progress / import-done 推送
```

### 6.3 音频管线（关键细节）

| 环节 | 格式 | 代码 |
| --- | --- | --- |
| 麦克风 → Worklet | Float32，浏览器采样率无关 | `pcm-worklet.js` |
| Worklet → 主线程 | Int16Array（transferable，零拷贝） | `postMessage(frame, [frame.buffer])` |
| 主线程 → 服务端 | 二进制 WS 帧，原始 Int16LE | `ws.send(frame.buffer)` |
| 服务端累积 | 裸 PCM 写入 `data/tmp/<id>.pcm` | `Meeting.writePcm()` |
| 送 ASR | 每段单独包一层 44 字节 WAV 头 | `encodeWav()` |
| 落盘 | 结束时补写真实 WAV 头 → ffmpeg 转 mp3 | `Meeting.writeAudio()` |

**为什么 PCM 要落盘而不是放内存**：16kHz 单声道 16bit = 32KB/s ≈ 115MB/小时。
两小时的会议就是 230MB，不能放堆里。

**为什么占位头**：WAV 头里的 `data` 长度要到最后才知道，所以先写 44 字节占位，
结束时用 `openSync(path,'r+')` + `writeSync(fd, wavHeader(...), 0, 44, 0)` 回填。

### 6.4 ASR 路由逻辑

```
pick(language) 的候选顺序：
  asr.active 若不是 'auto'  → 强制用它（若可用）
  否则按 asr.routes[language] → 再按 语言专属兜底 → 最后遍历所有 enabled

对每个候选：
  usable(name) = provider 存在于配置 && enabled && 能被构造（已配置 key 或允许免密）
  语言匹配   = language==='auto' ? true : provider.languages.includes(language)

★ 不变量：具体语言绝不回退到未声明支持的 provider。只有 'auto' 允许兜底。
★ 例外：语言为 'auto' 时允许用任何可用引擎。

MiMo 特例：只允许明确的中文和英文请求；日语不会回退到 MiMo。
```

---

## 7. 数据模型

### 7.1 `config.json`

完整默认值见 `lib/config.mjs` 的 `DEFAULT_CONFIG`。字段说明：

```js
{
  "server":  { "port": 8777, "host": "127.0.0.1" },

  "audio":   { "sampleRate": 16000 },        // 全链路唯一采样率，改这里要同步前端

  "realtime": {
    "stepMs": 3000,          // interim 重识别间隔（按【音频逻辑时钟】计时，非墙上时间）
    "minNewMs": 1500,        // 距上次 ASR 至少新增这么多音频才再跑一次
    "silenceMs": 1200,       // 静音超过这么久 → 定稿当前句
    "maxUtteranceMs": 30000, // 最长单句；再等待短暂自然停顿，必要时硬切
    "overlapMs": 1200,       // 硬切后保留这一段音频给下一句衔接
    "vadThreshold": 0.003    // RMS 门限，低于此值视为静音
  },

  "summary": { "autoMs": 180000, "maxChars": 900, "minNewChars": 200 }, // autoMs=0 关闭自动总结

  "translate": { "target": "ja" },                   // 新建会议的默认翻译目标

  "asr": {
    "active": "auto",                        // "auto" 或 provider 名（强制指定）
    "routes": { "zh":"mimo", "en":"mimo", "ja":"groq", "ko":"groq", "fr":"groq", "de":"groq", "es":"groq", "auto":"mimo" },
    "providers": {
      "mimo":     { kind:"mimo",          enabled:true,  keyRef:"XIAOMI_API_KEY",
                    baseUrl:"https://api.xiaomimimo.com/v1", model:"mimo-v2.5-asr",
                    languages:["zh","en"], pricePerHour:0.5, currency:"CNY" },
      "groq":     { kind:"openai-audio",  enabled:false, keyRef:"GROQ_API_KEY",
                    baseUrl:"https://api.groq.com/openai/v1", model:"whisper-large-v3-turbo",
                    languages:["ja","zh","en","ko","fr","de","es","auto"], pricePerHour:0.04, currency:"USD" },
      "deepgram": { kind:"deepgram",      enabled:false, keyRef:"DEEPGRAM_API_KEY",
                    baseUrl:"https://api.deepgram.com/v1", model:"nova-3",
                    languages:["ja","zh","en","auto"], pricePerHour:0.26, currency:"USD" },
      "local":    { kind:"openai-audio",  enabled:false, keyRef:"LOCAL_ASR_KEY", noAuth:true,
                    baseUrl:"http://127.0.0.1:8080/v1", model:"whisper-1",
                    languages:["ja","zh","en","auto"], pricePerHour:0, currency:"CNY" }
    }
  },

  "llm": {
    "providers": {
      "deepseek": { kind:"openai-chat", enabled:true, keyRef:"DEEPSEEK_API_KEY",
                    baseUrl:"https://api.deepseek.com/v1" },
      "mimo":     { kind:"openai-chat", enabled:true, keyRef:"XIAOMI_API_KEY",
                    baseUrl:"https://api.xiaomimimo.com/v1" },
      "local":    { kind:"openai-chat", enabled:false, keyRef:"LOCAL_LLM_KEY", noAuth:true,
                    baseUrl:"http://127.0.0.1:11434/v1" }
    },
    "roles": {
      "summary":   { "provider":"deepseek", "model":"deepseek-flash" },
      "minutes":   { "provider":"deepseek", "model":"deepseek-v4-pro" },
      "translate": { "provider":"deepseek", "model":"deepseek-flash" },
      "ask":       { "provider":"deepseek", "model":"deepseek-flash" }
    }
  },
  "roles": "…每个角色可独立换 provider / model，改这里就能把总结换成 MiMo"
}
```

> 首次读取旧版配置时会将内置 ASR 引擎的语言能力升级一次；之后 `languages`、`label`、`enabled`、`baseUrl`、`model`、`keyRef`、`noAuth` 和任务路由都可在设置中修改，并在重启后保留。

### 7.2 会议文档 `data/meetings/<id>.json`

由 `store.saveMeeting()` 写出：

```js
{
  "id": "a1b2c3d4e5f6",          // 12 位 hex（randomBytes(6)）
  "title": "周会",
  "language": "zh",              // 识别语言：auto|zh|en|ja
  "translateTo": "ja",           // 空字符串 = 不翻译
  "createdAt": 1790000000000,
  "updatedAt": 1790000060000,
  "state": "stopped",            // idle|recording|paused|processing|stopped
  "source": "live",              // live | upload
  "durationMs": 48720,

  "segments": [{
    "index": 1,                  // 从 1 递增，全局唯一，翻译/重排都用它做 key
    "start": 0,                  // 毫秒（相对会议开始）
    "end": 3000,
    "text": "大家好，我是田中。",
    "speaker": "说话人1",         // 显示名，可被 renameSpeaker 改
    "provider": "Xiaomi MiMo-V2.5-ASR",
    "translation": "みなさん、こんにちは。田中です。",   // null 表示未翻译
    "final": true
  }],

  "summary": "## 会议主题\n- …",  // Markdown，null 表示未生成

  "minutes": {                    // 结构化纪要，null 表示未生成
    "title": "一句话主题",
    "abstract": "3-6 句摘要",
    "participants": ["田中", "王小明"],
    "decisions":    [{ "decision": "…", "context": "依据" }],
    "actionItems":  [{ "task": "…", "owner": "…", "due": "…" }],
    "risks":        [{ "risk": "…", "impact": "…" }],
    "openQuestions": ["…"],
    "keywords": ["…"],
    "chapters": [{ "title": "…", "start": "00:00", "summary": "…" }],
    "generatedAt": 1790000000000,
    "model": "deepseek-v4-pro"
  },

  "chapters": [],                 // minutes.chapters 的镜像，便于前端单独取
  "speakers": { "s0": { "name": "说话人1", "key": "s0" } },

  "qa": [{ "question": "…", "answer": "…", "at": 1790000000000 }],

  "stats": {
    "asrCalls": 7, "asrMs": 64000, "asrSeconds": 64.0,
    "asrCost": 0.0089, "asrCostCurrency": "CNY",
    "llmCalls": 3, "llmMs": 21000,
    "promptTokens": 4100, "completionTokens": 1800,
    "translateHits": 6
  },

  "audio": { "ext": ".mp3", "bytes": 293157 },   // null 表示没有音频
  "upstream": { "provider": "mimo", "model": "mimo-v2.5-asr", "label": "Xiaomi MiMo-V2.5-ASR" }
}
```

### 7.3 凭据（`lib/env.mjs`）

默认只使用本应用凭据。选择启用环境变量时，**优先级从高到低**：

| 优先级 | 来源 | 用途 |
| --- | --- | --- |
| 1 | `data/credentials.json` | **设置界面保存的 key；更新后立即生效** |
| 2 | 进程环境变量中以 `_KEY` 结尾的名称 | 仅 `MIAOJI_ALLOW_ENV_CREDENTIALS=1` 时用于 CLI / 临时配置 |

`config.json` **只存 `keyRef`（变量名），永远不存 key 的值**。
`POST /api/credentials` 只写第 1 层，不读取或修改其他应用的密钥文件。清除界面保存的 key 后，默认视为未配置；只有显式启用环境变量时才可能使用对应环境密钥。升级前若只依赖 `~/.dsh/.credentials.yaml`，须在设置里自行输入密钥；旧文件不会被修改或删除。

已知的 key 名：`XIAOMI_API_KEY`、`DEEPSEEK_API_KEY`、`GROQ_API_KEY`、
`DEEPGRAM_API_KEY`、`LOCAL_ASR_KEY`、`LOCAL_LLM_KEY`。

### 7.4 磁盘布局

```
data/
  meetings/<id>.json     每场会议一个文档（saveMeeting 全量重写）
  audio/<id>.mp3         录音（ffmpeg 48kbps 单声道），失败则退回 .wav
  tmp/<id>.pcm           录音中的裸 PCM，结束后改名成 audio/<id>.wav
  uploads/<id>-<ts>-<name>   上传的原始文件，转写完成后删除
  credentials.json       界面粘贴的密钥
```

**打包版**（Electron）用 `MIAOJI_DATA_DIR` 把 `data/` 整体重定向到
`%APPDATA%\miaoji-desktop\data`，配置也存放在该目录的 `config.json`，安装目录保持只读。

---

## 8. HTTP API 参考

所有响应都是 JSON（`content-type: application/json`），错误形如 `{"error":"…"}`。
静态资源从 `public/` 直接提供。

**访问令牌（2026-11-02 起）。** 服务启动时由 `resolveAccessToken()` 生成随机令牌（测试可用 `MIAOJI_ACCESS_TOKEN` 固定，读取后立即从环境删除），并写入 `MIAOJI_READY` 的 `accessToken`/`accessCookie`，终端另打印 `/?token=` 链接。除 Host/Origin 检查外，所有请求（含静态页面）必须带 `Authorization: Bearer <token>` 或 Cookie `babel_echo_access_<port>`，否则 API 返回 401 JSON、页面返回 401 说明页。非 API 的 GET 若带正确 `?token=`，返回设置 HttpOnly/SameSite=Strict Cookie 的过渡页，再由本站 meta refresh 跳到去掉令牌的地址；API 不接受 URL 令牌。脚本用 `scripts/server-auth.mjs` 的 `useServerToken()`。

### 8.1 应用状态

#### `GET /api/bootstrap`
前端启动时请求 `?lite=1`，只取能力表和是否存在会议；完整历史在打开「历史」时读取。普通 `/api/bootstrap` 仍返回历史列表。

```json
{
  "status": {
    "asr": [{ "name":"mimo", "kind":"mimo", "label":"Xiaomi MiMo-V2.5-ASR",
              "enabled":true, "languages":["zh","en"],
              "pricePerHour":0.5, "currency":"CNY", "note":"…",
              "ready":true, "keyRef":"XIAOMI_API_KEY" }],
    "llm": [{ "name":"deepseek", "label":"DeepSeek", "ready":true, "keyRef":"DEEPSEEK_API_KEY" }],
    "routes": { "zh":"mimo", "en":"mimo", "ja":"groq", "auto":"mimo" },
    "active": "auto",
    "roles": { "summary": {"provider":"deepseek","model":"deepseek-flash"}, … },
    "realtime": { … }
  },
  "llmStats": { "calls":0, "promptTokens":0, "completionTokens":0, "reasoningTokens":0, "ms":0 },
  "meetings": [ /* listMeetings() 的精简对象 */ ],
  "defaults": { "translate":{…}, "realtime":{…}, "summary":{…} }
}
```

#### `GET /api/live`
给桌面外壳轮询用的轻量端点（托盘图标 / 休眠锁 / 通知都靠它）。**不返回转写内容。**

```json
{
  "recording": false,
  "processing": false,
  "meetings": [{ "id":"…", "title":"…", "state":"recording", "durationMs":12345,
                 "segments":6, "summary":true, "hasMinutes":false,
                 "source":"live", "watched":1 }],
  "upstream": { "provider":"mimo", "model":"…", "label":"…" },
  "llmStats": { … }
}
```

### 8.2 配置与凭据

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/config` | — | 完整 config 对象 |
| POST/PATCH | `/api/config` | 部分 config（深合并） | `{ok:true, status}` |
| GET | `/api/credentials` | — | `{sources:{local,environment}, configured:[名字]}`（**不含值**） |
| POST | `/api/credentials` | `{name,value}` | `{ok:true, name, configured, status}` |

`value` 传空字符串 = 删除该凭据。`name` 必须是 `/^[A-Z][A-Z0-9_]*$/`。

> 改配置会热生效：`asr.config = next; asr.instances.clear(); llm.config = next;`
> 不需要重启进程。

### 8.3 会议 CRUD

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meetings` | `{meetings:[…]}`，按 createdAt 倒序 |
| POST | `/api/meetings` | body `{title,language,translateTo,source}` → `{meeting:snapshot}` |
| GET | `/api/meetings/:id` | `{meeting: snapshot}`（内存中的活会议优先） |
| DELETE | `/api/meetings/:id` | 删 JSON + 音频，`{ok:true}` |

`:id` 必须匹配 `/^[A-Za-z0-9_-]{6,64}$/`（见 `store.isValidId`）。

### 8.4 音频

#### `GET /api/meetings/:id/audio`
返回 mp3/wav，**支持 HTTP Range**（`206 Partial Content`），前端播放器靠它做拖动跳转。
没有音频时 404。

### 8.5 导出

#### `GET /api/meetings/:id/export?format=…&translated=1`

| format | 内容 | content-type |
| --- | --- | --- |
| `md`（默认） | 纪要 + 摘要 + 全文（含译文引用块） | text/markdown |
| `vtt` / `srt` | WebVTT 字幕；`translated=1` 时用译文 | text/vtt |
| `txt` | `[时间] 说话人: 文本` 一行一条 | text/plain |
| `json` | 完整会议文档 | application/json |

全部带 `content-disposition: attachment`，文件名取会议标题（非法字符替换成 `_`）。

### 8.6 触发式操作

| 方法 | 路径 | body | 说明 |
| --- | --- | --- | --- |
| POST | `/api/meetings/:id/summarize` | — | 立刻滚动总结一次 → `{summary}` |
| POST | `/api/meetings/:id/minutes` | — | 重新生成结构化纪要 → `{minutes}` |
| POST | `/api/meetings/:id/ask` | `{question}` | 基于全文问答 → `{entry:{question,answer,at}}` |
| POST | `/api/meetings/:id/speakers` | `{action:"rename",from,to}` | 批量改名 → `{speakers}` |
| POST | `/api/meetings/:id/speakers` | `{action:"resplit"}` | LLM 重排说话人 → `{speakers,segments}` |
| POST | `/api/meetings/:id/speakers` | `{action:"diarize"}` | 整段录音交给 Deepgram 校正说话人 → `{speakers:n,changed,segments}` |
| POST | `/api/meetings/:id/speakers` | `{action:"undo-diarize"}` | 恢复校正前的说话人标注 → `{speakers,segments}` |

### 8.7 导入

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/meetings/:id/import?name=x.mp3` | 原始二进制 body（上限 2GB）→ `202 {accepted:true,state}` |
| POST | `/api/meetings/:id/import-path` | body `{path:"D:\\a.m4a"}` → `202` |

- `import-path` 是给桌面端原生文件对话框用的：**服务端直接读本地磁盘**，
  避免把几百 MB 通过 IPC 搬运。会校验扩展名白名单（`MEDIA_RE`）。
- 两者都是**异步 fire-and-forget**，进度走 WS 的 `import-progress` / `import-done`。
- 正在录音时返回 `409`。

---

## 9. WebSocket 协议参考

连接：`ws://127.0.0.1:<port>/ws?meeting=<id>`（浏览器自动带访问 Cookie；无法设 Cookie/请求头的脚本加 `&token=<token>`，缺失或错误时升级返回 403）
（或 `?new=1&title=…&language=…&translateTo=…` 现场建一个）

### 9.1 客户端 → 服务端

**文本帧（JSON）**

| type | 附加字段 | 作用 |
| --- | --- | --- |
| `start` | `title?` `language?` `translateTo?` | 开始录音（会先写入这些元数据） |
| `pause` | — | 暂停（音频继续上行但被丢弃） |
| `resume` | — | 继续 |
| `stop` | `minutes?` | 结束 → 等 ASR 清空 → 落音频 → 生成纪要（`minutes:false` 时跳过，之后可手动生成） |
| `config-patch` | `title?` `language?` `translateTo?` | 改元数据并广播 `meta` |
| `summarize` | — | 手动滚动总结 |
| `minutes` | `targetLang?` | 手动生成纪要 |
| `ask` | `question` | 提问 |
| `rename-speaker` | `from` `to` | 说话人改名；`to` 与已有说话人同名时两者合并 |
| `set-segment-speaker` | `index` `speaker` | 只改一句的说话人（新名字会登记到说话人表） |
| `resplit-speakers` | — | LLM 重排说话人 |
| `ping` | — | 心跳 |

**二进制帧**：原始 **Int16LE、单声道、`config.audio.sampleRate`（16kHz）** PCM。
建议每帧 1024 个采样（64ms）。服务端按 `new Int16Array(buf.buffer.slice(...))` 解析。

### 9.2 服务端 → 客户端

**所有事件都带 `type` 和 `at`（毫秒时间戳）。**

| type | 载荷 | 触发时机 |
| --- | --- | --- |
| `hello` | `{meeting, status, asrAvailable[]}` | 连接建立 |
| `segments` | `{segments:[]}` | 连接建立时补发历史（迟到的观看者） |
| `segment` | `{segment}` | 定稿一句 |
| `segment-update` | `{index, translation}`、`{index, text, end, open}` 或 `{index, speaker}` | 某句翻译回来；或未完成的句子被下一段接上 / 定稿 |
| `partial` | `{utteranceId, text, start, end, provider}` | 临时识别结果（会被下次覆盖） |
| `level` | `{rms:0..1, voice:bool}` | 每帧音量（画波形） |
| `status` | `{state}` | 状态机变化 |
| `summary` | `{summary, upTo}` | 滚动总结更新 |
| `summary-pending` | `{}` | 开始总结（UI 转圈） |
| `minutes-pending` | `{}` | 开始生成纪要 |
| `minutes` | `{minutes}` | 结构化纪要就绪；失败时发 `error`，带 `minutes: true` |
| `answer` | `{question, answer, at}` | 问答回答 |
| `speakers` | `{speakers, speakerBackup?}` | 说话人表变化；带 `speakerBackup` 时表示可撤销状态变化 |
| `diarize-pending` | `{}` | 开始整场校正说话人 |
| `diarize-done` | `{speakers, changed}` | 校正完成（只发给发起的连接） |
| `meta` | `{title, language, translateTo}` | 元数据变化 |
| `import-progress` | `{done, total, seconds, totalSeconds}` | 导入每完成一块 |
| `import-done` | `{segments, durationMs}` | 导入完成，前端更新进度与会议状态 |
| `audio` | `{audio:{ext,bytes}}` | 音频文件就绪（前端据此加载播放器） |
| `stats` | `{stats}` | 结束录音后推送用量 |
| `saved` | `{id}` | 落盘完成 |
| `error` | `{message, fatal, lostMs?}` | 错误；`fatal:true` 时前端停止录音 |
| `pong` | `{}` | 心跳回应 |

**未知事件必须被忽略**（前后端都要保持前向兼容）。

---

## 10. 模块 API 参考

### `lib/config.mjs`

```js
export const ROOT, DATA_DIR, MEETINGS_DIR, AUDIO_DIR, TMP_DIR, UPLOAD_DIR
export const DEFAULT_CONFIG

loadConfig()            → config        // 缓存 + 深合并 + 一次性升级旧配置
saveConfig(patch)       → config        // ★ 原地修改（见 §11.1）
ensureDirs()            → void          // 建齐所有数据子目录
pickAsrProvider(config, language, creds) → {name, cfg} | null   // 旧的简单版，server 用 AsrRegistry
providerStatus(config, creds) → {asr[], llm[], routes, active, roles, realtime}
```

### `lib/env.mjs`

```js
loadCreds()                  → {NAME: value}   // 本应用凭据 + 显式启用的环境变量，带缓存
cred(name)                   → string          // 取不到就抛错
setLocalCred(name, value)    → {name, configured}  // 写 data/credentials.json 并热更新缓存
LOCAL_CRED_PATH              // 本应用凭据的绝对路径
```

### `lib/llm.mjs`

```js
extractJson(text) → object|null      // 剥 ```json 围栏，扫括号配对，容错解析
class Llm {
  constructor(config, creds)
  stats                                // {calls, promptTokens, completionTokens, reasoningTokens, ms}
  resolve(roleName) → {providerName, provider, model, thinking, key}
  async call(roleName, messages, opts) // opts: {temperature, maxTokens, json, stream, onDelta, onUsage, signal, timeoutMs}
                                       // 每次 HTTP 尝试都上报 onUsage；length 不自动增额重试（见 §12.1）
  async json(roleName, messages, opts) // 解析失败会自动追加一轮纠正重试
}
createLlm(config, creds) → Llm
```

### `lib/meeting.mjs`（核心）

```js
class Meeting {
  constructor({ id, title, language, translateTo, config, asr, llm, creds, source })

  // 订阅（server.mjs 把每个 WS 连接挂上去）
  on(fn) → unsubscribe
  emit(type, payload)
  snapshot() → 会议文档对象

  // 生命周期： idle → recording ⇄ paused → processing → stopped
  start() / pause() / resume() / async stop()

  // 音频入口（由 WS 二进制帧驱动）
  ingest(int16)                  // ← 主入口：落盘 + RMS + 分句决策
  openUtterance(startMs)         // 开新句
  closeUtterance()               // 定稿当前句（→ 队列）
  tick()                         // 每帧调用，判断 interim / finalize

  // ASR 调度（串行优先队列，★ 不要绕过它直接调 asr.transcribe）
  scheduleAsr({pcm, startMs, endMs, final, utteranceId})
  async drainAsr()
  whenIdle() → Promise           // stop() 用它等 ASR 清空
  async runAsr(job)              // 真正调 ASR + 记 stats
  commitSegment(result, startMs, endMs)   // 支持 Deepgram 的多说话人拆分

  // 说话人
  inferSpeaker(startMs) / speakerLabel(key) / renameSpeaker(from, to)
  async resplitSpeakers()        // 用 LLM 按语言线索重排

  // 翻译 / 总结 / 纪要 / 问答
  async flushTranslation(drain)
  async summarize()
  async generateMinutes(targetLang)
  async ask(question)

  // 音频
  async writeAudio()             // 补 WAV 头 + ffmpeg 转 mp3
  async attachAudio(sourceWavPath)   // 导入时接管已有 wav

  static restore(doc, deps) → Meeting    // 从磁盘恢复成只读会议
}

toMarkdown(doc) → string
toVtt(doc, useTranslation) → string
formatDuration(ms) → "mm:ss" | "hh:mm:ss"
```

### `lib/asr/*`

```js
// 每个 adapter 导出 create(cfg, creds) → provider
// provider 接口：
{
  name, kind, label, pricePerHour, currency, languages: [],
  async transcribe(wavBuffer, { language, sampleRate, signal, timeoutMs }) → {
    text,            // 转写文本（已 trim，已去掉 <chinese> 这类语言标记）
    raw,             // 原始返回
    seconds,         // 音频时长（秒），用于计费
    durationSec,
    words: [],       // 词级时间戳（Deepgram 有）
    utterances: [],  // 句级 + speaker（Deepgram 有 → 触发多说话人拆分）
    provider, model, ms
  }
}

class AsrRegistry {
  get(name) → provider          // 实例缓存；构造失败会记在 failures
  available() → [name]
  pick(language) → provider|null   // ★ 路由不变量在这里
  async transcribe(language, wavBuffer, opts) → result（带 providerName）
}
createAsrRegistry(config, creds) → AsrRegistry
```

### `lib/wav.mjs`

```js
wavHeader(sampleRate, dataSize, channels) → Buffer(44)
encodeWav(int16, sampleRate, channels) → Buffer
floatTo16(float32) → Int16Array
concat16([Int16Array]) → Int16Array
parseWav(buf) → { sampleRate, channels, bitsPerSample, dataOffset, dataLength, durationSec } | null
rms16(int16) → 0..1
sliceOnSilence(buf, { maxChunkSec, minChunkSec, silenceMs, vadThreshold }) → [{buffer, start, duration}]
sliceWav(buf, chunkSec) → 同上（固定切分，旧接口，导入已改用 sliceOnSilence）
```

### `lib/ws.mjs`

```js
class WebSocket extends EventEmitter {
  send(data)          // 对象自动 JSON.stringify
  sendBinary(buf)
  ping() / close(code, reason)
  data = {}           // 挂应用层数据的草稿区（server 用来存 meeting）
  lastError
}
attachWebSocket(server, { path, onConnection(ws, req, url) }) → { clients: Set }
```

### `lib/store.mjs`

```js
isValidId(id) → bool             // /^[A-Za-z0-9_-]{6,64}$/
saveMeeting(meeting) → doc       // 全量重写 <id>.json
loadMeeting(id) → doc|null
listMeetings() → [{id,title,createdAt,updatedAt,state,durationMs,segments,
                   hasMinutes,source,preview,upstream}]
deleteMeeting(id) → bool         // 删 JSON + 所有同名音频
audioPath(id, ext) → string
findAudio(id) → {path, ext, size}|null    // 按 .mp3/.wav/.webm/.m4a/.ogg 顺序找
```

会议 JSON 写入同目录的唯一 `.tmp` 文件，完整写入后通过 rename 替换目标；写入或替换失败时保留上一版并尽力清理临时文件。异常退出留下的 `.tmp` 不参与历史列表。保存前校验会议 ID，不改变已有 JSON schema。

删除正在录音、暂停或导入处理的会议返回 `409`。可删除会议先调用 `Meeting.dispose()`，取消保存/翻译/摘要定时器并阻止迟到模型回调重新落盘；旧 WebSocket 收到后续命令会返回“会议已删除”。导入在读取异步请求体后再次检查会议是否删除或忙碌，避免等待上传期间发生状态竞态。文件导入与实时识别统一走 `commitSegment()`，保留 provider 的说话人及时间戳；同一 speaker 的多个 utterance 也优先使用 provider 标签。

### `lib/import.mjs`

```js
probeDuration(inputPath) → seconds|null            // ffprobe
toAsrWav(inputPath, workPath) → {path, converted}  // ffmpeg 归一化；非 WAV 且无 ffmpeg 会抛错
importMedia({ meeting, inputPath, onProgress, chunkSec }) → {segments, durationMs}
```

### `lib/prompts.mjs`

```js
langName(code) → '简体中文' | '日本語' | 'English'
renderTranscript(segments) → "[mm:ss] 说话人：文本\n…"
summaryMessages({ previous, newSegments, maxChars, title })   → messages[]
minutesMessages({ segments, title, summary, targetLang })     → messages[]
translateMessages({ segments, target })                       → messages[]  （要求返回 JSON）
askMessages({ question, segments, summary, history })         → messages[]
speakerSplitMessages({ segments, speakers })                  → messages[]  （要求返回 JSON）
```

---

## 11. 关键不变量（不要破坏）

### 11.1 `saveConfig()` 必须原地修改，不能替换引用

`server.mjs` 在启动时执行 `const config = loadConfig()`，`AsrRegistry` 和 `Llm` 也各拿一份引用。
如果 `saveConfig` 返回一个**新对象**，这些持有者会永远读旧的：

- 设置写进了磁盘，运行时也生效了，
- 但 `GET /api/config` 和 `providerStatus()` 返回旧值，
- **前端把每个开关都弹回原位**，用户以为"设置改不了"。

```js
// ✅ 正确
const base = loadConfig();
const merged = deepMerge(base, patch);
for (const k of Object.keys(base)) if (!(k in merged)) delete base[k];
Object.assign(base, merged);
current = base;
```

旧配置的能力列表按 `schemaVersion` 一次性升级；之后保留用户修改。MiMo ASR 始终只允许中英文路由。

### 11.2 ASR 调度必须串行，且只有最新 interim 值得保留

`meeting.busy` / `finalQueue` / `interimJob` 三件套不能绕过：

- **final 优先于 interim**（已说完的话比正在说的更值得算）
- **interim 只留最新一个**（旧的立刻过时）
- **final 一个都不能丢**（早期版本在 ASR 在飞时句子结束，会静默丢掉那段音频）
- 结束录音前必须 `await whenIdle()`，否则最后一句会丢

### 11.3 路由绝不把某语言发给未声明支持它的引擎

`AsrRegistry.pick()` 的最后一段兜底**只对 `language === 'auto'` 开放**。
具体语言找不到合适引擎时返回 `null`，让调用方抛明确错误 ——
静默使用不支持的引擎比报错危险得多。

### 11.4 时间用「音频逻辑时钟」，不是墙上时间

`Meeting.nowMs()` 返回 `totalSamples / sampleRate * 1000`。
所有分句判断（`stepMs` / `silenceMs` / `maxUtteranceMs`）都基于它。
这样**离线灌音频可以任意快**，不需要按实时速度 sleep，测试才能跑得快。

⚠️ 但 ASR 是异步的：如果灌得太快，interim 会大量合并（这是设计如此），
final 会排队（不会丢）。见 §13.2。

### 11.5 音频 PCM 落盘，且 WAV 头最后回填

不要为了"简单"把 PCM 收进数组。两小时会议 = 230MB 堆内存。
必须先写 44 字节占位头，结束时用 `openSync(path,'r+')` 回填。

录音生命周期（2026-11-03 起）：

- `processing`/`stopped` 的会议调用 `start()` 会抛错，不能重开。否则会重建 `data/tmp/<id>.pcm`、时钟归零，并在下次停止时覆盖已保存的音频。UI 本来就会为已结束会议新建记录。
- `stop()` 可重入：WebSocket、20 秒无人连接计时器和 `shutdown` 共用同一个 `this.stopping`。WS `stop` 对 `processing`（导入或正在停止）和 `stopped` 不做处理，纪要不会生成两次。
- 无人连接 20 秒后，录音中和**暂停中**的会议都会被停止并落盘。
- 服务启动时 `lib/recovery.mjs` 先占用 `data/tmp/recorder.pid`（另一个存活的服务持有时跳过，以免抢走它正在写的文件），再把崩溃遗留的 `<id>.pcm` 修正头部、去掉半个样本后改名为 `data/audio/<id>.wav`，并把会议标为 `stopped`、补上 `audio` 与时长。找不到会议或会议已有音频的文件原样保留并记日志；只删除没有音频数据的 44 字节文件。恢复的音频保持 WAV，不调用 ffmpeg。
- 测试：`npm run test:recording-lifecycle`。

### 11.6 `ws.mjs` 的 `emit('error')` 必须有守卫

Node 的 `EventEmitter` 在**没有 `'error'` 监听器**时 `emit('error')` **会直接抛异常**。
浏览器标签页一关就 `ECONNRESET`，服务器整个进程退出。
所以 `emitError()` 里必须 `if (this.listenerCount('error'))`。

### 11.7 CSS：`[hidden]` 和 flex 的 `min-height: 0`

- 任何显式 `display` 都会盖过 `hidden` 属性的 UA 样式 → 全局加 `[hidden]{display:none!important}`
- flex 列布局里可滚动子项必须 `flex:1 1 auto; min-height:0`，否则 `overflow:auto` 永不生效

### 11.8 每个入口都要过访问令牌

新增路由、静态目录或 WebSocket 路径时，不得绕过 `server.mjs` 请求处理器开头的 `requestAccess()` 与 `isTrustedLocalRequest()`。Electron 主进程用 Node `fetch` 访问服务时必须走 `serverFetch()`（它不共享窗口 Cookie）；新窗口若改用非默认 session/partition，必须先写入访问 Cookie。不要让 API 接受 URL 令牌，也不要把令牌写入会议数据、日志文件或 `/api/*` 响应。

---

## 12. 已踩过的坑（不要再踩）

### 12.1 DeepSeek 是推理模型，思考 token 也算进 `max_tokens`

给少了会返回 **HTTP 200 + `content: ""` + `finish_reason: "length"`**
（`reasoning_tokens` 恰好等于 `max_tokens`）。表现为"摘要莫名其妙是空的"。

- 默认模型 ID 为 `deepseek-flash` 和 `deepseek-v4-pro`，其他 ID 应以所选服务的列表为准。
- 当前输出上限：摘要/翻译 4000、纪要 16000、问答 6000；思考模式会占用输出预算。
- **beta.4 已移除旧的「空内容 + length → 预算×3 重试」**：它会让一次任务消耗多轮大预算，旧统计还漏记前面的请求。现在保留旧摘要并提示调整模型或思考模式，不能恢复无提示的预算升级。
- 默认关闭摘要/翻译的 DeepSeek 思考模式；需要推理时可在任务模型中明确开启。官方说明：https://api-docs.deepseek.com/guides/thinking_mode/

### 12.2 `EventEmitter` + `'error'` → 进程崩溃

见 §11.6。同时 `server.mjs` 顶层挂了 `uncaughtException` / `unhandledRejection`
兜底 —— 一个录音进程不该因为一个坏 socket 就死。

### 12.3 PowerShell 5.1 的编码坑

- 含中文的 `.ps1` 必须存成 **UTF-8 with BOM**，否则中文乱码
- `Set-Content -Encoding UTF8` 写出来**带 BOM**，ffmpeg 的 concat 解析器会报
  `unknown keyword 'file'` → 用 `[System.IO.File]::WriteAllLines(path, lines, ASCII)`

### 12.4 ffmpeg concat 需要无 BOM 的列表文件

同上。另外 concat 列表里的路径要 `-safe 0` 才能用绝对路径。

### 12.5 配置全量落盘 → 旧安装冻结能力表

`saveConfig` 写的是**合并后的完整配置**。所以只改 `DEFAULT_CONFIG` 对已有安装无效。
解决：`loadConfig()` 在 `schemaVersion < 2` 时升级内置 ASR 语言能力列表一次；后续保留用户在设置中编辑的语言列表与名称。

### 12.6 日语音频与 MiMo 能力边界

**症状**：用 MiMo TTS 合成"日语音频"，喂给 ASR 得到乱码。

**真相**：`mimo-v2.5-tts` 把日文按**中文音素**念出来，那段音频从来就不是日语。
铁证：把该音频喂给 Groq（世界级日语 ASR），Groq 同样只能转出
`くるにたばわとゅうきでまいひんす…`。复现：`scripts/confirm-tts-hypothesis.mjs`。

**正确做法**：需要日语音频时用 Windows SAPI（`scripts/make-ja-fixture.ps1`，
Haruka/Ichiro/Sayaka/Ayumi 都是 ja-JP 语音）。

**产品规则**：MiMo 官方 ASR 仅列出中文和英文。以前的非正式测试偶尔得到近似日语文字，且混入简体字，不能当作可靠日语识别。当前应用会拒绝把明确选择的日语发送给 MiMo。

### 12.7 Windows 端口保留范围

`netsh interface ipv4 show excludedportrange protocol=tcp` 查。
落在保留范围内绑定会报 **`EACCES`**（不是 `EADDRINUSE`）。
`start.ps1` / `start-app.ps1` 已内置检查。桌面版用端口 `0` 让 OS 自己挑。

### 12.8 Electron 默认拒绝麦克风

不写 `setPermissionRequestHandler` 的话 `getUserMedia` 会失败，
而页面看起来完全正常 —— 录音功能静默失效。`desktop/main.cjs` 已处理并自检。

### 12.9 electron-builder 的 `build/` 目录不会进 asar

`desktop/build/` 是 electron-builder 的 buildResources 目录，
里面的图标**不会**被打进 asar。要用 `extraResources` 显式带出去，
运行时从 `process.resourcesPath` 取。

### 12.10 打包后不能往安装目录写数据

安装目录通常只读。`main.cjs` 用 `MIAOJI_DATA_DIR` 把 `data/` 重定向到
`app.getPath('userData')/data`。

---

## 13. 测试与验证

主要测试在有麦克风时合计 **96 项断言**，分四个层次；另有不联网的回归测试。

### 13.1 层次一：不联网的单元/适配器测试（1 秒）

```powershell
node scripts/test-adapters.mjs      # 25 项
node scripts/test-regressions.mjs   # 翻译关闭、跳过/失败分片进度、WS 统计请求
node scripts/test-storage.mjs       # 写入/替换失败保护旧数据、删除后迟到模型回调
node scripts/test-realtime-timing.mjs   # 发送间隔、长句衔接、重复文字处理
node scripts/test-language-migration.mjs # MiMo 日语限制与旧配置升级
```

用本地 mock HTTP 服务验证：

- OpenAI 兼容适配器：multipart 字段名、`Authorization: Bearer`、`language`、`verbose_json`
- Deepgram 适配器：`Token` 鉴权头、`audio/wav` body、`model=nova-3`、`diarize=true`、query 参数
- 响应解析：segment 时间戳、utterance + speaker
- **说话人拆分集成**：一个音频块含 2 个 speaker → 产出 2 个 segment，起始时间正确偏移
- **路由不变量**：明确选择日语时，MiMo 即使在旧配置中误声明 `ja` 也不会被选

**这是最快的回归网，改了 ASR 或路由先跑它。**

### 13.2 层次二：全链路（需要真实 key，约 3 分钟）

```powershell
node scripts/make-fixture.mjs       # 用 MiMo TTS 合成 5 轮中文会议（约 49 秒）
node scripts/e2e.mjs                # 14 项
```

`e2e.mjs` 会把合成音频当麦克风**灌进真实 WebSocket**（默认 6 倍速），然后断言：
转写分段数、关键名词、翻译覆盖、滚动摘要、结构化纪要（待办/决议）、
用量计费、Markdown 导出、VTT 导出、问答是否引用到时间戳。

> 灌音频速度可调：`$env:E2E_SPEED="6"`。因为时间用逻辑时钟（§11.4），
> 加速不会破坏分句，只会让 interim 合并得更多。

### 13.3 层次三：导入链路（10 项）

```powershell
node scripts/test-import.mjs
```

故意用 **mp3**（而非 wav）上传，强制走 ffmpeg 转码：

- 上传 202、ffmpeg 解码、按静音切分成多段（不是固定 30 秒大块）
- 进度事件、`import-done`
- 音频落成 mp3 可播放、**支持 Range 请求**（拖动进度条）
- 自动生成纪要

### 13.4 层次四：日语路径验证

```powershell
node scripts/make-ja-fixture.ps1         # Windows 日语 SAPI 合成 27 秒真日语
node scripts/test-japanese.mjs           # 验证日语路由与真实服务全流程
node scripts/confirm-tts-hypothesis.mjs  # 证明乱码来自 TTS
```

测试会验证：

- Groq：有假名，并命中日语会议关键词
- MiMo：明确的日语请求在出网前被拒绝
- 全流程：服务端走 Groq、翻译齐全、纪要生成、计费正确

### 13.5 桌面外壳自检（默认合成麦克风）

```powershell
cd desktop
npm test        # = electron . --selftest；不打开物理输入
npm test -- --reader # 独立阅读器生命周期；无录音采集
```

真的把 Electron 跑起来，然后断言：

- 窗口、服务握手、服务进程存活、托盘、体检
- **全局快捷键真的注册成功**（失败会给候补链）
- 休眠锁可用
- preload 桥暴露、页面标题、4 个 tab、状态胶囊、引擎标签
- `getUserMedia`、`AudioWorklet`、**麦克风权限不是 denied**
- 麦克风选择器和刷新入口；若有输入设备，验证能用指定 `deviceId` 打开
- 渲染进程能访问本地 API、`/api/live` 正常
- **设置面板交互**（10 项）：打开 → 渲染所有 provider 行 → body 可滚动未被裁切 →
  滚到底可达 → 切开关**能持久化** → 抽屉保持打开 → × 关闭 / Esc 关闭 / 点背景关闭 / 按钮 toggle
- Flash/Pro 切换、思考模式、服务切换后模型发现、手动 ID、摘要间隔与字数门限保存。模型发现使用 mock；配置写入经过真实本机 API。自检和截图使用临时数据与凭据目录，避免改写用户设置。
- `node scripts/test-llm-cost.mjs`：完全离线检查实际请求模型 ID、思考参数边界、截断不增额重试、HTTP/JSON 重试用量、摘要游标并发及落盘、各文本任务统计与门限。
- 新增 5 项外观自检：主题/参数通过 IPC 保存、本机偏好文件、origin 存储为空时恢复、主题参数隔离、重置范围；beta.7 另含独立阅读器、摘要入口、图表标签、公式、图片和 PDF 自检，总计 70 项。`scripts/test-appearance.mjs` 另覆盖旧明暗模式、损坏/不可用存储、数值范围、颜色校验、系统模式与文字对比色。

### 13.6 回归清单（提交前）

```powershell
# 1. 语法
Get-ChildItem -Recurse -Include *.mjs,*.cjs | ForEach-Object { node --check $_.FullName }

# 2. 快测
node scripts/test-adapters.mjs
node scripts/test-regressions.mjs

# 3. 改了什么就补跑什么
node scripts/e2e.mjs
node scripts/test-import.mjs
node scripts/test-japanese.mjs
cd desktop; npm test
```

---

## 14. 开发工作流

### 14.1 起服务并热改

服务端**没有热重载**，改 `lib/` 或 `server.mjs` 后要重启。
前端（`public/`）是静态文件，刷新页面即可（`cache-control: no-cache`）。

```powershell
node --watch server.mjs 8777     # 服务端自动重启
```

### 14.2 桌面端开发

```powershell
cd desktop
npm run dev      # = electron . --dev，自动打开 DevTools
```

### 14.3 截图验证（改前端必做）

浏览器版（无头 Chrome）：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new `
  --user-data-dir="$env:TEMP\mj" --window-size=1680,1000 --virtual-time-budget=9000 `
  --screenshot="$env:TEMP\miaoji-shot.png" "http://127.0.0.1:8777/?meeting=<id>&settings=1&token=<启动时打印的令牌>"
```

Electron 版（能抓任意深链接状态）：

```powershell
cd desktop
npx electron . --capture=../.probe/shot.png --open=meeting=<id>&settings=1
```

支持的前端深链接：`?meeting=<id>`、`?settings=1`（上次的设置标签页）、`?settings=quick|advanced|appearance`、`?history=1`。
截图产物在 `.probe/`（gitignored），需要时重新生成。

### 14.4 改提示词

只改 `lib/prompts.mjs`。验证方式：造一个会议 → 调 `POST /api/meetings/:id/summarize`
或 `/minutes`，用 `curl`/`Invoke-RestMethod` 看返回。
**不要**为了调提示词去跑完整 e2e（慢）。

### 14.5 加一个新的 ASR provider

1. 在 `lib/asr/` 新建 `xxx.mjs`，导出 `create(cfg, creds)`，实现 §10 的 provider 接口
2. 在 `lib/asr/index.mjs` 的 `FACTORIES` 里注册 `kind`
3. 在 `lib/config.mjs` 的 `DEFAULT_CONFIG.asr.providers` 加一项（`enabled:false`）
4. **在 `scripts/test-adapters.mjs` 里加 mock 断言**（照抄现有 provider 的写法）
5. 若该语言此前没有引擎，更新 `asr.routes`

### 14.6 加一个新的 WS 事件

1. 服务端 `meeting.emit('newthing', payload)`
2. 前端 `handleEvent` 的 switch 加 `case 'newthing'`
3. **在 `desktop/main.cjs` 的自检里加断言**（如果是可验证的 UI 变化）
4. 更新本文档 §9.2

---

## 15. 环境与打包

### 15.1 开发环境

| 项 | 值 |
| --- | --- |
| OS | Windows 10/11；macOS 13+ Apple Silicon（桌面版） |
| Node | 20 或更高版本，加入 PATH |
| npm | 随 Node 安装 |
| ffmpeg / ffprobe | 音视频导入时需加入 PATH |
| Chrome / Edge | 仅 `start-app.ps1` 模式需要 |
| PowerShell | Windows PowerShell 5.1 或 PowerShell 7 |
| 日语 SAPI 语音 | 仅日语测试夹具需要 |
| Electron | ^44.4.5 |
| macOS 发布 | M 芯片 Mac、Xcode、Developer ID Application 证书；公开包需 Apple 公证 |
| electron-builder | ^26.15.3 |

### 15.2 相关环境变量

| 变量 | 作用 |
| --- | --- |
| `MIAOJI_PORT` / 第一个 CLI 参数 | 监听端口；`0` = 让 OS 挑 |
| `MIAOJI_HOST` | 默认 `127.0.0.1` |
| `MIAOJI_DATA_DIR` | 数据目录（打包版指向 userData） |
| `MIAOJI_CONFIG_PATH` | 覆盖 config.json 路径 |
| `MIAOJI_PARENT_WATCHDOG=1` | stdin 关闭即退出（Electron 子进程用） |
| `ELECTRON_RUN_AS_NODE=1` | 让 Electron 二进制当纯 Node 跑 |
| `MIAOJI_ALLOW_ENV_CREDENTIALS=1` | 显式允许读取以 `_KEY` 结尾的进程环境变量；默认关闭 |

### 15.3 启动握手协议

`server.mjs` 监听成功后会在 **stdout 打印一行**：

```
MIAOJI_READY {"url":"http://127.0.0.1:6891/","host":"127.0.0.1","port":6891,"pid":1234,"cwd":"…"}
```

`desktop/main.cjs` 解析这一行才知道服务就绪和真实端口。
**这一行必须保持单行、前缀不变**，否则桌面端会 30 秒超时。

### 15.4 打包产物

| 命令 | 产物 | 大小 |
| --- | --- | --- |
| `npm run dist` / `npm run dist:installer` | `dist/BabelEcho-0.1.0-beta.9-setup.exe` | — |
| `npm run dist:portable` | `dist/BabelEcho-0.1.0-beta.9-portable.exe` | ~100MB |
| `npm run dist:mac` | `dist/BabelEcho-0.1.0-beta.9-mac-arm64.dmg` + `.zip` | 仅 M 芯片；公开分发前签名并公证 |
| `npm run dist:dir` | `dist/win-unpacked/`（免安装目录） | ~368MB |

打包时 `server.mjs` / `lib/` / `public/` 作为 `extraResources` 进 `resources/`，
`main.cjs` 用 `app.isPackaged ? process.resourcesPath : path.join(__dirname,'..')` 定位。

验证打包版：`dist/win-unpacked/巴别回声.exe --selftest`（有麦克风时目前 70 项应全过）。

---

## 16. 已知限制与路线图

### 16.1 已知缺陷（适合作为第一批任务）

| # | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| 1 | `sliceWav()` 是旧接口，导入已改用 `sliceOnSilence()`，无调用方 | `lib/wav.mjs` | 删除或标注 deprecated |
| 2 | 说话人推断只在停顿 ≥1.4s 时轮换，多人抢话会错 | `Meeting.inferSpeaker()` | 见 16.3 |
| 3 | 导入是**串行**分片 ASR，长会议慢 | `lib/import.mjs` | 改成有限并发（3-4），注意限流 |
| 4 | 完整转写全文会随纪要一起发给模型 | `prompts.minutesMessages` | 超长会议需要分块 map-reduce |
| 5 | 前端 `renderMarkdown` 只支持很小的子集 | `public/app.js` | 表格、代码块未支持 |

已修复：前端处理 `import-done`、WS 响应 `stats`、WS 建会语言表达式；另修复空翻译目标被重置、前端会议状态/统计不同步、切换会议时旧内容残留、连接建立前发送录音或导入命令、导入跳过或失败分片时进度停滞、重复导入同一处理中会议。

### 16.2 功能路线图

**高价值**

- **实时翻译字幕**：interim 时就并行翻译，而不是等句子定稿
- **热词 / 术语表**：把用户提供的专有名词塞进 MiMo/Groq 的 prompt 或 Deepgram 的 `keyterm`
  （Groq Whisper 支持 `prompt` 参数，对专有名词提升明显）
- **会议搜索**：把 segments 建 FTS（SQLite FTS5 或简单倒排），支持全文检索
- **批量导入**：一次拖多个文件，队列化
- **导出 docx**：尚未实现；PDF 已通过独立 Markdown 阅读器支持，另保留 md/vtt/txt/json 导出

**中等**

- **本地 Whisper 一键安装**：`local` provider 已就位，缺一个下载 whisper.cpp + 模型的向导
- **说话人声纹记忆**：跨会议记住"这是田中"，见 16.3
- **会议模板**：不同场景用不同纪要 schema（面试 / 复盘 / 客户会议）
- **自动章节 + 时间轴 UI**：`chapters` 已经产出，前端还没画时间轴

**长期**

- macOS x64 / Linux 打包（M 芯片 arm64 已配置；仍需真机权限、签名和公证验证）
- 局域网收音：手机当麦克风（PWA + WS）
- 自动更新（`electron-updater`）
- 会议音频导出为 WAV（目前只有 mp3）

### 16.3 说话人分离的现状与改进方向

**现在**：

- Deepgram 的 `diarize=true` 会返回 utterance 级的 `speaker`，
  `commitSegment()` 会把一块音频拆成多个 segment —— **这是唯一真正的分离**
- 其他引擎靠 `inferSpeaker()`：停顿 ≥1.4s 就轮换到下一个已知说话人
- `resplitSpeakers()` 让 LLM 按语言线索（称呼、应答、问答关系）重新归属
- 逐句请求时 Deepgram 每次都从 0 号编号，跨请求不连贯；`diarizeRecording()` 用整段录音再请求一次，得到整场一致的编号（见文末「句子重组与整场说话人校正」）

**改进方向（按性价比）**：

1. 接 Deepgram 作为默认（$0.26/小时换真分离，最省事）
2. 本地 pyannote-audio 做声纹聚类（免费但要 Python + 模型，且需要一个 FFI 桥）
3. 声纹注册：让用户给"说话人1"录 5 秒样本，之后跨会议匹配（需要 embedding 模型）

---

## 17. 排障手册

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 启动报 `listen EACCES` | 端口落在 Windows 保留范围 | `netsh interface ipv4 show excludedportrange protocol=tcp` 查，换端口（桌面版用 0） |
| 启动报 `listen EADDRINUSE` | 端口被占（可能有旧进程） | `Get-NetTCPConnection -LocalPort <p> -State Listen` 找 PID 后 kill |
| 界面显示"无可用引擎" | provider 未 enabled 或 key 缺失 | 设置面板看 badge：`缺少 XXX` 就粘 key |
| 摘要一直是空的 | LLM 推理 token 吃光预算 | 见 §12.1；看 `finish_reason` 与 `reasoning_tokens` |
| 改了设置开关又弹回去 | `saveConfig` 没原地改 | 见 §11.1 |
| 设置面板下半部分看不到 | flex 子项缺 `min-height:0` | 见 §11.7 |
| 设置面板关不掉 | 关闭按钮没接事件 | `drawerClose` / Esc / backdrop 三个都要接 |
| 日语没有转写 | MiMo ASR 不支持日语，其他日语引擎未就绪 | 在设置中启用 Groq、Deepgram 或支持日语的本地引擎 |
| 转写全是乱码 | **音频本身不是那个语言** | 用 `confirm-tts-hypothesis.mjs` 验一下 TTS |
| 录音没有声音/权限被拒 | 输入设备选错、输入音量低或权限被拒 | 顶部选正确麦克风并点「测试麦克风」；桌面播放声音需勾选「同时录电脑声音」；权限问题见 §12.8 |
| Groq 语音识别 HTTP 429 | 长句的实时预览请求触及每分钟额度 | 新版对 Groq 每约 10 秒更新长句预览、全局限制请求频率，并按 `retry-after` 自动重试；原始录音会继续保存 |
| 上传 m4a 失败 | 没有 ffmpeg | 装 ffmpeg 并确保在 PATH |
| 打包后图标空白 | 图标没进 asar | 见 §12.9，用 `extraResources` |
| 打包后数据写在安装目录 | 没设 `MIAOJI_DATA_DIR` | 见 §12.10 |
| 桌面端 30 秒超时打不开 | `MIAOJI_READY` 握手行被改坏 | 见 §15.3 |
| 快捷键不生效 | 被别的程序占用 | `registerFirst()` 有候补链；看启动日志打印的实际键位 |

**看日志的地方**：
- 服务端：控制台 stdout / Electron 里 `--dev` 模式下的主进程日志（`[server] …` 前缀）
- 渲染进程：DevTools Console
- 免安装模式：`%TEMP%\miaoji-server.out.log` 和 `.err.log`

---

## 18. 术语与文件速查

| 术语 | 含义 |
| --- | --- |
| **utterance / 句** | 一次连续说话，由 VAD 从静音处切开 |
| **interim / partial** | 一句还没说完时的临时识别结果，会被后续替换 |
| **final / segment** | 一句说完后定稿的段落，写进 `segments[]` |
| **stepMs** | 多久重跑一次 interim |
| **silenceMs** | 静音多久算一句结束 |
| **keyRef** | 凭据的**变量名**（如 `GROQ_API_KEY`），config 里只存它 |
| **upstream** | 本场会议实际用到的 ASR 引擎信息 |
| **能力元数据** | `label`/`languages`/`note`；旧配置升级后可编辑名称和语言，但 MiMo ASR 的语言限制为中英 |
| **逻辑时钟** | `Meeting.nowMs()`，基于已接收采样数而非墙上时间 |

### 「我想改 X，该动哪个文件」

| 想改的东西 | 文件 |
| --- | --- |
| 提示词 / 输出格式 | `lib/prompts.mjs` |
| 分句灵敏度、interim 频率 | `lib/config.mjs` 的 `realtime` |
| ASR 厂商 / 模型 / 路由 | `lib/config.mjs` + `lib/asr/*` |
| 总结/纪要用的模型 | `config.json` 的 `llm.roles` |
| 界面布局 / 样式 | `public/index.html` + `public/styles.css` |
| 前端交互 | `public/app.js` |
| 桌面端能力（托盘/快捷键/通知） | `desktop/main.cjs` + `desktop/preload.cjs` |
| 新增 REST 路由 | `server.mjs` 的 `handleApi()` |
| 新增 WS 事件 | `lib/meeting.mjs` 的 `emit` + `public/app.js` 的 `handleEvent` |
| 会议存储格式 | `lib/store.mjs` 的 `saveMeeting()` |
| 导出格式 | `lib/meeting.mjs` 的 `toMarkdown` / `toVtt` |

---

## 许可

源码采用仓库根目录 Apache-2.0 许可证；品牌和角色图稿的使用边界见根 README。`package.json` 中的 `"private": true` 用于防止误发布到 npm。当前集成测试包位于私有 GitHub Release。使用到的第三方服务：
Xiaomi MiMo API、DeepSeek API、Groq API、Deepgram API，各自的条款与计费另计。


## beta.7：富 Markdown 与独立阅读器

`public/markdown.js` / `markdown.css` 是摘要和阅读器共享的异步渲染入口，使用 Markdown-it、DOMPurify、KaTeX 与 strict Mermaid；失效渲染通过 WeakMap 取消，避免旧会议覆盖新内容。`reader.html/js/css` 提供目录、源码、字号、明暗与打印视图。`desktop/markdown-reader.cjs` 创建独立 sandbox 窗口，`reader-preload.cjs` 仅提供文档快照、文件选择、受限图片、打印/PDF IPC；不暴露录音、凭据和任意文件访问。`markdown-files.cjs` 校验编码、体积和真实路径边界。`--reader` 可单独启动；从阅读器切回工作台时按需创建主窗口及录音外壳。

先运行 `npm ci --prefix desktop`（安装后自动构建资源）或 `npm run assets:markdown`。输出位于被 Git 忽略的 `public/vendor/markdown/`，含本地字体及第三方许可证；无 CDN。核心服务依然无运行时 npm 依赖，源码运行需先准备这些前端资源。`npm run test:offline` 为 11 组（含 `test:markdown`），`npm run desktop:test` 在 Windows 有麦克风环境验证 70 项。摘要只发送已有摘要与新片段，图表不增加调用和输出预算；保存字段仍是原始 Markdown 字符串，无数据迁移。详细格式、资源限制及真机边界见 [Markdown 阅读器](../../docs/MARKDOWN_READER.md)。

## beta.8：Mac 生命周期与本机构建

Dock `activate` 在 `--reader` 且尚未显式打开工作台时，只恢复/聚焦已有阅读器，最后一个阅读器关闭后重建阅读器。通过菜单打开工作台后恢复正常录音外壳行为；录音中关窗保护不变。`reader-lifecycle-selftest.cjs` 以真实 Electron 检查菜单、Dock、重复启动事件、最小化恢复、关窗重开及录音关窗保护。

Mac 主程序及 Helper 使用 `build/entitlements.mac.plist`；内部包使用 `--config.mac.identity=-` 作 ad-hoc 签名并保留音频输入权限，未 Developer ID 签名/未公证。`identity=null` 会跳过权限签名，不能用于可录音的 Mac 包。打包自检读取实际 5 个 bundle 的签名。此修复来自旧 Mac 本地 aac5a89 的已知验证，但 beta.8 不继承其物理麦克风通过结论。

默认自检通过 `synthetic-microphone.cjs` 替换输入设备枚举与采集，不会选择 iPhone 连续互通。物理麦克风须显式 `--selftest-real-microphone`（先核对所选设备和同意），系统声音须显式 `--selftest-real-system-audio`；未执行的物理采集必须列为未验证。屏幕源只请求 ID，缩略图尺寸为零。当前证据见 [Mac beta.8 验证](../../docs/MAC-beta.8-VERIFICATION.md)。


## beta.9：课堂模式、详细纪要与导出范围

顶部使用场景选择 `meeting` / `class`，纪要详细度选择 `standard` / `detailed`（新生成默认详细）。`Meeting.snapshot()`、`store.saveMeeting()` / `restore()` 保存 mode、notesDetail、summaryMode；旧文档缺字段时按会议/详细处理，旧摘要的来源按会议处理，不重写或删除历史输出。新纪要在 JSON 内记录生成时 mode/notesDetail，并可包含 topics、keyConcepts、examples、reviewQuestions；旧字段兼容，UI/Markdown 同步显示额外内容、章节、决策依据与风险影响。

REST 创建和 `PATCH /api/meetings/:id`、WS new/start/config-patch 接入选项；非法枚举被拒绝（恢复旧文档时容错归一化）。切模式不自动调用模型、不清空原摘要；若已有摘要属于旧场景，自动摘要暂缓，用户手动总结时一次从完整转写重建，之后恢复增量。请求完成时校验上下文/选项，防止旧结果覆盖新选择；原输出预算摘要4000/纪要16000及重试计数不变。

MD 导出增加 includeTranscript=0|1，省略参数保留旧 API 全文行为；UI 默认为不勾选全文，并将选择传给原生/浏览器完整阅读器，PDF/打印沿用同一文档。选项仅改变转写附录，不改变本地记录，也不改变 TXT/VTT/JSON。浏览器当前 origin 的偏好保存在 babel-note-options-v1 和 babel-md-include-transcript，Electron 随机端口间不承诺全局偏好恢复；记录本身始终保存场景和详细度。新增 `npm run test:notes`，纳入12组离线套件；实际 Electron 覆盖课堂内容与导出两种范围。见 [功能说明](../../docs/CLASSROOM_NOTES.md)。

## 句子重组与整场说话人校正（2026-11-04）

用户历史（13 场、1050 段）显示两个问题：66% 的段落结尾没有句末标点、71% 的下一段在 300 ms 内紧接着开始（几乎都是同一人），说明大多数段落是被「最长单句」硬切出来的；用 Deepgram 的 3 场会议里 90% 以上被标成说话人1，因为每句单独请求，Deepgram 每次请求都从 0 号重新编号，跨请求不连贯。

**句子重组**（`lib/sentences.mjs`，`Meeting.addText()`）：识别结果先按句末标点（`。！？!?…`、空白或末尾前的 `.`，含后随引号括号）切句；完整句按约 80 字分组，句子不拆；最后的未完句单独成段并标 `open: true`。下一段识别结果若与它同一说话人且间隔 ≤1.5 s，就把开头接到这句上（`segment-update` 带 `text/end/open`），句子完整或累计 240 字后定稿。未完句在换人、间隔过长、暂停、结束、导入完成、启动恢复时一律定稿；`open` 只在未完成时出现，旧会议没有该字段。时间戳按字数在一次识别结果内线性分配。只有定稿的句子进入翻译队列，翻译请求附带前两句作为「仅供理解」的上下文（`prompts.translateMessages({context})`）。实时和导入都经过 `commitSegment()`，行为一致。对历史转写离线回放：结尾无句末标点 690 → 219 段，超过 120 字 378 → 206 段，文本不变。

**整场校正说话人**（`lib/diarize.mjs`，`Meeting.diarizeRecording()`）：会议结束且有音频时，把整段录音（mp3/wav）发送给 `config.speakers.provider`（默认 `deepgram`，必须是已启用、有密钥的 deepgram 类引擎）一次，按词的时间重叠给每段分配多数说话人，无词覆盖的段沿用前一段；按首次出现顺序命名说话人1、2…，替换 `speakers` 表。文字与翻译不变。校正前的标注存入 `speakerBackup {at, speakers, labels:[[index,speaker]]}`（落盘，`snapshot()` 只给前端 `{at}`），`undoDiarization()` 恢复并清空。费用计入 `stats.asr*`。`config.speakers.autoDiarize`（默认 false）为真时，录音结束（`finishRecording`，在生成纪要之前）和导入完成后自动执行，失败只提示并保留原标注。界面：转写区「整场校正说话人」按钮（确认框显示按时长估算的费用）和「撤销校正」，设置中「说话人校正」开关。

已知限制：校正不会把一段拆给两个人（句子重组后段落较短，影响有限）；Deepgram 对中文/日语的分离质量和长录音上传尚未用真实账号验证；Groq/MiMo 实时路径的说话人仍靠停顿推断，需要校正才能区分。验证：`npm run test:sentences`（离线，纳入 14 组离线套件），浏览器中用本机模拟 Deepgram 端点走通「校正 → 2 位说话人 → 撤销」。

## 设置页：快速设置与高级设置（2026-11-04）

设置抽屉分为三个标签页：「快速设置」「高级设置」「外观」。上次打开的标签页存在 localStorage `babel-settings-tab`（不可用时回到快速设置）；配置 schema 没有变化，旧配置原样可用。

- **快速设置**只做三件事：语音识别、文本模型、说话人区分（可选）。每个内置/自定义引擎一张卡片：说明、价格、状态徽章（未启用 / 需要密钥 / 已就绪）、「用于：」实际服务的语言或任务。粘贴 API Key 点「保存并启用」= `POST /api/credentials` + 启用该引擎；「测试连接」复用 `/api/providers/:category/:name/models`，部分服务没有模型列表，失败文案会说明不一定是密钥错误。顶部总览按当前识别语言显示能否开始录音、中/英/日各由哪个引擎转写、文本任务是否可用。
- **自动分配**由 `public/quick-setup.js` 的纯函数决定（浏览器和离线测试共用）：`effectiveAsr()` 与服务端 `pickAsrProvider()` 规则一致（强制引擎 → 语言路由 → 配置顺序中第一个可用引擎）；启用/停用语音引擎后 `routeRepairs()` 只把指向不可用引擎的语言路由改成实际会使用的引擎，可用的路由不改。DeepSeek 就绪且有任务不可用时，自动套用默认分工（flash 做摘要/翻译/问答，v4-pro 做纪要）；其他文本服务用「所有任务改用此服务」并选一个模型。
- **高级设置**保留全部原有选项，按「语音识别引擎（含按语言路由）」「文本模型与任务」「实时识别节奏」「摘要与用量」「说话人校正」分组折叠，展开状态在本次会话中保留。数值、任务模型和开关改动后自动保存（失败或数值无效时在组内提示，不重建抽屉，焦点不丢）；引擎连接设置、密钥、新增/移除引擎仍需点击按钮。
- 验证：`npm run test:quick-setup`（已加入 `test:offline`）穷举引擎启用 × 密钥 × 强制引擎组合，断言 `effectiveAsr` 与 `pickAsrProvider` 一致、修复后的路由不改变实际引擎，以及任务分配能通过 `saveConfig` 校验。

## 操作流程：结束录音、下一步与说话人修正（2026-11-04）

- **顶栏**只留导航：会议标题、计时、状态、引擎、历史、导出、阅读器、设置。明暗切换按钮移除（在「设置 → 外观」里调），界面语言移到底部状态栏；引擎标签在窄窗口里先缩短，设置按钮不会被挤出屏幕。
- **录音区**常用项（识别语言、翻译、麦克风、测试麦克风、电脑声音）直接显示；使用场景、纪要详细度、「结束后自动生成纪要」和刷新设备收在「更多选项」里。
- **结束录音**：按钮改为「结束录音」，WS `stop` 带 `minutes`（取自「结束后自动生成纪要」，存在 localStorage `babel-auto-minutes`，默认开启，保持原有行为）。录音或导入从 recording/paused/processing 变为 stopped 后，转写区上方出现「下一步」卡片：生成/查看纪要（生成中显示进度；失败后可重试）、整场校正说话人（可用时）、导出、新建会议、关闭。打开历史会议不显示该卡片。
- **导出**集中到顶栏「导出」菜单（Markdown 及是否包含转写全文、纯文本、VTT、双语字幕、JSON）；没有打开会议时只显示提示。
- **说话人**：点击句子前的说话人打开就地菜单（不再用 Electron 不支持的 `prompt()`）：改到已有说话人、设为新说话人，或给该说话人全部改名；改成已有名字会合并，先确认。统计页的说话人列表显示句数，可改名，也可「合并到…」其他说话人。服务端 `Meeting.renameSpeaker()` 合并时去掉重复的说话人条目，`setSegmentSpeaker()` 只改一句。整场校正的撤销会恢复校正前的标注，覆盖之后的手动修改。
- **错误横幅**：error/warn 文案涉及密钥、引擎、模型服务或 401/403 时，附「去设置」按钮，直接打开快速设置。
- 未做：会议历史改为左侧栏（仍是抽屉）。验证：`test-sentences` 新增单句改说话人、改名与合并的用例；桌面自检 74/74；浏览器中用临时数据目录检查了顶栏、更多选项、导出菜单、说话人菜单与合并、下一步卡片的各状态（通过模拟 WS 事件），以及 375px 宽度。真实录音结束到纪要生成的完整流程需要配置好的服务再测一次。

## 2026-11 代码审查修复（数据安全与健壮性）

以下是新的不变量，修改相关代码时必须保持：

- **设置文件原子写入**：`config.json`、`credentials.json` 经 `lib/atomic-file.mjs` 先写临时文件再 rename，权限 `0600`（POSIX）。读不出来的文件会被改名为 `*.corrupt-<时间>` 保留，**绝不能**被下一次保存覆盖；`setLocalCred` 返回 `warning` 告知用户其他密钥需要重填。
- **明文 HTTP 仅限本机/局域网**：`assertSafeEndpoint()`（`lib/config.mjs`）在保存配置、创建 ASR 实例、解析 LLM 角色和读取模型列表时检查。允许：HTTPS；或 HTTP 到 loopback、RFC1918、链路本地、CGNAT、`.local`/`.lan`、单段主机名、IPv6 ULA/链路本地。公网明文地址会报错而不是静默发送密钥。
- **实时参数**：`minNewMs` 500–30000，`vadThreshold` 为 (0, 0.2] 的数字。
- **浏览器录音断线缓冲**：`public/app.js` 的 `sendAudio()` 在 WebSocket 重连期间最多缓存约 5 分钟音频，重连后按顺序补发；超出部分会提示丢失秒数。6 次重连失败后停止采集并明确提示，不再假装仍在录音。可选浏览器检查：`node scripts/ui-check-reconnect.cjs`（需要 Playwright）。
- **结束录音**：`finishRecording()` 任何步骤失败最终都落到 `stopped` 并保存；`flushTranslation(true)` 会等待正在进行的批次后继续清空队列（`translating` 现在是进行中的 Promise）。音频写入出错会发出 `audioLost: true` 的错误事件，WAV 头按实际文件大小修补。
- **AI 分角色**按 150 段分批请求，避免长会议输出截断。
- **服务端**：上传直接流式写盘（不再整块读入内存）；导入失败也会保存 `stopped` 状态；Range 支持 `bytes=-N` 并按 RFC 截断结尾；`format=srt` 返回真正的 SRT；下载文件名使用 `filename*=UTF-8''`；奇数字节的音频帧丢弃末尾 1 字节；空闲 30 分钟、已结束且无人连接的会议对象从内存中释放（下次访问从磁盘重新载入）。
- **WebSocket**：握手 `head` 中的字节不再丢弃；分片消息整体也受 64 MB 上限。
- **LLM 重试**：429/5xx 重试时遵守 `Retry-After`（最多 30 秒）。
- **Electron**：麦克风/剪贴板/通知权限只授予本机服务同源页面；主窗口禁止导航到其他来源（外部链接交给系统浏览器）。
- **崩溃恢复锁** `data/tmp/recorder.pid` 在正常退出时删除，避免 PID 复用导致恢复被长期跳过。

验证：`npm run test:offline`（16 套件，新增 `test:review-fixes`）、`desktop:test` Electron 自检 73/73（Linux/Xvfb）、`scripts/ui-check-reconnect.cjs` 浏览器断线测试。Windows/macOS 上的打包与托盘行为仍需在对应系统验证，见 `docs/HANDOFF_2026-11_REVIEW_FIXES.md`。
