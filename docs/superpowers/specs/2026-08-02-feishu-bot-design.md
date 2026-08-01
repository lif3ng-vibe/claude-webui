# 飞书机器人接入 Claude session — 设计稿

> 日期：2026-08-02 ｜ 状态：待审阅
> 在现有 claude-webui（本地、单用户、无鉴权）之上，新增「飞书机器人」入口：在飞书里用命令切换并续接某个 Claude Code session，结果流式回传飞书；本地发起的任务完成/出错时也推一条提醒。

## 1. 背景与目标

claude-webui 目前只在本地浏览器/桌面端操作 Claude Code session。本功能让你**离屏/远程**也能驱动 session：在飞书单聊（或群里 @ 机器人）发指令，复用现有 `claude --resume` 续接能力在你的机器上真实执行，输出以交互卡片增量流式回传。

核心价值：把飞书当作 session 的「远程控制台」+「完成提醒通道」。

## 2. 范围

**v1 做**
- 远程续接：飞书命令切换当前 session，纯文本消息续接该 session，结果以交互卡片增量流式回传。
- 状态通知：由 web（单发续接，非飞书）发起的任务完成/出错时，飞书推一条提醒（网页终端 TUI 常驻、无明确完成边界，不纳入 v1）。
- 飞书配置 UI + 机器人在线状态。
- 白名单鉴权（仅允许配置的飞书 user_id）。

**v1 不做**
- 多应用 / 多机器人身份。
- 按飞书会话（chat_id）或按用户分别路由（当前 session 为**全局单一**）。
- provider 对话（Chat 视图能力）走飞书。
- session 内容浏览/搜索（Sessions 读侧能力）走飞书。
- 同一时刻与多个 session 并行续接（受 per-sessionId 锁与全局单 currentSession 约束）。

## 3. 关键决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| 1 | 主线功能 | 远程续接 + 状态通知 | 用户选定 |
| 2 | 机器人形态 | 一个飞书自建应用 + 命令切换 session | 配置最省；不预绑定 |
| 3 | 当前 session 粒度 | 全局单一 | 单用户场景最简 |
| 4 | 部署/接入 | 桌面端托盘保活 + sidecar 内飞书长连接（`lark.ws.Client`，出站即可，无需公网） | 贴合本地定位，复用托盘保活 |
| 5 | 鉴权 | 仅白名单 user_id | 续接用 `--dangerously-skip-permissions` 真实执行命令，必须防滥用 |
| 6 | 通知触发 | 飞书发起任务流式回传；本地任务完成/出错推一条 | 离屏也不错过 |
| 7 | 回传策略 | 交互卡片 + 增量流式 `patch`（节流） | 实时反馈、美观 |
| 8 | SDK | `@larksuiteoapi/node-sdk`（纯 JS，可打进 bundle） | 官方长连接支持 |

## 4. 架构与模块

### 4.1 新增 `src/feishu/`

- **`Bot.ts`** — 飞书长连接客户端的封装。
  - `new Bot({ client, reader, runner, lockSet, state, notifier, config })`，`start()` / `stop()`。
  - 注册 `im.message.receive_v1` 事件：提取 `sender.open_id`、`chat_id`、消息内容（文本 / 富文本里抽纯文本）、是否 @ 本机器人。
  - 白名单校验（`open_id ∈ allowedUserIds`）→ 分发给 `commands` 或当作续接 prompt。
  - 维护在线状态（连接/断开/重连），上报给 `/api/feishu/status`。
  - 注入 mockable 的 lark client 接口，便于单测（不直接 `import` SDK 全局）。
