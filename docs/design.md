# claude-webui — Design & Requirements

> 本文件是随 git 仓库走的**正式需求/设计文档**。新 Claude 会话读这里即可获取原始需求与当前状态。代码以本文件为准；`~/.claude/projects/<cwd>/memory/` 下的项目记忆是本地镜像，可能滞后。

## 1. 定位

**本地、单用户、无鉴权**的 web 工具，把两件事放一个 UI：

1. **Claude session 查看与续接** —— 只读 `~/.claude/projects/**`，浏览工作目录 → session → 消息时间线；可续接一个 session 或向它发指令（包 `claude` CLI）。
2. **Anthropic 对话 + session 步骤深问** —— 纯对话（预置系统提示词库，跨模型测能力）；"就 session 里某一步向 LLM 提问"，用**只读**磁盘工具让 LLM 读真实文件解释。

## 2. 硬规则（不可违反）

- `~/.claude` **只读**，绝不写回 session jsonl / `history.jsonl`。
- API key 只存在后端，前端永不接触原始 key；密钥不回传（GET 只给 `hasAuth` 布尔）。
- 永不读取或显示敏感文件：`settings*.json` / `mcp.json` / `.env` / `.ssh` / `.gnupg`。
- 续接 session 前置：每个 `sessionId` 加锁，禁止并发写同一 session（并发写 = session 分叉的根因）。
- 续接以 `--dangerously-skip-permissions` 运行 `claude --resume`，会真实修改目标 session 及其工作目录——UI 发送/复制 resume 前弹确认。

## 3. 已定决策

| # | 决策 | 选择 |
|---|------|------|
| 1 | 受众/部署 | 单用户、纯本地、无鉴权 |
| 2 | 续接机制 | CLI 包裹（`claude --resume`），不重建消息发 API |
| 3 | provider 半边 | 纯对话 + 预置系统提示词库；工具调用只用于"就 session 步骤深问" |
| 4 | 磁盘工具作用域 | 只读；范围 = session cwd + `~/.claude`（只读）。无写入 |
| 5 | CLI 执行模型 | 每条指令一次性 spawn `claude --resume <id> -p ... --output-format stream-json --dangerously-skip-permissions`；prompt 经 stdin 传入（非参数，避免 shell 注入）；per-`sessionId` 锁。`--resume` 默认不 fork（沿用同一 sessionId）。另有交互式终端（node-pty 常驻跑 `claude --resume`，见 §11），共享同锁 |
| 6 | 权限 | 全开 `--dangerously-skip-permissions`；`ClaudeRunner` 接 `allowedTools`/`disallowedTools`（默认空 = skip），白名单是配置开关 |
| 7 | providers | v1 只 Anthropic（对话/提示词测试/工具查证全走 Anthropic，家族内多模型对比）；多 provider **配置**已做（页面管理 + 持久化 + 切换），纯对话多 provider 可用；工具查证跨家仍只 Anthropic 兼容 |
| 8 | 后端运行时 | Node + TypeScript |
| 9 | 前端栈 | Vue 3 + Vite + TS + UnoCSS + VueUse + Naive UI + Pinia + @tanstack/vue-query + markdown-it + Shiki |
| 10 | 对话 UI 路线 | 自写（无 chat 专用库）—— `assistant-ui` 只有 React，是选 Vue 的已知代价 |
| 11 | 传输/存储 | SSE（对话/续接/深问）+ WebSocket（网页交互终端，§11）；JSON 文件存 `~/.claude-webui/`（`config.json`、`prompts.json`、`conversations/<id>.json`、`window-state.json`、`logs/sidecar.log`） |

## 4. 功能需求（已完成）

### 4.1 Sessions 视图（读侧）
- 三级浏览：工作目录（解码编码目录名 → 真实 cwd，权威 cwd 来自 jsonl `cwd` 字段）→ session 列表（sessionId、最后活动、消息数、首条人类 prompt 预览、大小、最近更新时间）→ 消息时间线。
- 搜索：关键字过滤目录/session 名称 + **session 内消息内容**搜索；命中高亮（标签间文本插入，不破坏 markdown）；目录命中但无 session 命中不展开；N/M 计数。
- 排序：目录（最近更新/字母）、session（更新时间/名称/大小）各自可选；最近更新排序由后端 `/api/projects` 返回 `latestMtimeMs`，初始即生效。
- 展开/收起：三角图标旋转 90° 动画；"全部收起"图标按钮。
- markdown 渲染（markdown-it）+ Shiki 代码高亮（懒加载 github-dark）；`tool_use`/`tool_result` 用 `<details>` 折叠。
- 运行中会话状态标记：`/api/running` 读 `~/.claude/sessions/<pid>.json`，列表显示"忙/闲"徽标（busy 绿色脉冲 / idle 灰），3s 轮询。

