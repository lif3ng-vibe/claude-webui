# 目录内新建会话 + 右键选 provider 启动/恢复 — 设计

> 状态：设计稿，待实现。来源：用户需求（2026-08-04）。
> 关联：`docs/design.md` §4.2（续接）、§4.10（新窗口/路由）、§11（交互终端）、§12（飞书）。

## 1. 背景与目标

当前 claude-webui 的 session 侧只能**续接**（`claude --resume`，web `/run` + 交互终端 + 飞书），无法在 web 里**新建**会话；且所有启动都用进程继承的 env（或 claude 自带配置），不能按需指定某个 provider。

本设计新增两件事：

1. **目录内新建会话**——在任意工作目录（含全新目录）创建新 Claude session，不是 resume。支持两种执行模式：单发首条指令（`claude -p`，复用现有 `ClaudeRunner.runNew`）与交互式终端（fresh `claude`，扩展现有终端）。目录选择：桌面端弹系统文件夹选择框，web 端回退为输入框。新建后**直接跳转**到新 session 时间线。
2. **右键选 provider 启动/恢复**——在「新建 / 续接发送 / 终端 / 复制命令」四类按钮上右键，选一个 provider，把该 provider 的环境变量注入这次启动，实现「特定大模型供应商 × 本次会话上下文」的一次性绑定。**一次性，不持久化**（飞书侧按应用级 `/provider` 命令配置，是该规则的例外——见 §6）。

## 2. 已确认决策

| # | 决策点 | 选择 |
|---|---|---|
| 1 | 新建会话目录选择 | 桌面端原生文件夹选择框；web 回退输入框 |
| 2 | 新建会话执行模式 | 单发 `claude -p`（首条指令）+ 交互式终端，两者都要 |
| 3 | provider 绑定范围（web） | 一次性，不持久化 |
| 4 | 右键 provider 入口 | 新建会话按钮、续接发送按钮、🖥 终端按钮、📋 复制命令按钮（全部） |
| 5 | 新建后跳转 | 收到 `created` 事件直接 `router.push` 到新 session 时间线 |
| 6 | 飞书 provider | 支持：新增 `/provider` 命令设应用级 provider，`/new` 与续接都注入 |

## 3. 统一概念：`providerEnv()` + 「带 provider 启动」

两个功能收敛到同一机制：

- 新增 `providerEnv(providerId?)`：把一个 provider（或活动/env 兜底）解析成 Claude CLI 原生识别的环境变量字典。
- `ClaudeRunner.run` / `runNew` 的请求体新增可选 `env`，merge 进 spawn 的子进程 env（**覆盖** `process.env`，使选中的 provider 生效）。
- 「启动」抽象：左键=不传 providerId（用活动/env，即现状）；右键=选某个 provider → 这次启动注入其 env。

注入的环境变量：

- `ANTHROPIC_BASE_URL`（provider.baseURL）
- `ANTHROPIC_AUTH_TOKEN`（provider.authToken，优先于 apiKey）
- `ANTHROPIC_API_KEY`（provider.apiKey，仅当无 authToken）
- `ANTHROPIC_MODEL`（stripModelSuffix(provider.model)）

> claude CLI 只说 Anthropic 协议。openai 类 provider 直连大概率不工作——菜单照常列出（用户自负；多数中转/网关 baseURL 本就是 Anthropic 兼容）。

## 4. 后端设计

### 4.1 `src/config.ts` — `providerEnv` + `matchProvider`

```ts
/** 解析某 provider（或 active/env 兜底）为 claude CLI 识别的 env 字典。 */
export async function providerEnv(providerId?: string): Promise<Record<string, string>> {
  const cfg = await resolveProvider(providerId);
  const env: Record<string, string> = {};
  if (cfg.baseURL) env.ANTHROPIC_BASE_URL = cfg.baseURL;
  if (cfg.authToken) env.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
  else if (cfg.apiKey) env.ANTHROPIC_API_KEY = cfg.apiKey;
  if (cfg.defaultModel) env.ANTHROPIC_MODEL = cfg.defaultModel;
  return env;
}

/** 按名称/id 前缀匹配 provider（飞书 /provider 命令用）。返回 id 或 undefined。 */
export async function matchProvider(query: string): Promise<string | undefined>;
```