- **`commands.ts`** — 命令解析与处理。导出 `handleCommand(text, ctx)`，返回要回复的卡片/动作。命令见 §7。
- **`SessionState.ts`** — 全局 `currentSession: { sessionId, dir, cwd } | null` + 切换/查询；序号→sessionId 短期缓存（最近一次 `/sessions` 结果，TTL ~5min）。解析 cwd 复用 `ClaudeFileReader`。
- **`Notifier.ts`** — `client.im.message.create / patch` 的封装：发卡片、更新卡片、发通知。处理 chat_id 选择（通知用配置的 `chatIdForNotify`，否则用白名单用户的单聊）。
- **`formatter.ts`** — Claude `stream-json` → 飞书交互卡片 JSON。含 markdown→卡片元素 adapter、代码块、工具调用/结果折叠、超长折叠、节流 patch 调度器。
- **`feishuConfig.ts`** — `AppConfig` 扩展 feishu 段 + `loadFeishu()` / `saveFeishu()` / `publicFeishu()`（不回 `appSecret`）。

### 4.2 共享重构：`src/claude/SessionRunner.ts`

现状：`server/index.ts` 的 `handleRun` 把「锁 → `runner.run` → 消费事件 → 释放锁」耦合在 SSE handler 内。飞书侧与通知侧需要同一套逻辑（但不走 SSE）。

抽出共享驱动器：

```ts
interface RunLifecycle {
  source: 'web' | 'terminal' | 'feishu';
  onEvent?: (e: ClaudeRunEvent) => void;       // stream-json/stderr/exit 逐事件
  onDone?: (info: { ok: boolean; exitCode: number | null; error?: string }) => void;
}

class SessionRunner {
  constructor(private runner: ClaudeRunner, private lockSet: Set<string>) {}
  async runLocked(req: ClaudeRunRequest, lc: RunLifecycle): Promise<{ ok: boolean; exitCode: number | null; error?: string }>;
}
```

- `runLocked`：检查/获取锁（占用返回冲突）、`runner.run`、逐事件回调、`finally` 释放锁、触发 `onDone`。
- `handleRun`（web SSE）改为调用 `runLocked` + 把事件写 SSE；飞书侧调用 `runLocked` + 把事件交 `formatter`；通知侧订阅 `onDone`（`source !== 'feishu'` 时推飞书）。
- **来源说明**：经 `SessionRunner` 的只有 `web`（`handleRun`）与 `feishu`；网页终端（node-pty 常驻 `claude --resume` TUI）不走 `-p` 一次性子进程，不经此路径，v1 不对其做完成通知（`RunLifecycle.source` 的 `'terminal'` 保留枚举但当前不产生）。
- 锁仍为同一个 `runningSessions` Set，web/终端/飞书三方互斥。

## 5. 数据流

**远程续接**
```
飞书消息事件(im.message.receive_v1)
  → Bot: 白名单校验(sender.open_id)
  → 是命令(以 / 开头)? ─是→ commands.handleCommand → 回卡片
                     ─否→ 取 SessionState.currentSession
                          → SessionRunner.runLocked({sessionId, cwd, prompt, source:'feishu'}, {onEvent: formatter.patch})
                          → 完成/出错: formatter 定稿卡片
```

**本地任务通知**
```
web 单发续接(handleRun) → SessionRunner.runLocked({..., source:'web'}, {onDone})
  → onDone: 若 source!=='feishu' → Notifier 推飞书一条提醒(完成/出错 + 摘要)
```

**锁冲突**：`runLocked` 发现 `lockSet.has(sessionId)` → 调用方（飞书）回卡片「该 session 正被 web/终端占用，请先在那边结束」。

## 6. 配置与安全

### 6.1 config 结构
`~/.claude-webui/config.json` 新增字段：
```jsonc
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "...",            // 密钥，仅后端
    "allowedUserIds": ["ou_xxx"],  // 白名单 open_id
    "domain": "feishu",            // 'feishu'(国内,默认) | 'lark'(国际)
    "enableNotify": true,          // 本地任务完成是否推飞书
    "chatIdForNotify": "oc_xxx",   // 可选；不填则推到白名单用户单聊
    "timeoutMs": null              // 可选；硬超时毫秒，null=关(默认)，靠 /stop
  }
}
```