### 4.2 续接 session
- 选中 session 后底部 composer（textarea + 发送 + 停止，Ctrl/Cmd+Enter）。
- 发送 → POST `/api/.../run` → SSE 流式：stream-json 按行解析为 assistant/tool/result/exit 的"虚线 live 块"追加到时间线。
- 若该 session 正在另一终端运行（列表显示忙/闲），点继续弹"可能分叉"警告。
- 另有**交互式终端**（网页里跑 `claude --resume` 的 TUI，§11），与单发 composer 并存、共享 per-sessionId 锁互斥；session 行/详情页 🖥 按钮进入。

### 4.3 深问（就 session 步骤向 LLM 提问）
- 每条 user/assistant/tool 消息有 🔍问 按钮 → 弹问题 → POST `/api/study` → agent 循环（模型调 `read_file`/`list_files`/`grep` 只读工具 → 执行 → 回填 `tool_result` → 继续，最多 12 轮）→ 流式显示思考/工具/正文。
- 多选若干步一起问：勾选框（可显隐配置）+ Shift 范围选中（仅当上次变化是选中时生效）+ 鼠标拖动矩形框选相交消息 + 选中消息整行淡紫底色。
- 深问也持久化为对话（kind `study`），进对话历史列表。

### 4.4 Anthropic 对话（Chat 视图）
- Sessions/Chat 顶部切换；Chat 左栏 Provider 选择 + 系统提示词编辑 + 预置提示词库（增删，存 `~/.claude-webui/prompts.json`）。
- 流式对话：thinking 灰块 + 正文（markdown）+ 发送/停止；多轮历史回传；model/baseURL 信息显示。
- **多 provider 配置**：⚙️ 设置弹窗管理 provider（增删改 + 设活动），`providers` 数组 + active + env 内置"默认(env)"兜底；GET/PUT `/api/config` 持久化，密钥不回传；Chat 选 provider。

### 4.5 对话持久化（chat + 深问）
- 每条对话存 `~/.claude-webui/conversations/<id>.json`（kind `chat`/`study`，含 messages）。
- 对话历史列表：左侧"对话历史"，标聊天/深问；点列表项加载查看；可**追问**（接着发，追加到同一对话）；列表项可**删除**（🗑）、可**隐藏**（▾ 折叠）。

### 4.6 可查看完整请求
- 发给 provider 的完整请求（model/max_tokens/system/messages/tools）作为一个 `request` 事件随 SSE 发回前端；UI 里"请求 #N"折叠查看。深问多轮会有多个请求。

### 4.7 复制 resume 命令
- 每个 session 行有 📋 按钮，复制 `cd "<cwd>" && claude --resume <sessionId>` 到剪贴板；若该 session 正在运行，弹分叉警告。

### 4.8 显示/排序设置（持久化）
- 设置弹窗：时间线显隐（工具调用/工具结果/思考/复选框）、侧栏显隐（计数徽章/session 子标题/目录更新时间）、目录排序、session 排序。
- Ctrl/Cmd 点击复选框 = 该组内只选当前一项。偏好持久化到 localStorage（VueUse `useStorage`）。

### 4.9 其他
- favicon（蓝紫渐变 + 终端提示符 SVG）。
- session 消息加载/刷新后滚到底 + 回到顶部按钮。

### 4.10 新窗口打开 + per-page title/favicon
- 主页 `/` 不引入路由切换，Sessions/Chat 仍由 Pinia `ui.view` 顶栏 tab 驱动，URL 恒为 `/`。
- "新窗口打开" = 把某列表项弹成**精简单页 shell**（独立窗口）：只渲染该项 + 其全部操作，无 Sessions/Chat 顶栏，不能切同级列表项；父子可下钻，顶栏"← 返回"仅父子钻取间出现（按 `window.history.position > 0` 判定）。
- 路由（vue-router，**history 模式**）：
  - `/projects/:dir` —— 单工作目录（session 列表 + 搜索/排序），下钻到 session。
  - `/projects/:dir/sessions/:sid` —— 单 session（时间线 + 续接 + 深问入口）；深问落库后同窗口钻取到 `/conversations/:id`。
  - `/conversations/:id` —— 单对话（查看 + 追问，kind=chat/study 决定 title/favicon）。
  - `:dir` 用 pathEncoding 的 encoded 形式，与 `/api/projects/:dir/...` 对齐。
- 触发点（主页 + 精简 shell 都有）：每个工作目录/session/对话历史行有 ↗ 按钮；主页内联展开某项时 header 有 ↗；精简 shell 内同样保留各项操作按钮（📋 复制 resume、刷新、时间线显隐设置、provider/预设/系统提示词、删除等）与 ↗，新窗口可继续打开新窗口。同窗内不切同级列表项；↗ 开的是独立新窗口，不违反此规则。
- title/favicon 纯客户端动态（`router.beforeEach` 按 pattern 设 type 级，页面加载数据后细化 title；conversation 按 kind 切 favicon）。favicon 集：home 终端提示符 / dir 文件夹 / session 终端+光标块 / chat 气泡 / study 放大镜，统一蓝紫渐变 16×16 SVG。
- `openWindow(path)` 抽象层（web 用 `window.open`，桌面端只改这一处）。
- 跨窗口状态同步：BroadcastChannel 广播 mutation → 其他窗口 `queryClient.invalidateQueries` 重新拉；`/api/running` 忙/闲由 3s 轮询驱动天然跨窗口一致。
- 桌面端兼容：客户端启动拉起本地 node server（serve 前端 + SPA fallback + `/api`），窗口加载 `http://localhost:<port>/`，history 模式白拿；title 映射 OS 窗口标题，favicon 无标签页则降级。