`matchProvider` 顺序：精确 id → name 大小写不敏感相等 → name 包含 → id 前缀；遍历 `publicConfig().providers`（含 env 兜底项）。

### 4.2 `src/claude/Runner.ts` — 请求体加 `env`

- `ClaudeRunRequest` 与 `ClaudeNewRequest` 各加 `env?: Record<string, string>`。
- `run()` / `runNew()` 的 spawn `env` 改为：
  `{ ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1', ...req.env }`（req.env 最后展开 → 覆盖）。
- 把 `src/feishu/Bot.ts` 里的 `extractSessionId(d)` 提升为 `src/claude/Runner.ts` 的导出函数（飞书与新端点共用）。

### 4.3 `src/server/index.ts`

**改动 `handleRun`（续接 `/run`）：** 读 `body.providerId`，`const env = await providerEnv(body.providerId)`，传入 `sessionRunner.runLocked({ ..., env })`。

**新增 `POST /api/sessions/new`（SSE，新建单发）：**

- body：`{ cwd: string; prompt: string; providerId?: string }`。
- 校验 `cwd`（见 §7）。`prompt` 非空。
- 锁：复用共享的 `runningSessions` Set，key 为 `"new:"+cwd`（与新建交互终端共用同一 key，见 §7）；已占用 → `json(res, 409, {error:'该目录正在新建会话'})`。
- `res.writeHead(200, SSE_HEADERS)`，`const env = await providerEnv(body.providerId)`。
- 遍历 `runner.runNew({ cwd, prompt, env, signal })`：
  - 每条 `stream-json`：用 `extractSessionId` 尝试取 sid；**首次取到即发一次** `event: created\ndata: {sessionId, dirName, cwd}`（`dirName = encodeCwd(cwd)`）。
  - `stream-json` / `stderr` / `exit` 事件转发（与 `/run` 一致）。
- 结束发 `done` / `error`。`runningSessions.delete("new:"+cwd)` 在 finally 执行。
- **不接 `sessionRunner.onFinished`**（新会话的完成通知属 YAGNI；新会话时 sid 未知，notify 文案无意义）。

**WS 路由扩展（`server.on('upgrade')`）：** 用 `new URL(req.url).pathname + searchParams` 分发：

- `/api/terminal/new`（query `cwd`、可选 `provider`）→ 校验 cwd → `terminalHandler(ws, { mode:'new', cwd, env: await providerEnv(provider) })`。
- `/api/terminal/:dir/:sid`（现有，resume）→ 增可选 query `provider` → `terminalHandler(ws, { mode:'resume', dirName, sessionId, env: await providerEnv(provider) })`。
- `handleUpgrade` 回调里需 await `providerEnv`：在 `wss.handleUpgrade(req, socket, head, async (ws) => ...)` 前 await 解析 env，再传入。

### 4.4 `src/terminal/TerminalManager.ts` — mode 判别联合

`createTerminalHandler(reader, lockSet)` 返回的处理器签名改为：

```ts
type TerminalOpts =
  | { mode: 'resume'; dirName: string; sessionId: string; env?: Record<string,string> }
  | { mode: 'new'; cwd: string; env?: Record<string,string> };
(ws: WebSocket, opts: TerminalOpts) => void;
```

- `resume`：逻辑同现状（reader.getSessionCwd → 按 sessionId 加锁 → spawn `claude --resume sid --dangerously-skip-permissions`），spawn env 合并 `opts.env`。
- `new`：cwd 直接来自 `opts.cwd`（不查 reader）；锁键 `"new:"+cwd`；spawn 不带 `--resume`（`claude --dangerously-skip-permissions`），env 合并 `opts.env`。
- `cleanup()` 按对应锁键删除。

### 4.5 路径校验（§7 详述）

`/api/sessions/new` 与 `/api/terminal/new` 的 `cwd` 必须绝对路径 + `stat` 存在 + 是目录。

## 5. 前端设计

