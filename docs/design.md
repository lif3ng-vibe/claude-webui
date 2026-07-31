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
| 5 | CLI 执行模型 | 每条指令一次性 spawn `claude --resume <id> -p ... --output-format stream-json --dangerously-skip-permissions`；prompt 经 stdin 传入（非参数，避免 shell 注入）；per-`sessionId` 锁。`--resume` 默认不 fork（沿用同一 sessionId） |
| 6 | 权限 | 全开 `--dangerously-skip-permissions`；`ClaudeRunner` 接 `allowedTools`/`disallowedTools`（默认空 = skip），白名单是配置开关 |
| 7 | providers | v1 只 Anthropic（对话/提示词测试/工具查证全走 Anthropic，家族内多模型对比）；多 provider **配置**已做（页面管理 + 持久化 + 切换），纯对话多 provider 可用；工具查证跨家仍只 Anthropic 兼容 |
| 8 | 后端运行时 | Node + TypeScript |
| 9 | 前端栈 | Vue 3 + Vite + TS + UnoCSS + VueUse + Naive UI + Pinia + @tanstack/vue-query + markdown-it + Shiki |
| 10 | 对话 UI 路线 | 自写（无 chat 专用库）—— `assistant-ui` 只有 React，是选 Vue 的已知代价 |
| 11 | 传输/存储 | SSE；JSON 文件存 `~/.claude-webui/`（`config.json`、`prompts.json`、`conversations/<id>.json`） |

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
tools/fsTools.ts        # 只读磁盘工具 read_file/list_files/grep + 路径越界防护
server/index.ts         # node:http，所有 /api/* 端点 + SSE
```
### 前端（`web/`，Vue 3 + Vite + TS）
```
components/
  SessionsView.vue   # Sessions 读侧 + 续接 + 深问 + 多选 + 拖动框选 + 运行状态 + ↗ 触发点
  ChatView.vue       # 对话 + 历史/加载/追问 + provider 选择 + ↗ 触发点
  ProviderSettings.vue # 多 provider 配置弹窗
views/               # vue-router 双布局（history 模式）
  MainApp.vue        # 主页 / （顶栏 Sessions/Chat tab，不走路由）
  ItemLayout.vue     # 精简 shell（仅父子钻取间显示"← 返回"）
  DirPage.vue        # /projects/:dir 单工作目录
  SessionPage.vue    # /projects/:dir/sessions/:sid 单 session
  ConversationPage.vue # /conversations/:id 单对话 + 追问
router/index.ts      # 路由表 + beforeEach 设 type 级 title/favicon
stores/
  session.ts  ui.ts  display.ts   # Pinia；display 用 useStorage 持久化到 localStorage
composables/useConfig.ts  # /api/config
lib/{render,sse,shiki,head,openWindow,broadcast}.ts  # head=动态 title/favicon；openWindow=新窗口抽象；broadcast=跨窗口失效
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

## 8. 运行

- **开发**：后端 `npm run dev`（3000，API）+ 前端 `cd web && npm run dev`（Vite 5173，代理 `/api` 到 3000）。UI 用 http://localhost:5173。
- **单进程构建**：`npm run build:web` → 后端 `npm run dev` serve `web/dist`（http://localhost:3000）。
- 测试：`npm test`（29 测试）；类型检查：`npm run typecheck` + `cd web && npm run typecheck`。

## 9. v2（动手前先回来和用户确认）

- 多 provider **工具查证**跨家：OpenAI 兼容 function-calling 格式与 Anthropic tool-use 不同，需 adapter 适配（纯对话多 provider 已可用）。
- 磁盘工具写入（沙盒临时目录）。
- 常驻交互执行模型（B）+ WebSocket 双向。
- SQLite 持久化（对话多到要搜索/分页时）。
- `memory/` 浏览器、stats dashboard、history-prompt 视图。