## 5. 读取/展示范围

只读 `~/.claude/projects/**` + `~/.claude/sessions/**`（运行状态）。`history.jsonl`/`stats-cache.json`/`memory/`/`settings*`/`mcp.json`/`plans`/`tasks` 全部 defer。

## 6. 架构

### 后端（`src/`，Node + TypeScript）
```
config.ts              # 配置：providers 数组 + active + env 兜底；resolveProvider(id)
conversations.ts        # 对话存储：list/get/save/remove，存 ~/.claude-webui/conversations/
prompts.ts              # PromptsStore：预置提示词库
provider/
  Provider.ts           # Provider 接口（stream + tool-use）；ProviderStreamDelta
  AnthropicProvider.ts  # v1 adapter：@anthropic-ai/sdk 流式，agent 循环，yield request/messages
claude/
  pathEncoding.ts       # encodeCwd（+ 启发式 decode），单测
  FileReader.ts         # 只读访问 ~/.claude/projects/** + sessions（getRunningSessions）
  Runner.ts             # ClaudeRunner：包 claude --resume 一次性子进程；streamChildEvents 抽出便于测试
terminal/
  TerminalManager.ts    # 网页交互终端：node-pty 跑 claude --resume + WebSocket 收发/resize/锁（§11）
tools/fsTools.ts        # 只读磁盘工具 read_file/list_files/grep + 路径越界防护
server/index.ts         # node:http，所有 /api/* 端点 + SSE + WebSocket(/api/terminal) 升级
```
桌面壳（见 §10）：`electron/{main,preload}.ts`、`src-tauri/src/{lib,nodedl,sidecar,window_state}.rs`、`scripts/{build-server,dev-electron,build-electron,dist-electron,dev-tauri}.mjs`。
### 前端（`web/`，Vue 3 + Vite + TS）
```
components/
  SessionsView.vue   # Sessions 读侧 + 续接 + 深问 + 多选 + 拖动框选 + 运行状态 + ↗/🖥 触发点
  ChatView.vue       # 对话 + 历史/加载/追问 + provider 选择 + ↗ 触发点
  ProviderSettings.vue # 多 provider 配置弹窗
  TitleBar.vue       # 无边框自定义标题栏（仅桌面，§10）
views/               # vue-router 双布局（history 模式）
  MainApp.vue        # 主页 / （顶栏 Sessions/Chat/服务 tab，不走路由）
  ItemLayout.vue     # 精简 shell（仅父子钻取间显示"← 返回"）
  DirPage.vue        # /projects/:dir 单工作目录
  SessionPage.vue    # /projects/:dir/sessions/:sid 单 session
  ConversationPage.vue # /conversations/:id 单对话 + 追问
  ServicePage.vue    # /service 桌面端服务管理（§10）
  TerminalPage.vue   # /terminal/:dir/:sid 网页交互终端（§11）
router/index.ts      # 路由表 + beforeEach 设 type 级 title/favicon
stores/
  session.ts  ui.ts  display.ts   # Pinia；display 用 useStorage 持久化到 localStorage
composables/useConfig.ts  # /api/config
lib/{render,sse,shiki,head,openWindow,desktop,broadcast}.ts  # head=动态 title/favicon；openWindow→desktop=桌面 bridge 抽象；broadcast=跨窗口失效
```

## 7. 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | providers + active（不含密钥） |
| PUT | `/api/config` | 保存 providers |
| GET | `/api/prompts` / POST / DELETE | 预置提示词库 |
| GET | `/api/conversations` | 对话列表 |
| POST | `/api/conversations` | 保存对话 |
| GET/PUT/DELETE | `/api/conversations/:id` | 单条对话 |
| GET | `/api/projects` | 工作目录列表（含 latestMtimeMs） |
| GET | `/api/projects/:dir/sessions` | session 列表 |
| GET | `/api/projects/:dir/sessions/:sid/messages` | 消息时间线 |
| POST | `/api/projects/:dir/sessions/:sid/run` | 续接（SSE） |
| POST | `/api/chat` | 对话（SSE） |
| POST | `/api/study` | 深问（SSE，含 request/messages 事件） |
| GET | `/api/running` | 运行中会话状态 |
| WS | `/api/terminal/:dir/:sid` | 网页交互终端（WebSocket + node-pty，§11；二进制=终端 IO，文本=resize/exit/error） |

## 8. 运行

