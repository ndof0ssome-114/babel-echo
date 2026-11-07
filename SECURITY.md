# 测试版安全说明

巴别回声目前是本机单用户测试版，没有账户、角色权限或加密的本地密钥库。不要把 `MIAOJI_HOST` 或 `server.host` 配置为公网或局域网地址。浏览器界面、REST API 和 WebSocket 仅预期通过 `127.0.0.1`、`localhost` 或 `[::1]` 访问。

本机服务每次启动生成随机访问令牌。页面、静态资源、API 和 WebSocket 都必须携带它：Electron 在默认会话写入 HttpOnly、SameSite=Strict 的端口专属 Cookie，并以 `Authorization: Bearer` 调用 API；浏览器模式需打开启动时终端打印的 `?token=` 链接，服务端换成同样的 Cookie 后跳转到不含令牌的地址。API 不接受 URL 令牌。它阻止同机其他系统用户、容器或不带 Origin 的跨站 GET 读取会议、修改服务商地址或借「读取模型列表」把已保存密钥发往他处。它不防御以同一系统用户运行的恶意程序：此类程序本可直接读取数据目录里的凭据。令牌会出现在 Electron 子进程环境/标准输出与终端日志中，请勿分享启动链接。

提交代码前运行 `git status --ignored --short` 并检查待提交清单。不要提交 `data/`、`config.json`、`.env*`、API Key、会议转写、录音、上传文件、日志或打包结果。若密钥已经进入远程仓库，先撤销或轮换密钥，再清理仓库历史；只更新 `.gitignore` 无法抹去历史记录。

发现安全问题时，请通过 GitHub 的私密漏洞报告功能（如可用）或仓库所有者的私下联系方式报告；不要把密钥、会议内容或可利用细节写入公开 Issue。

Markdown 阅读窗口使用独立的 sandbox preload，不暴露录音、设置、凭据或任意文件读写接口。原始 HTML 不执行，渲染结果经 DOMPurify 处理；Mermaid 使用 strict 模式、禁用 HTML 标签及配置指令，图表以净化后的 SVG 图片显示。主窗口和阅读窗口均以 CSP 限制资源来源。网络图片不自动加载；本地图片只允许已选择文档真实目录内的 PNG/JPEG/GIF/WebP/AVIF/BMP，阻止路径穿越和符号链接越界，不加载外部 SVG。文档限 2 MB，单图限 8 MB，每次最多 64 张本地图片、总量约 32 MB；图表最多 16 张，每张限 20,000 字符/500 条边，任务并发有界。Markdown 方言中的任意 HTML/脚本、外部插件和初始化指令不属于支持范围。