### 6.2 安全（硬规则对齐）
- `appSecret` 只存后端、**不回传前端**（`publicFeishu()` 仅返回 `hasFeishu`、`appId`、`allowedUserIds`、`domain`、`enableNotify`、`chatIdForNotify`），与现有 `apiKey`/`authToken` 处理同级。
- 续接走 `--dangerously-skip-permissions`，prompt 经 stdin（非参数）传入——复用 Runner 现有防注入。
- 白名单：事件 `sender.open_id` 不在 `allowedUserIds` → 忽略 + 回「无权限」卡片。
- 不读取/不回传项目硬规则禁碰的敏感文件（本功能不涉及）。

### 6.3 启动时机
sidecar 启动时读 config：`appId` + `appSecret` 齐全 → `new Bot(...).start()`；否则跳过（前端显示「未配置」）。桌面端托盘保活期间 bot 常驻；dev web 模式（`npm run dev`）下 bot 同样随 sidecar 启动。

## 7. 命令交互

飞书消息以 `/` 开头为命令（去掉 @ 前缀后判断）；其余视为续接 prompt。

| 命令 | 作用 |
|------|------|
| `/sessions [目录关键字]` | 列出 session：序号 + 首条人类 prompt 预览 + cwd + 忙/闲徽标；序号写入 SessionState 缓存 |
| `/use <序号 \| sessionId 前缀>` | 切换 currentSession，回确认卡片（含 cwd） |
| `/info` `/pwd` | 显示当前 session（id / cwd / 忙闲） |
| `/stop` | 停止**飞书发起的**当前任务（abort 其 `runLocked`） |
| `/help` | 命令列表 |

- 纯文本（去 @）→ 续接 `currentSession`；未选 session → 回「请先 `/use`」。
- `/sessions` 结果较长时分页/截断（每页 ~10 条，`/sessions 2` 翻页）。
- 序号缓存过期（>5min 未重新 `/sessions`）时 `/use <序号>` 失效 → 提示先 `/sessions`；`/use <sessionId 前缀>` 不依赖缓存。

## 8. 回传策略（卡片 + 增量流式）

1. **开始**：`create` 一张交互卡片（标题 = `cwd` + 命令摘要；正文占位「思考中…」），记下 `message_id`。
2. **增量**：消费 `stream-json`，累加 assistant 正文 / `tool_use` / `tool_result` → `formatter` 转卡片 JSON → 节流 `patch(message_id, card)`：
   - 节流：最小间隔 ~1.2s，且尽量在段落/事件边界刷新；避开飞书消息更新频率限制。
   - markdown→卡片：正文用卡片 markdown（飞书卡片支持有限 markdown）；代码块用代码元素；`tool_use`/`tool_result` 折叠（`折叠`区块 / `collapsible_panel`）。
   - 超长：单卡片正文 > ~28k 字符 → 中段省略「…(N 字省略)」，或尾注提示完整内容见本地 webui。
3. **收尾**：`patch` 最终态（完整正文 + 工具调用折叠 + `exit code` / 耗时）。
4. **出错**：卡片标红 + stderr 摘要。

> 飞书卡片与标准 markdown 的差异（表格、嵌套列表等）由 `formatter` 的 adapter 处理；不支持的元素降级为纯文本。具体卡片 schema 实现时按飞书「卡片搭建器 / 消息卡片」规范构建。

## 9. 前端

- 设置弹窗（`ProviderSettings.vue` 风格）新增「飞书机器人」分区：`appId` / `appSecret` / 白名单 user_id（多值）/ `domain` / `enableNotify` / `chatIdForNotify` + **在线状态徽标**。
- 复用 `GET/PUT /api/config`（扩展 feishu 段；GET 不回 secret）。
- 新增 `GET /api/feishu/status` → `{ state: 'online'|'offline'|'unconfigured', detail?: string }`，设置区 2s 轮询。
- 配置保存后若从无到有 → 后端需启停 bot：提供 `POST /api/feishu/restart`，仅 start/stop bot 的进程内实例，**不重启整个 sidecar**（不影响 web/SSE 连接）。