- **web 开发**：后端 `npm run dev`（3000，API）+ 前端 `cd web && npm run dev`（Vite 5173，代理 `/api` 到 3000）。UI 用 http://localhost:5173。
- **单进程构建**：`npm run build:web` → 后端 `npm run dev` serve `web/dist`（http://localhost:3000）。
- **桌面端开发**：
  - Electron：先 `npm run dev`（sidecar 3000）+ `cd web && npm run dev`（Vite 5173），再 `npm run dev:electron`（窗口指 5173）。
  - Tauri：`npm run dev:tauri`（Rust 自己拉起 sidecar tsx@3000，beforeDevCommand 起 Vite 5173）。
- **桌面端构建**：`npm run build:server`（esbuild 打包 `src/server` → `dist-server/server.js`）；`npm run build:electron`（web+server+electron-builder `--dir`，未做安装包）；`npm run build:tauri`（tauri build）。
- 测试：`npm test`（29 测试）；类型检查：`npm run typecheck` + `cd web && npm run typecheck` + `tsc -p electron/tsconfig.json`。

## 9. v2（动手前先回来和用户确认）

- 多 provider **工具查证**跨家：OpenAI 兼容 function-calling 格式与 Anthropic tool-use 不同，需 adapter 适配（纯对话多 provider 已可用）。
- 磁盘工具写入（沙盒临时目录）。
- ~~常驻交互执行模型（B）+ WebSocket 双向~~ —— 已做，见 §11。
- SQLite 持久化（对话多到要搜索/分页时）。
- `memory/` 浏览器、stats dashboard、history-prompt 视图。

## 10. 客户端（Electron + Tauri）

同时提供 Electron 与 Tauri 两种桌面构建，验证"同一套 web 前端被 web / Electron / Tauri 三种运行时承载"的兼容方式；新窗口功能三端均可用；现有 web 功能不变。

### 10.1 架构决策（已确认）
- **统一 Sidecar**：Node 后端在两端都作为独立 HTTP 子进程被 shell 拉起，前端统一加载 `http://localhost:<port>/`，两端对称。dev 用 `tsx` 跑源码（PORT=3000 对齐 Vite proxy），prod 用 `node dist-server/server.js`（PORT=0）。
- **共享产物**：`npm run build:server` 用 esbuild 把 `src/server` 打成单个 ESM `dist-server/server.js`（`@anthropic-ai/sdk` 纯 JS 可打包）。`src/server/index.ts` 的 `WEB_DIR`/`DIST_DIR` 改为 env 可覆盖（`CLAUDE_WEBUI_WEB_DIR`/`CLAUDE_WEBUI_BUNDLE`），因打包后 `import.meta.url` 指向 bundle 目录。`server.listen` 握手：`CLAUDE_WEBUI_HANDSHAKE=1` 时首行 stdout 写 `CLAUDE_WEBUI_PORT=<实际端口>`（绑 port 0 时用 `server.address().port`）；日志写 stderr JSON。
- **Node 按需下载**：优先系统 `node`（≥18）；缺失则下载固定 Node 22 LTS 到 `~/.claude-webui/cache/`。源默认官方 `nodejs.org/dist`，npmmirror 备选；SHA256 校验；系统 `tar -xf` 解压。Electron 用 JS、Tauri 用 Rust（reqwest+sha2），两端对称。
- **端口 0 + 单实例 + 新窗口复用**：sidecar 绑端口 0、握手回传实际端口；二次启动唤出已有主窗口；`openWindow` 在同 shell 内创建新 OS 窗口指同端口，不另起 sidecar。
- **兼容性接口**：shell 在页面加载前注入 `window.__claudeWebuiDesktop = { kind, openWindow, minimize, toggleMaximize, close, setAlwaysOnTop, isAlwaysOnTop, service: { status, start, stop, restart, getLogs, onLog } }`。Electron 用 preload+`contextBridge`；Tauri 用 `initialization_script` 包 `__TAURI__`（`withGlobalTauri:true`）。web 下不存在 → `openWindow` 回退 `window.open`，标题栏/服务页隐藏。前端 `web/src/lib/desktop.ts` 读该对象暴露 `isDesktop`/`openWindow`/窗口控制/`alwaysOnTop`；`openWindow.ts` 转发到它，6 处调用点签名不变。
- **无边框自定义标题栏**：`web/src/components/TitleBar.vue`（原生按钮+内联 SVG，非 NButton），主+新窗口都用；Windows 风格右对齐 `[📌置顶][—最小][□最大化][✕关闭]`；拖拽容器同时挂 `-webkit-app-region:drag` 与 `data-tauri-drag-region`，按钮 `no-drag`；标题取 `document.title`（`MutationObserver` 监 `<title>`）。挂在 `App.vue` 的 `<router-view/>` 之上，`MainApp`/`ItemLayout` 的 `h-screen` 改 `h-full`。
- **窗口状态按路由持久化**：`~/.claude-webui/window-state.json` 按路由存 `{width,height,x,y,alwaysOnTop}`，新建窗口还原。
- **服务管理页**：`web/src/views/ServicePage.vue` + 路由 `/service` + MainApp 第三 tab"服务"（`v-if="isDesktop"`）。状态 2s 轮询（`useIntervalFn`）+ 启停/重启按钮；日志 `getLogs()` 历史 + `onLog` 实时 tail（截 5000、自动滚底）。**走 bridge 与 shell 通信，不经 `/api`**——后端挂掉仍可操作。日志 shell 内存环形（~5000）+ 落盘 `~/.claude-webui/logs/sidecar.log`；重启后 shell 把所有窗口 reload 到新端口。
- **托盘**：复用 favicon SVG。关最后窗口→缩托盘（app+sidecar 存活）；菜单 = 显示主窗口 / 重启后端 / 停止后端 / 退出；停止后端 ≠ 退 app；托盘跨后端重启常驻。