### 5.1 `NewSessionDialog.vue`（新建会话模态）

字段：

- **目录**：`[选择目录…]` 按钮 → 调 `pickDirectory()`（桌面原生框）；返回 null（web）则显示文本输入框让用户粘贴路径。路径始终在一个只读/可编辑字段里可见。
- **模式**：radio「单发首条指令」/「交互式终端」。
- **首条指令**（仅单发模式）：textarea，必填。
- **启动**：左键=活动 provider；右键→provider 菜单→用所选 provider 启动（见 §5.4）。

行为：

- 单发：`POST /api/sessions/new` SSE（`{cwd, prompt, providerId?}`）。收到 `created` 事件 → `router.push({name:'session', params:{dir:created.dirName, sid:created.sessionId}})` + `broadcastInvalidate(['projects','sessions'])` + 关闭模态。流式过程在模态内显示 live 块（复用 SessionsView 的虚线 live 块渲染思路，简化版）。
- 交互：`openWindow('/terminal/new?cwd=<enc>&provider=<enc>')` + 关闭模态。

触发点：SessionsView 左侧栏 header `+ 新会话` 按钮；DirPage header `+ 新会话` 按钮。

### 5.2 `TerminalPage.vue` 新模式 + 路由

- 路由 `/terminal/new`（query `cwd`、可选 `provider`）：从 query 读 cwd，连 `ws://${host}/api/terminal/new?cwd=<enc>&provider=<enc>`。标题 `新会话 · <cwd>`，favicon 用 session 终端图标。
- 现有 `/terminal/:dir/:sid`：`popTerminal(dir, sid, providerId?)` 拼接 `?provider=` 透传。
- `router/index.ts` 的 `beforeEach` title/favicon 分支补 `/terminal/new`（type 同 session 终端）。

### 5.3 `web/src/lib/desktop.ts` + 桌面壳 — `pickDirectory()`

- `desktop.ts` 暴露 `pickDirectory(): Promise<string | null>`：读 `window.__claudeWebuiDesktop`，调其 `pickDirectory()`；web 下该对象不存在 → 返回 null。
- **Electron**：preload `contextBridge` 暴露 `pickDirectory` → 主进程 `dialog.showOpenDialog({ properties:['openDirectory'] })`，返回选中路径或 null（取消）。
- **Tauri**：新增自定义命令 `desktop_pick_directory`（用 `tauri-plugin-dialog` 的 `app.handle().dialog().file().pick_folder()`，或 `rfd::AsyncFileDialog`；**推荐 tauri-plugin-dialog**，与 Tauri 2 ACL 模型一致）。`src-tauri/permissions/commands.toml` 加 `[[permission]] identifier="allow-desktop-pick-directory" commands.allow=["desktop_pick_directory"]`；`capabilities/default.json` 的 `permissions` 列表 + `remote.urls` 已覆盖 `localhost`（无需改 remote 段）。
- 桌面端 TitleBar/服务页不变。

### 5.4 `useProviderMenu()` + `<ProviderMenu>` 组件

- composable 管理「一个全局右键菜单」：坐标 `(x,y)`、可见性、`onPick` 回调。
- `<ProviderMenu>`：Naive UI `NDropdown`，`trigger="manual"`，`x`/`y` 定位到光标。选项来自 `useConfig()` 的 providers（id/name/model）+ 顶部「默认（活动/env）」。
- 各按钮用法：
  ```vue
  <button @click="launch()" @contextmenu.prevent="menu.open($event, pid => launch(pid))">…</button>
  ```
  `launch(pid?)` 内部：pid 为 undefined → 不传 providerId（活动/env）；否则传 pid。

### 5.5 四处右键入口接法

| 按钮 | 所在组件 | 左键 | 右键选 provider |
|---|---|---|---|
| `+ 新会话` | SessionsView、DirPage | 打开 `NewSessionDialog`（活动 provider） | 打开并预置该 provider |
| 续接 `发送`（composer） | SessionsView、SessionPage | `sendPrompt()` | `sendPrompt(providerId)` → `/run` body 带 `providerId` |
| 🖥 终端 | SessionsView、SessionPage、DirPage | `popTerminal(dir,sid)` | `popTerminal(dir,sid,providerId)` → URL `?provider=` |
| 📋 复制命令 | SessionsView、DirPage、SessionPage | 复制 `cd "cwd" && claude --resume sid`（前端本地拼接） | 调后端端点生成命令（前端无密钥，见下）→ 复制返回串（**弹确认：剪贴板将含密钥**） |