## 10. 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | 扩展：含 `publicFeishu()`（不回 secret） |
| PUT | `/api/config` | 扩展：保存 feishu 段（secret 留空时保留旧值，同 provider 逻辑） |
| GET | `/api/feishu/status` | 机器人在线状态 |
| POST | `/api/feishu/restart` | 配置变更后重启 bot（start/stop） |

## 11. 错误处理

- **长连接断线**：SDK 自动重连；状态转 `offline` 上报，前端徽标变灰。
- **锁冲突**：飞书回卡片「该 session 正忙」。
- **未选 session / session 不存在 / 无 cwd**：回卡片提示对应原因。
- **runner 卡死**：可配置硬超时（`feishu.timeoutMs`，**默认关**，靠 `/stop` 手动停）；超时则 `abort`。
- **飞书 API 限流（429）**：`patch` 退避（指数退避，上限），期间累积事件不丢。
- **bot 未配置**：后端不启动，前端提示「未配置」。

## 12. 测试策略

- `formatter`：`stream-json` 样本 → 卡片 JSON 快照；超长折叠；节流调度器时序（用假定时器）。
- `commands`：解析各命令 + `/use`/`/sessions` 逻辑（mock `ClaudeFileReader`、`SessionState`）。
- `SessionState`：切换、序号缓存 TTL、未选状态。
- `SessionRunner`：锁 acquire/release（并发两个 `runLocked` 同 sessionId，第二个得冲突）、`onEvent`/`onDone` 触发、abort 路径。
- `Bot`：白名单拒绝、命令 vs prompt 分流、@ 解析（注入 mock lark client，不发真实网络）。
- 沿用现有 `streamChildEvents` / `parseStreamJsonLine` 的纯函数测试模式。
- `npm test` / `npm run typecheck` 必须通过。

## 13. 飞书开放平台手动配置清单（用户侧）

实现完成后，用户需在 [飞书开放平台](https://open.feishu.cn) 为该自建应用：
1. 开启「机器人」能力。
2. 「事件与回调」→ 选择**长连接**模式（非 HTTP 回调）。
3. 订阅事件 `im.message.receive_v1`（接收消息）。
4. 权限：`im:message`（发消息）、`im:message:send_as_bot`、`im:chat`（若发群）等（按实际 API 所需）。
5. 发布版本 / 在工作区可用；把机器人加到目标群（或单聊）。
6. 把自己的 `open_id` 填入 claude-webui 白名单（可用 `/sessions` 触发一次后从后端日志读到自己的 open_id）。

## 14. 风险与待办

- **飞书卡片 markdown 差异**：表格/嵌套列表等支持有限，adapter 需降级；超长折叠阈值需实测（飞书单条卡片正文长度上限）。
- **`patch` 频率限制**：节流参数需按飞书实际限流调；极端高频输出下可能丢中间帧（收尾定稿保证最终完整）。
- **Windows `shell:true` 下 `kill` 不立即生效**（Runner 已知限制）→ `/stop` 可能要等当前轮结束。
- **`@larksuiteoapi/node-sdk` 打包**：纯 JS 可 esbuild 打进 `dist-server/server.js`；需确认无原生依赖。
- **桌面端实测**：bot 随 sidecar 启动 + 托盘保活在 Electron/Tauri prod 包里跑通需实测。
- **多窗口/多来源锁语义**：飞书与 web 终端正忙时的 `/stop` 跨来源语义——v1 限定 `/stop` 只停飞书自己发起的任务。

## 15. 默认假设（用户已确认，可在实现期再调）

- session 用序号选择（`/sessions` 列号 → `/use 3`）。
- 流式 `patch` 节流 ~1.2s。
- 不设硬超时（长任务跑到自然结束，`/stop` 手动停）。
- 通知默认发白名单用户单聊；发群需配 `chatIdForNotify`。
- `domain` 默认 `feishu`（国内）。