### 10.2 文件
- 改：`src/server/index.ts`、`web/src/lib/openWindow.ts`、`web/src/App.vue`、`web/src/stores/ui.ts`、`web/src/views/MainApp.vue`、`web/src/views/ItemLayout.vue`、`web/src/router/index.ts`、根 `package.json`、根 `tsconfig.json`、`.gitignore`。
- 新：`web/src/lib/desktop.ts`、`web/src/components/TitleBar.vue`、`web/src/views/ServicePage.vue`、`scripts/build-server.mjs`、`scripts/dev-electron.mjs`、`scripts/build-electron.mjs`、`electron/{main,preload}.ts`+`tsconfig.json`、`src-tauri/`（`tauri.conf.json`、`Cargo.toml`、`src/{lib,nodedl,sidecar,window_state}.rs`、`capabilities/default.json`）、`.cargo/config.toml`（国内 crates 镜像 rsproxy）。

### 10.3 待办 / 风险
- 完整 dev/prod 运行时验证（dev:electron 三终端、dev:tauri、各自 prod 产物、托盘、单实例、按需下载）需桌面机实测。
- Tauri prod 把 `dist-server`/`web/dist` 作 `bundle.resources`，sidecar 从 `resource_dir` 读；Electron prod 把它们打进 `files`。
- **Electron sidecar 必须脱离 asar（坑，曾导致安装后 `spawn cmd.exe ENOENT` / sidecar 读不到 server.js）**：sidecar 由**外部 node** 运行，只能读真实文件；`dist-server`/`web/dist`/`node-pty` 默认被打进 `app.asar`（asar 在真实 FS 上是单文件），外部进程既不能把它当 `cwd`、也读不到里面的 `server.js`。解法：`package.json` 的 `build.asarUnpack` 列 `dist-server/**`、`web/dist/**`、`node_modules/node-pty/**`（电子 builder 会把它们落到 `app.asar.unpacked/`）；`electron/main.ts` 用 `REAL_ROOT = app.isPackaged ? join(process.resourcesPath,'app.asar.unpacked') : ROOT` 算 `DIST_SERVER`/`WEB_DIR`，`spawn` 的 `cwd` 也用 `REAL_ROOT`（真实目录）。
- **桌面端持久化日志（排查 sidecar 静默失败）**：release 下 `windows_subsystem="windows"` 无控制台，sidecar 启动失败→拿不到端口→主窗口不创建，全程静默。Tauri 把 `log::` 宏 + sidecar stdout/stderr 写到 `~/.claude-webui/logs/desktop.log`（`src-tauri/src/desktop_log.rs`，`run()` 开头 `init`；含 node/server/web 路径与存在性、握手结果）；stderr drain 在握手**之前**就启动，确保 server 启动即崩时崩溃栈也能落盘。Electron 主进程异常/启动诊断写到 `~/.claude-webui/logs/main.log`（`process.on('uncaughtException')` + 启动路径日志），sidecar 输出仍在 `sidecar.log`。
- **Windows `\\?\` verbatim 路径前缀（坑，曾导致 Tauri 安装后无窗口）**：Tauri 的 `resource_dir()` 在 Windows 可能返回带 `\\?\` 前缀的路径，原样当 `node` 脚本路径传过去会让 node 模块加载器报 `Cannot find module`（`\\?\C:\...` 被解析坏）→ 进程退出 → 无端口 → 无窗口。`sidecar.rs` 的 `strip_verbatim()` 统一剥掉 `\\?\`（及 `\\?\UNC\`）前缀后再用于 argv/env（安装路径短，剥掉安全）。
- **Electron 主进程 CJS/ESM（坑，曾导致安装包打不开）**：根 `package.json` 有 `"type":"module"`，而 `electron/tsconfig.json` 编译 `module:CommonJS`，产物 `dist-electron/{main,preload}.js` 是 CJS（开头即 `exports`/`require`）。Node 按最近祖先 `package.json` 的 `type` 判定模块类型——根的 `module` 会让 `.js` 被当 ESM，运行报 `exports is not defined in ES module scope`，app 直接打不开。解法：在 `dist-electron/` 放一个 `{"type":"commonjs"}` 覆盖。**三处构建脚本（`dev-electron`/`build-electron`/`dist-electron`）tsc 之后都必须写这个文件**（`scripts/ensureElectronPkg.mjs` 统一提供）——只改 dev 路径、漏掉打包路径，CI 出来的包照样打不开（此坑已踩）。
- 安装包/签名未做（`electron-builder --dir` + `tauri build` 仅出 unpacked/产物）。
- **双构建共存**：Electron 与 Tauri 用不同身份——`app.claude-webui.electron` / `claude-webui (Electron)` 与 `app.claude-webui.tauri` / `claude-webui (Tauri)`——安装目录、快捷方式、卸载条目各自独立，可同机同时安装与运行（生产环境端口随机+握手 `CLAUDE_WEBUI_PORT`、单例锁互不影响）；两端共享 `~/.claude-webui` 数据，同时运行时避免并发写同一条对话/同一份配置（对话按 `<id>.json` 单文件存，不同对话天然不冲突）。
- dev 下 Electron sidecar 固定 3000，勿与 web 流程的 3000 同时占用。

### 10.4 GitHub CI（`.github/workflows/build-desktop.yml`）
- 触发：`push tag v*`（自动建 Release）+ `workflow_dispatch`（手动，仅 artifact）。
- **版本随 tag**：electron / tauri 两端 job 构建前都跑 `node scripts/sync-version.mjs "${GITHUB_REF_NAME#v}"`（仅 `startsWith refs/tags/v` 触发），把 `package.json` / `web/package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 四处版本统一写成 tag 去掉前缀 `v` 的值。否则 electron-builder 用 `package.json` 的基线版本、Tauri 用 `tauri.conf.json` 的旧值，产物内嵌版本与 Release tag 不符且两端不一致（v0.0.6 时踩过）。手动 `workflow_dispatch` 不触发，沿用仓库基线 `0.0.0`。
- per-OS + per-arch 矩阵：`windows-latest`(x64) + `macos-latest`(arm64) + `macos-latest`(x64 交叉编译)，× {Electron, Tauri}。**不用 macos-13（Intel runner 排队）**：mac x64 改在 macos-latest 交叉编（Electron `--x64` / Tauri `--target x86_64-apple-darwin`，node-pty 1.x 预编译随包自带 darwin-x64）。Windows 出 nsis/msi（x64）。全部未签名。
- 脚本：Electron `npm run dist:electron`（`BUILD_ARCH` 传 `--arch`，`electron-builder --publish never`）；Tauri `tauri build [--target <triple>]`（mac `rustup target add <triple>`）。CI 装根 + web 两套依赖。
- `release` job 仅 tag 触发，用 `softprops/action-gh-release` 汇总所有 `.dmg/.exe/.msi` 上传；upload 按 `runner.os-arch` 命名 artifact。
- 本地 `.cargo/config.toml`（国内 rsproxy 镜像）已 gitignore，CI 走默认 crates.io。
- 已知：mac x64 原用 `macos-13`（Intel runner 排队拥堵）→ 已改在 `macos-latest` 交叉编（见上）。