- `sendPrompt` / `popTerminal` / `copyResume` 在三组件各加可选 `providerId` 参数（这三函数在三处有副本，按现有重复模式各自改）。
- **📋 右键复制走后端生成**：provider 的 token 后端不回传前端，故含 provider 的命令必须后端拼。新增 `GET /api/projects/:dir/sessions/:sid/copy-command?provider=<id>` → 返回 `{command}`：无 provider 时返回裸命令 `cd "cwd" && claude --resume sid`（与现状一致）；有 provider 时返回 bash 风格 env 前缀 `cd "cwd" && ANTHROPIC_BASE_URL='..' ANTHROPIC_AUTH_TOKEN='..' ANTHROPIC_MODEL='..' claude --resume sid`。前端 `copyResume(providerId?)`：无 provider 走本地拼接（现状）；有 provider 调该端点。

## 6. 飞书集成（`src/feishu/`）

### 6.1 app 配置加 `providerId`

- `FeishuApp` 与 `PublicFeishuApp` 加 `providerId?: string`（应用级默认 provider；空=env/活动兜底）。
- `normalizeApp` / `saveFeishuApps` / `publicFeishuApps` 增加该字段读写（留空保留旧值，同 appSecret 模式）。
- `FeishuSettings.vue` 表单加 provider 选择（下拉，来自 config providers + 「默认」）。

### 6.2 `/provider` 命令

- `commands.ts`：`CommandContext` 加 `providers: PublicProvider[]`、`currentProviderId?: string`；`CommandResult` 加 `{ kind:'set-provider'; providerId: string | null }`。
- 新增 `cmdProvider(arg, ctx)`：
  - 无参 → 卡片列出所有 provider，标记当前（`currentProviderId`）；无配置则提示用 env 默认。
  - `off` / `default` → `{kind:'set-provider', providerId:null}`。
  - `<名称|id|前缀>` → `matchProvider(arg)` → 命中 `{kind:'set-provider', providerId}`；未命中提示。
- `HELP_TEXT` 加 `/provider [名称|id] — 设置本机器人使用的 provider`。

### 6.3 Bot 注入 env

- `Bot.runNew` 与续接（`runResume`/`sessionRunner.runLocked`）开头：`const env = await providerEnv(this.deps.config.providerId)`，传入 req.env。
- `handleCommand` 收到 `set-provider` → `saveFeishuApps(apps.map(a => a.id===cfg.id ? {...a, providerId:result.providerId ?? undefined} : a))` + 更新内存 `cfg.providerId` + 回卡片确认。
- `/info` 卡片附带显示当前 provider 名（便于排查）。

## 7. 安全 / 边界

- **cwd 校验**（`/api/sessions/new`、`/api/terminal/new`）：`path.isAbsolute(cwd)` + `await stat(cwd)` 是目录；拒绝指向 `~/.claude` 下敏感文件（沿用硬规则：不碰 `settings*.json`/`mcp.json`/`.env`/`.ssh`/`.gnupg`——这些是文件级，cwd 是目录级，正常工作目录不会命中；但仍校验 cwd 不是 `~/.claude` 本身或其 `projects`/`sessions` 子目录，避免误操作 claude 自身状态）。
- **只读 `~/.claude` 不变**：新建会话只往**用户指定工作目录**跑 claude；transcript 由 claude 写入 `~/.claude/projects/<encoded>/<sid>.jsonl`（那是 claude 自身行为，我们仍只读不写）。
- **密钥**：env 注入只在后端进程内，前端永不接触原始 key。仅 📋 右键复制会经后端端点把含 token 的命令字符串发给前端写剪贴板（确认后）。
- **锁**：续接/终端 resume 按 sessionId（不变）；新建单发与新建交互终端**共用**共享的 `runningSessions` Set、统一 key `"new:"+cwd`（同一目录同时只能一种新建，且与该目录已有 session 的 resume 锁不冲突——key 前缀不同）。
- **provider 类型**：env 注入对所有 provider 一视同仁（见 §3 说明）。
- **Windows spawn**：`runNew`/终端 new 沿用 `shell:true`（Windows）与 `ComSpec /c claude`（终端）模式；env 合并不影响该机制。

