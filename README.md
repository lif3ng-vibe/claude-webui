# claude-webui

本地、单用户、无鉴权的 web 工具，围绕 Claude Code session 与多 LLM provider 打造：查看/续接 session、对话、网页终端、桌面端，外加**飞书机器人**远程续接与**多 provider 中转网关**（可观测 LLM 代理）。详见 [`docs/design.md`](docs/design.md)。

## 功能

1. **Claude session 查看 / 续接 / 深问** — 只读 `~/.claude/projects/**`，浏览工作目录 → session → 消息时间线（markdown + 代码高亮 + 搜索）；续接 session 发指令（CLI 包裹 `claude --resume`，SSE 流式，per-sessionId 锁防分叉）；就某一步向 LLM 深问（只读磁盘工具查证）。
2. **Anthropic 对话** — 预置系统提示词库 + 流式对话；多 provider 配置（UI 管理 + 切换），兼容任何 Anthropic 兼容代理。
3. **网页交互终端** — 浏览器里 xterm.js 经 WebSocket 跑 `claude --resume` 的原生 TUI（node-pty）；选中 Ctrl+C 复制、Ctrl/Cmd+V 粘贴。
4. **桌面端（Electron + Tauri 双构建）** — 同一套 web 前端，托盘保活、无边框标题栏、服务管理页；桌面端常驻即可让飞书机器人 / 中转网关一直在线。
5. **飞书机器人（远程续接 + 通知）** — 支持多个飞书应用，每个绑定一个 Claude session；在飞书发消息即续接该 session，结果以交互卡片增量流式回传；本地任务完成也推飞书。命令 `/sessions` `/use` `/info` `/new <目录>` `/stop`；白名单 + 首个发消息者自动认主 + 上线主动私聊。
6. **多 provider 中转网关（可观测 LLM 代理）** — claude-webui 当 LLM 网关：对外 OpenAI（`/v1/chat/completions`）+ Anthropic（`/v1/messages`）双兼容，按 `model` 路由到配置的 provider，同格式字节透传 / 跨格式自动转换（含流式），每次请求的提示词与返回都可查看（「中转」tab，带测试按钮）。

页面快捷键：`Ctrl/Cmd + +/-/0` 缩放页面（标题栏与主导航不缩放、倍数记忆）；`F12` / `Ctrl(Cmd)+Shift+I` 打开 DevTools（桌面壳；web 走浏览器原生）。

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