## 11. 网页交互终端（常驻 `claude --resume` + WebSocket）

在浏览器里用 xterm.js 经 WebSocket 连后端 node-pty 跑 `claude --resume <sid> --dangerously-skip-permissions` 的交互式 TUI，能 `/命令`、实时来回——区别于 §4.2 的单发续接（`-p` 一次性 stream-json）。两套并存、共享 per-sessionId 锁（`runningSessions`）互斥。

- **后端**：`src/terminal/TerminalManager.ts` 的 `createTerminalHandler(reader, lockSet)`：解析 cwd（`reader.getSessionCwd`）→ 锁检查（占用则 close 4001）→ node-pty spawn（Windows `cmd.exe /c claude`，其它直接 `claude`）→ PTY 输出按二进制帧发 WS、WS 二进制写入 PTY、文本帧 `{type:'resize',cols,rows}` 调 `pty.resize`；WS 关 → kill PTY + 释放锁（断开即杀）。`src/server/index.ts` 挂 `WebSocketServer({noServer})` + `server.on('upgrade')` 路由 `/api/terminal/:dir/:sid`。`ws` 纯 JS 打进 bundle，`node-pty` 原生模块 esbuild `external`。
- **前端**：`web/src/views/TerminalPage.vue`（xterm + FitAddon + `useResizeObserver`）连 `${ws|wss}://${host}/api/terminal/<dir>/<sid>`；路由 `/terminal/:dir/:sid`（ItemLayout shell）；SessionsView session 行 + SessionPage header 加 🖥 按钮 `popTerminal` → `openWindow('/terminal/...')`。Vite dev proxy 加 `ws:true` 代理 WS 升级。
- **协议**：C→S 二进制=终端输入（UTF-8），文本=`{type:'resize'}`；S→C 二进制=PTY 输出，文本=`{type:'exit'|'error'}`。前端 xterm 拦截 Ctrl+C（有选中则复制剪贴板，无选中放行中断）+ Ctrl/Cmd+V（粘贴剪贴板到 pty）。
- **桌面打包 node-pty**：node-pty 1.x 用 N-API 稳定 ABI，**预编译按平台且随 npm 包自带所有平台**（`prebuilds/{darwin-arm64,darwin-x64,win32-*}`），按需下载的 Node 22 直接兼容，无需匹配 Node ABI、无需跨 arch 抓取。Electron 靠 electron-builder `files: node_modules/**` 自动带；Tauri 把 `node_modules/node-pty` 作 `bundle.resources` 随包，sidecar（ESM bundle）的 `import 'node-pty'` 经**标准 node_modules 向上查找**解析（`<resource_dir>/dist-server/server.js` → `<resource_dir>/node_modules/node-pty`）。⚠️ ESM 的 `import` **不读 `NODE_PATH`**（那是 CJS `require` 专属），sidecar 里设的 `NODE_PATH` 实际不参与解析、只是冗余保留——真正起作用的是平铺的资源布局。
- **资源平铺（坑，曾导致安装后主窗口不显示）**：`tauri.conf.json` 的 `bundle.resources` 若用带 `../` 的字符串路径（如 `"../dist-server"`），Tauri 会把 `..` 编码成字面子目录 `_up_/`，运行时 `resource_dir().join("dist-server")` 就找不到 server.js → sidecar 拿不到端口 → **主窗口从不创建**（且 `windows_subsystem="windows"` 下日志不可见，表现为静默无窗口）。修法：改用 **map 形式**（`BundleResources` 只认「字符串数组」或「source→target map」，**不支持** `{src,target}` 对象数组——后者会让 `tauri build` 在配置解析阶段直接失败）。即 `resources: { "../dist-server": "dist-server/", "../web/dist": "web/dist/", "../node_modules/node-pty": "node_modules/node-pty/" }`，source 带 `../`、target 平铺，资源落到 `resource_dir` 下、无 `_up_`。
- **ESM bundle 的 CJS 全局（坑，同上）**：`build-server.mjs` 产出 `format:'esm'` 单文件，被内联的 CJS 依赖（如 `@larksuiteoapi/node-sdk` 的 `getSdkVersion` 读 `__dirname`）会因 ESM 作用域无 `__dirname/__filename` 而 `ReferenceError` 崩溃，同样卡住握手。banner 必须从 `import.meta.url` 重建 `__filename/__dirname`（`require` 走 `createRequire`），server 才能起。
- **风险/待办**：spawn claude 显式设 `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`（防继承 `CLAUDE_CODE_CHILD_SESSION` 导致不写 transcript、Sessions 视图看不到新对话）。CI mac x64 已改 macos-latest 交叉编（不再排 macos-13）。