## 8. 测试

- `providerEnv`：mock `loadConfig`，断言 authToken 优先于 apiKey、空值缺省、model 去后缀。
- `matchProvider`：精确/包含/前缀/未命中用例。
- `Runner.run`/`runNew`：env 合并进 spawn（用现有 fake-runner 模式或断言 args）。
- `extractSessionId`：`session_id`/`sessionId`/`message.sessionId`/无。
- `/api/sessions/new`：cwd 校验（非绝对/不存在/非目录→400）、busy→409、created 事件含 dirName=encodeCwd(cwd)。
- `TerminalManager`：resume 与 new 两条分支的锁键、cwd 解析、spawn args（new 不带 `--resume`）。
- 飞书 `/provider`：set/off/list、未命中、注入 env 透传到 runner（mock runner 捕获 req.env）。
- 目标：在现有 78 测试基础上增量，不回归。

## 9. 文档同步

- `docs/design.md`：§4.x 新增「目录内新建会话」与「右键选 provider 启动」；§7 端点表加 `/api/sessions/new`、`/api/terminal/new`、`/api/.../copy-command`，`/run` 标注 providerId；§12 飞书加 `/provider` 命令与 `providerId` 字段；当前进度/下一步更新。
- `README.md`：功能列表加「新建会话（选目录/单发+终端）」「右键选 provider 启动」「飞书 /provider」。

## 10. 不做（YAGNI）

- web 右键 provider **不持久化**（一次性，已定）；飞书按应用级持久化是该规则的明确例外。
- web 端不做原生目录选择（回退输入框；桌面端才弹原生框）。
- `/new` 不支持内联 `@provider` 参数（用应用级 `/provider` 代替，避免与自由文本 prompt 歧义）。
- 复制命令的 env 前缀只出 bash 风格（`KEY='val' cmd`），不为 cmd/PowerShell 各出一份。
- 新建单发会话的完成不接飞书 notify（sid 未知，文案无意义）。

## 11. 建议实现顺序（供 writing-plans 拆 commit）

1. `config.ts`：`providerEnv` + `matchProvider` + 单测。
2. `Runner.ts`：请求体 `env` 字段 + 提升 `extractSessionId`。
3. 后端端点：`/run` 接 providerId → `/api/sessions/new` → WS 路由（new + provider query）。
4. `TerminalManager.ts`：mode 判别联合重构 + 单测。
5. `copy-command` 端点。
6. 飞书：app.providerId + `/provider` 命令 + Bot 注入 env。
7. 前端基础：`desktop.ts` pickDirectory + Electron preload + Tauri 命令/权限。
8. 前端 UI：`NewSessionDialog.vue` + `TerminalPage` new 模式 + 路由。
9. 前端 UI：`useProviderMenu` + `<ProviderMenu>` + 四处右键接线。
10. 文档同步 + typecheck + 全量测试。

## 12. 风险 / 待办

- Tauri `tauri-plugin-dialog` 需加 Cargo 依赖与 capability（remote origin ACL，同现有命令）；`rfd` 备选。
- 交互终端 new 模式下，sessionId 在 PTY 流里不易稳定提取（TUI 非 stream-json）——new 终端**不依赖**提取 sid，用户首条消息后 claude 自动写 transcript，session 自然出现在列表（靠 `/api/projects` 轮询刷新）。单发模式才需要 `created` 事件提取 sid。
- Windows `shell:true` 下 env 合并是否被 cmd 垫片正确传递，需实测（预期可，env 是进程级）。
- 桌面端 dev/prod 三运行时（web/Electron/Tauri）的目录选择与新建会话需实测。
