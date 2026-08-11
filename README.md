# claude-webui

本地、单用户、无鉴权的 web 工具，围绕 Claude Code session 与多 LLM provider 打造：查看/续接 session、对话、网页终端、桌面端，外加**飞书机器人**远程续接与**多 provider 中转网关**（可观测 LLM 代理）。详见 [`docs/design.md`](docs/design.md)。

## 功能

1. **Claude session 查看 / 续接 / 深问** — 只读 `~/.claude/projects/**`，浏览工作目录 → session → 消息时间线（markdown + 代码高亮 + 搜索）；续接 session 发指令（CLI 包裹 `claude --resume`，SSE 流式，per-sessionId 锁防分叉）；**目录内新建会话**（桌面端原生选目录框 / web 从已用目录列表选或手输路径，对话框内可选 provider，单发首条指令或交互式终端，建完直接跳转；目录行右侧「+」可直接在该目录新建）；就某一步向 LLM 深问（只读磁盘工具查证）。
2. **Anthropic 对话** — 预置系统提示词库 + 流式对话；多 provider 配置（UI 管理 + 切换），兼容任何 Anthropic 兼容代理。
3. **网页交互终端** — 浏览器里 xterm.js 经 WebSocket 跑 `claude --resume` 的原生 TUI（node-pty）；选中 Ctrl+C 复制、Ctrl/Cmd+V 粘贴。
4. **终端工作区（多标签 + 分屏 + 拖拽）** — 顶栏「终端」进入单 OS 窗口内的多终端工作区：每个终端是一个标签，标签名取自会话的 AI 标题（`~/.claude` jsonl 里 Claude 自己写的 `type:"ai-title"`，无则用首条 prompt 兜底，运行中自动刷新）。**拖拽合并成多标签**（拖标签/组手柄到另一组）；标签栏可在**顶部（横）/左侧（纵，宽度可拖）**切换；标签组之间可**左右并排 / 上下堆叠分屏**，拖到终端区边缘半区即沿该方向分屏，分隔条可拖调宽高；标签可任意跨组拖拽重组。布局持久化（`~/.claude-webui/workspace.json`），重开自动恢复各自重连。任一组可**弹出到独立 OS 窗口**、再**收回**（混合窗口模型）。终端实例与布局解耦，拖动只搬 xterm 容器、连接与历史不丢。不影响现有「🖥 开独立终端窗口」行为。
5. **桌面端（Electron + Tauri 双构建）** — 同一套 web 前端，托盘保活、无边框标题栏、服务管理页；桌面端常驻即可让飞书机器人 / 中转网关一直在线。
6. **飞书机器人（远程续接 + 通知）** — 支持多个飞书应用，每个绑定一个 Claude session；在飞书发消息即续接该 session，结果以交互卡片增量流式回传（运行中显示思考 token 进度）；本地任务完成也推飞书。`/sessions` 列表带「进入会话 / 翻页」按钮（点击等价 `/use`），`/use` 切换后回显上一轮用户 prompt + agent 回复；切到**正在运行**的 session 会警告并发分叉并给「结束它并由飞书接管」按钮（kill 那个 claude 进程，飞书成唯一写入者、单线续接）。命令 `/sessions` `/use` `/info` `/new <目录>` `/provider [名称|id|off]` `/stop`；白名单 + 首个发消息者自动认主 + 上线主动私聊。
7. **多 provider 中转网关（可观测 LLM 代理）** — claude-webui 当 LLM 网关：对外 OpenAI（`/v1/chat/completions`）+ Anthropic（`/v1/messages`）双兼容，按 `model` 路由到配置的 provider，同格式字节透传 / 跨格式自动转换（含流式），每次请求的提示词与返回都可查看（「中转」tab，带测试按钮）。

页面快捷键：`Ctrl/Cmd + +/-/0` 缩放页面（标题栏与主导航不缩放、倍数记忆）；`F12` / `Ctrl(Cmd)+Shift+I` 打开 DevTools（桌面壳；web 走浏览器原生）。