## 12. 飞书机器人（远程续接 session + 完成通知）

在飞书里用命令切换并续接 Claude Code session，结果以交互卡片增量流式回传；本地（web 单发续接）任务完成/出错也推飞书。设计稿 `docs/superpowers/specs/2026-08-02-feishu-bot-design.md`，实现计划 `docs/superpowers/plans/2026-08-02-feishu-bot.md`。

- **定位**：支持**多个飞书自建应用**（`config.feishu.apps` 数组），每个应用一个独立 Bot 实例、**绑定一个 Claude session**（发到该机器人的消息即续接它绑的 session；未绑定时可用 `/use` 命令切换）；桌面端托盘保活、sidecar 内每 app 跑一条飞书长连接（`@larksuiteoapi/node-sdk` 的 `lark.ws.Client`，出站即可、无需公网）；仅白名单 user_id 可触发，**白名单为空时首个发消息者自动认作创建人（owner）并持久化**；**连接成功后主动私聊 owner 上线消息**。机器人名/头像在飞书平台各自应用里设；代码 best-effort 用「获取应用信息」API 读名字显示（自建应用常权限不足，读不到则用备注名）。
- **后端模块**（`src/feishu/`）：`Bot.ts`（白名单+命令分流+流式续接卡片）、`commands.ts`（`/sessions` `/use` `/info` `/stop` `/help`）、`SessionState.ts`（全局 currentSession + 序号缓存 TTL）、`formatter.ts`（stream-json→飞书卡片 + `Throttle` 节流 + 超长折叠）、`Notifier.ts`（通知目标解析）、`feishuConfig.ts`（配置读写，secret 不回传）、`larkAdapter.ts`（封装飞书 SDK 为 `FeishuSender` + 长连接监听器，事件解析为 `BotMessageEvent`）。
- **共享重构**：`src/claude/SessionRunner.ts` 把「锁→runner→lifecycle」抽成共享驱动器，web SSE、飞书卡片、本地通知都经此；`onFinished` 钩子供通知订阅（`source!=='feishu' && enableNotify && !aborted` 推送）。锁仍是同一个 `runningSessions` Set，web/终端/飞书三方互斥。
- **端点**：`GET /api/config` 带 `publicFeishuApps`（数组，不回 secret）；`PUT /api/feishu/config`（存 apps 数组并重启所有 bot，不动 providers）；`GET /api/feishu/status`（`{apps:[{id,name,appId,state}]}`）；`POST /api/feishu/restart`。
- **配置**（`~/.claude-webui/config.json` 的 `feishu.apps` 数组）：每个应用 `{id, name, appId, appSecret, allowedUserIds, domain(feishu|lark), enableNotify, chatIdForNotify, timeoutMs, boundSession:{dirName,sessionId}}`。旧的单 `feishu:{appId,...}` 自动迁移为 `apps[0]`。secret 留空保留旧值。
- **命令**：`/sessions` `/use` `/info` `/new <目录> <指令>` `/stop` `/help`；纯文本续接当前 session。`/new` 在指定 cwd 创建新 session（`claude -p`，不带 `--resume`），从 stream-json 提取新 sessionId 设为当前。
- **回传**：续接结果 create 一张交互卡片 → stream-json 累加（按 message uuid 去重取最新 content）→ 节流 `im.message.patch`（~1.2s）→ 收尾定稿；正文超长折叠；工具调用/结果用 markdown 代码块。
- **前端**：`FeishuSettings.vue`（appId/secret/白名单/domain/通知开关/chat_id 表单 + 在线状态 3s 轮询徽标），挂在设置弹窗（与 `ProviderSettings` 并列）。
- **打包**：`@larksuiteoapi/node-sdk`（纯 JS，含 axios/protobufjs/lodash/qs）esbuild 打进 `dist-server/server.js`（~6.3MB）。
- **交付边界**：真实飞书联调需用户在飞书开放平台建应用、配「机器人 + 长连接事件 `im.message.receive_v1` + `im:message` 权限」、填 appId/secret/白名单 open_id（见 spec §13）。代码做到配置后即用 + 单测 mock 覆盖（78 测试）。
- **风险/待办**：飞书卡片 markdown 与标准差异（表格/嵌套列表降级为纯文本）；`patch` 频率限制节流参数需实测调；Windows `shell:true` 下 `/stop` 可能延迟；dev/prod 在桌面安装包里 bot 随 sidecar 常驻需实测。

## 13. 中转网关（多 provider 代理 + 请求查看）

claude-webui 充当**可观测的 LLM 网关**：外部工具（Claude Code / Cursor / 脚本）把 base URL 指向本服务，请求转发到配置的 provider，每次请求的提示词与返回都可查看。设计稿 `docs/superpowers/specs/2026-08-02-gateway-p1-design.md`。对外 **OpenAI（`/v1/chat/completions`）+ Anthropic（`/v1/messages`）双兼容**；后端 provider.type 可选 `anthropic`/`openai`；同格式字节透传、跨格式自动转换。

- **模块** `src/gateway/`：`routes.ts`（4 路径分发：两端点 × 两后端，同格式透传 / 跨格式转换 + 记录）、`convert.ts`（请求/响应 OpenAI⇄Anthropic）、`streamConvert.ts`（流式双向事件状态机）、`parseSse.ts`、`recorder.ts`/`store.ts`（记录 CRUD）、`auth.ts`（可选 gateway key）。
- **透传 / 转换**：同格式（入参=后端类型）用 `fetch` 字节透传；跨格式则入参 body 经 convert 转成后端格式发出、响应经 convert/streamConvert 转回客户端格式（流式边读后端 SSE 边转边发）。**不用** `AnthropicProvider`（它跑 agent 循环 + 压缩 messages，破坏保真）。认证 header 替换为 provider 凭证，`anthropic-version` 透传（anthropic 后端）。
- **路由**：`body.model` 精确匹配 provider.model（去后缀比较），无匹配用活动 provider。
- **记录**：`~/.claude-webui/gateway/<id>.json`，`{id,createdAt,providerId,model,stream,request,response,elapsedMs,status,error?}`。
- **认证**：可选 `gatewayKey`（config，留空=本地不校验）；客户端带 `x-api-key` 或 `Authorization: Bearer`。
- **端点**：`POST /v1/messages`（Anthropic 入参）、`POST /v1/chat/completions`（OpenAI 入参）；`GET /api/gateway/logs?q`、`GET/DELETE /api/gateway/logs/:id`、`PUT /api/gateway/key`、`POST /api/gateway/test`（「中转」页测试按钮：用活动/指定 provider 发测试请求并记录，列表标 [测试]）。
- **前端**：`GatewayLog.vue`（列表+详情，复用 `renderContent` 渲染 request/response）+ MainApp 顶栏「中转」tab + 网关 key 设置。
- **交付边界**：真实联调需用户配 provider（baseURL/key/model/type）并把工具 base URL 指向本服务；流式 SSE pipe / 跨格式流式转换在 Node 18+ fetch 上实测。
- **风险/待办**：跨格式流式转换为事件级（覆盖 text/tool_use/finish，不保证字节等价，不支持多模态 image / thinking 转换）；headers 透传边界；OpenAI 系 provider 真实联调待测。