**新建会话选 provider / 选目录**：「+ 新会话」对话框内可直接选 **provider**（下拉：默认=走 claude 自身 `~/.claude/settings.json` 配置，即 cc-switch 当前选中；或任一已配 provider，经 `claude --settings` 把该 provider 的 `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`MODEL` 注入这次启动，一次性不持久化）。**选目录**：桌面端弹原生文件夹框；web 端点「选择目录…」从已用工作目录列表里挑，全新目录手输。主页每个目录行右侧有「+」，点击直接在该目录下新建；外层「+」按钮与目录行「+」右键均可预选 provider 进对话框。续接 `发送`、🖥 终端、📋 复制命令三个按钮仍支持右键 → 选 provider（机制同上）。用 `--settings` 而非环境变量，是因为 `~/.claude/settings.json`（cc-switch 等工具写）的 env 会覆盖进程环境变量，`--settings` 优先级更高才能盖过。左键不选 = 走 claude 自身配置（即 `~/.claude/settings.json`，cc-switch 当前选中）。

约定见 [`CLAUDE.md`](CLAUDE.md)。

## 技术栈

- 后端：Node + TypeScript（`src/`），`node:http` + SSE + WebSocket
- 前端：Vue 3 + Vite + TS + UnoCSS + VueUse + Naive UI + Pinia + @tanstack/vue-query + markdown-it + Shiki（`web/`）
- 桌面：Electron（`electron/`）+ Tauri（`src-tauri/`）
- 关键依赖：`@anthropic-ai/sdk`、`@larksuiteoapi/node-sdk`（飞书）、`node-pty`（终端）、`ws`
- 持久化：`~/.claude-webui/` 下 JSON 文件（config / prompts / conversations / feishu / gateway / window-state / logs）

## 运行

### web 开发（双进程，热更新）

```bash
npm install              # 后端依赖
npm run dev              # 后端 API：http://localhost:3000

cd web && npm install    # 前端依赖
cd web && npm run dev    # 前端 UI：http://localhost:5173（代理 /api 到 3000）
```

开发打开 **http://localhost:5173**。

### 桌面端开发

- **Electron**：先 `npm run dev`（sidecar 3000）+ `cd web && npm run dev`（Vite 5173），再 `npm run dev:electron`（窗口指 5173）
- **Tauri**：`npm run dev:tauri`（一条命令：自拉 sidecar + Vite + 桌面窗口）

> 三种运行时（web / Electron / Tauri）共用同一 sidecar(3000) + 前端，**不能同时跑**（都占 3000）。

### 构建

- web 单进程：`npm run build:web` → `npm run dev`（后端 serve web/dist）
- 后端打包：`npm run build:server`（esbuild → `dist-server/server.js`）
- 桌面安装包：`npm run dist:electron` / `npm run build:tauri`；**打 tag `v*` CI 自动构建** Win + Mac（mac x64 在 macos-latest 交叉编译）
- **Electron 与 Tauri 可共存**：两者身份已区分——Electron `appId=app.claude-webui.electron` / `productName=claude-webui (Electron)`，Tauri `identifier=app.claude-webui.tauri` / `productName=claude-webui (Tauri)`。安装目录、快捷方式、卸载条目各自独立，可同时安装并同时运行（端口生产环境随机分配、单例锁互不影响）。两端共享 `~/.claude-webui` 数据；同时运行时避免在两端编辑同一条对话或同一份配置即可。
- **版本随 tag**：打 `v1.2.3` 时 CI 用 `scripts/sync-version.mjs` 把该版本写入 Electron + Tauri 四处版本来源，产物内嵌版本与 Release tag 一致、两端相同；本地手动构建可 `node scripts/sync-version.mjs <x.y.z>` 对齐。

## 配置

provider / 飞书 / 网关 都在 UI ⚙ 设置里配，存 `~/.claude-webui/config.json`（GET 不回密钥）：

- **provider**：类型（Anthropic / OpenAI）+ baseURL + key + model
- **飞书**：每个应用 appId / secret / 白名单 open_id / domain / 绑定一个 session
- **网关**：可选 gateway key（留空 = 本地不校验）

也可用环境变量：`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`。

## 测试 / 检查

```bash
npm test            # 后端单测（vitest）
npm run typecheck   # 后端类型检查
cd web && npm run typecheck   # 前端类型检查（vue-tsc）
```

## 安全

- `~/.claude` 只读，绝不写回 session jsonl。
- 密钥（provider key / 飞书 appSecret / gateway key）只存后端、不回传前端。
- 续接以 `--dangerously-skip-permissions` 运行 `claude --resume`，会真实修改目标 session 及其工作目录——UI 发送前有确认。
- 深问磁盘工具只读（read_file/list_files/grep），作用域限 session cwd + `~/.claude`，路径越界拒绝。
- 飞书机器人仅白名单 user_id 可触发；中转网关可选 gateway key。
