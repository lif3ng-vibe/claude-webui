# 飞书机器人接入 Claude session 实现计划

> **For agentic workers:** 本计划由实现者本人 inline 执行（用户已授权一路做完，无需逐步审批）。Steps 用 checkbox 跟踪。基于 spec：`docs/superpowers/specs/2026-08-02-feishu-bot-design.md`。

**Goal:** 在 claude-webui sidecar 内集成飞书机器人，飞书命令切换并续接 Claude Code session，结果以交互卡片增量流式回传；本地任务完成也推飞书。

**Architecture:** 新增 `src/feishu/` 模块（长连接 Bot、命令、状态、formatter、Notifier、配置），抽共享 `SessionRunner`（锁+runner+lifecycle）让 web/飞书/通知复用，config 扩展 feishu 段（secret 不回传），前端加配置 UI 与在线状态。

**Tech Stack:** Node + TypeScript（后端，复用 `ClaudeRunner`/`ClaudeFileReader`/`runningSessions` 锁）、`@larksuiteoapi/node-sdk`（飞书长连接 `lark.ws.Client` + `im.message.create/patch`）、Vue 3（前端，复用 `ProviderSettings` 模式）、vitest（测试）。

## Global Constraints

- `~/.claude` 只读，绝不写 session jsonl。续接走 `claude --resume` CLI（复用 Runner，prompt 经 stdin）。
- `appSecret` 只存后端、不回传前端（GET 给布尔/不含 secret），与 `apiKey` 同级处理。
- 白名单：非 `allowedUserIds` 的飞书用户触发一律忽略 + 回无权限。
- 续接与 web/终端共享同一 `runningSessions` Set，按 sessionId 互斥。
- 代码注释/commit 中文；标识符/字符串/技术术语英文。
- `npm test` 与 `npm run typecheck` 必须通过；不破坏现有 29 测试与 web/terminal 续接。

## File Structure

新建：
- `src/feishu/feishuConfig.ts` — config feishu 段类型 + load/save/public（不回 secret）
- `src/feishu/SessionState.ts` — 全局 currentSession + 序号缓存（TTL）
- `src/feishu/formatter.ts` — stream-json→飞书卡片（累加器 + 节流调度器，纯函数为主）
- `src/feishu/commands.ts` — 命令解析与处理
- `src/feishu/Notifier.ts` — lark 发消息/卡片封装（注入 sender 便于测）
- `src/feishu/Bot.ts` — 长连接 + 白名单 + 事件分发
- `src/feishu/types.ts` — 飞书卡片/事件相关共享类型
- `src/claude/SessionRunner.ts` — 共享锁驱动器（runLocked + lifecycle）
- 对应 `tests/feishu/*.test.ts`、`tests/claude/SessionRunner.test.ts`
- `web/src/components/FeishuSettings.vue`、`web/src/composables/useFeishuStatus.ts`

修改：
- `src/config.ts` — `AppConfig` 加 `feishu?` 字段
- `src/server/index.ts` — 用 `SessionRunner` 重构 `handleRun`；config 端点带 feishu；新增 `/api/feishu/status`、`/api/feishu/restart`；启动 bot；通知订阅
- `package.json` — 加 `@larksuiteoapi/node-sdk`
- `docs/design.md` — 加飞书节

## 接口契约（跨 task 约定，命名锁定）

```ts
// src/feishu/types.ts
export interface FeishuCard { config?: Record<string, unknown>; elements: unknown[]; header?: unknown } // 飞书消息卡片 JSON 骨架
export interface FeishuSender {
  sendCard(receiveIdType: 'open_id'|'chat_id', receiveId: string, card: FeishuCard): Promise<string>; // 返回 message_id
  patchCard(messageId: string, card: FeishuCard): Promise<void>;
  sendText(receiveIdType: 'open_id'|'chat_id', receiveId: string, text: string): Promise<void>;
}

// src/feishu/feishuConfig.ts
export type FeishuDomain = 'feishu' | 'lark';
export interface FeishuConfig { appId: string; appSecret: string; allowedUserIds: string[]; domain: FeishuDomain; enableNotify: boolean; chatIdForNotify?: string; timeoutMs?: number | null; }
export interface PublicFeishuConfig { appId: string; allowedUserIds: string[]; domain: FeishuDomain; enableNotify: boolean; chatIdForNotify?: string; hasSecret: boolean; }
export async function loadFeishu(): Promise<FeishuConfig | null>;     // appId+secret 缺失返回 null
export async function publicFeishu(): Promise<PublicFeishuConfig | null>;
export async function saveFeishu(patch: Partial<FeishuConfig>): Promise<void>; // appSecret 留空保留旧值

// src/feishu/SessionState.ts
export interface CurrentSession { sessionId: string; dirName: string; cwd: string; }
export class SessionState {
  current(): CurrentSession | null;
  set(s: CurrentSession | null): void;
  setIndex(entries: CurrentSession[]): void;        // /sessions 后写入序号映射
  getByIndex(n: number): CurrentSession | null;      // 序号从 1；TTL 过期(>5min)返回 null
  findByPrefix(prefix: string): CurrentSession | null;
}

// src/claude/SessionRunner.ts
export type RunSource = 'web' | 'terminal' | 'feishu';
export interface RunLifecycle { source: RunSource; onEvent?: (e: ClaudeRunEvent) => void; onDone?: (info: RunResult) => void; }
export interface RunResult { ok: boolean; exitCode: number | null; error?: string; busy?: boolean }
export class SessionRunner {
  constructor(runner: { run(req: ClaudeRunRequest): AsyncGenerator<ClaudeRunEvent> }, lockSet: Set<string>);
  onFinished?: (info: RunResult, source: RunSource, req: ClaudeRunRequest) => void;  // 全局钩子(通知订阅)
  async runLocked(req: ClaudeRunRequest, lc: RunLifecycle): Promise<RunResult>;     // 锁冲突→{ok:false,busy:true} 不跑
}

// src/feishu/formatter.ts
export interface CardAccumulator;
export function createAccumulator(): CardAccumulator;
export function accumulate(acc: CardAccumulator, ev: ClaudeRunEvent): void;
export function toCard(acc: CardAccumulator, opts: { title: string; status: 'running'|'done'|'error'; cwd: string }): FeishuCard;
export class Throttle { constructor(minIntervalMs: number); shouldRun(now: number): boolean; mark(now: number): void; }

// src/feishu/commands.ts
export interface CommandContext { reader: ClaudeFileReader; state: SessionState; busySessionIds: () => Set<string> }
export type CommandResult = { kind: 'reply'; card: FeishuCard } | { kind: 'reply-text'; text: string } | { kind: 'none' };
export async function handleCommand(text: string, ctx: CommandContext): Promise<CommandResult>;

// src/feishu/Notifier.ts
export class Notifier {
  constructor(sender: FeishuSender, opts: { chatIdForNotify?: string; fallbackOpenId?: string });
  async notify(cardOrText: { card?: FeishuCard; text?: string }): Promise<void>;
}

// src/feishu/Bot.ts
export interface BotDeps { reader: ClaudeFileReader; sessionRunner: SessionRunner; state: SessionState; notifier: Notifier; config: FeishuConfig; senderFactory?: (cfg: FeishuConfig) => FeishuSender; wsClientFactory?: (...)=>unknown }
export class FeishuBot {
  constructor(deps: BotDeps);
  async start(): Promise<void>;
  async stop(): Promise<void>;
  status(): 'online' | 'offline';
  async handleMessage(ev: { openId: string; chatId?: string; text: string; isMention: boolean }): Promise<void>;  // 导出便于测
}
```

---

## Task 0: 装依赖

- [ ] `npm install @larksuiteoapi/node-sdk`（加到 dependencies）
- [ ] 确认纯 JS（无原生依赖）→ esbuild 可打进 `dist-server/server.js`

**Commit:** `build(feishu): 引入 @larksuiteoapi/node-sdk 飞书 SDK`

## Task 1: feishuConfig.ts

**Files:** Create `src/feishu/feishuConfig.ts`、`src/feishu/types.ts`；Modify `src/config.ts`（AppConfig 加 `feishu?`）；Test `tests/feishu/feishuConfig.test.ts`

- [ ] 写 `types.ts`（FeishuCard、FeishuSender 接口）
- [ ] 写 `feishuConfig.ts`：load/public/save（secret 保留逻辑仿 `saveProviders`）
- [ ] 测试：load 空→null；save 后 public 不含 secret 且 hasSecret=true；save 时 appSecret 留空保留旧值；用 `CLAUDE_WEBUI_DIR` 临时目录
- [ ] `npm test` 通过

**Commit:** `feat(feishu): 飞书配置读写与脱敏（secret 不回传）`

## Task 2: SessionState.ts

**Files:** Create `src/feishu/SessionState.ts`；Test `tests/feishu/SessionState.test.ts`

- [ ] current/set；setIndex/getByIndex（序号从 1）；TTL 5min（注入 now 便于测）；findByPrefix
- [ ] 测试：未选→null；切换；序号命中/越界；TTL 过期→null；前缀匹配
- [ ] `npm test` 通过

**Commit:** `feat(feishu): 全局当前 session 状态与序号缓存`

## Task 3: SessionRunner.ts + 重构 handleRun

**Files:** Create `src/claude/SessionRunner.ts`；Modify `src/server/index.ts`（handleRun 改用 runLocked）；Test `tests/claude/SessionRunner.test.ts`

- [ ] `SessionRunner.runLocked`：tryAcquire→(冲突返 busy)→runner.run→onEvent→onDone→release；done 时调 `onFinished`
- [ ] 构造参数为结构类型 `{ run }`，测试注入 fake runner（yield 事件）
- [ ] 测试：并发同 sessionId 第二个 {busy:true}；事件透传 onEvent；onDone.ok=true（exit 0）；abort→onDone.ok=false；release 后可再获
- [ ] 重构 handleRun：保持 409/SSE/done/error 行为不变，现有 Runner.test 不回归
- [ ] `npm test` 通过

**Commit:** `refactor(server): 抽 SessionRunner 共享锁驱动器，handleRun 复用`

## Task 4: formatter.ts

**Files:** Create `src/feishu/formatter.ts`；Test `tests/feishu/formatter.test.ts`

- [ ] createAccumulator/accumulate：处理 assistant `text`/`tool_use`/`tool_result`、stderr、exit（stream-json 形态见现有 Runner/AnthropicProvider）
- [ ] toCard：正文 markdown→飞书卡片元素；代码块；工具调用折叠；超长（>28000 字符）截断 + 省略提示；status 着色
- [ ] Throttle：shouldRun/mark（注入 now 测时序）
- [ ] 测试：喂样本 stream-json → toCard 快照；超长截断；Throttle 间隔
- [ ] `npm test` 通过

**Commit:** `feat(feishu): stream-json 转飞书卡片（含节流与超长折叠）`

## Task 5: commands.ts

**Files:** Create `src/feishu/commands.ts`；Test `tests/feishu/commands.test.ts`

- [ ] handleCommand：`/sessions [关键字]`（reader.listProjects→listSessions，序号+preview+cwd+忙闲，写 state.setIndex）、`/use <序号|前缀>`、`/info`/`/pwd`、`/stop`（返回标记，Bot 执行 abort）、`/help`
- [ ] 测试：各命令分支（mock reader/state）；/use 序号 vs 前缀；未选 session 时 /info 提示
- [ ] `npm test` 通过

**Commit:** `feat(feishu): 飞书命令解析与处理（/sessions /use /stop 等）`

## Task 6: Notifier.ts

**Files:** Create `src/feishu/Notifier.ts`；Test `tests/feishu/Notifier.test.ts`

- [ ] Notifier.notify：优先 chatIdForNotify，否则 fallbackOpenId（receive_id_type=open_id）；card→sendCard，text→sendText
- [ ] 测试：mock FeishuSender，断言调用参数与 receiveId 选择
- [ ] `npm test` 通过

**Commit:** `feat(feishu): 飞书消息/卡片发送封装 Notifier`

## Task 7: Bot.ts

**Files:** Create `src/feishu/Bot.ts`；Test `tests/feishu/Bot.test.ts`

- [ ] start：用 lark `Client`（domain）+ `ws.Client` 注册 `im.message.receive_v1`；stop 关连接；status 上报
- [ ] handleMessage：白名单校验→去 @→`/`开头走 commands→否则续接（state.current 缺失→回复提示；有→sessionRunner.runLocked(source:'feishu')，formatter 累加 + Throttle 节流 + notifier.sendCard/patchCard 流式）
- [ ] senderFactory/wsClientFactory 可注入测试；测试用 fake 不发真实网络
- [ ] 测试：白名单拒绝；命令分流；续接 happy path（fake runner yield 事件→断言 patch 调用）；锁 busy 回复
- [ ] `npm test` 通过

**Commit:** `feat(feishu): 飞书长连接机器人 Bot（白名单+命令+流式续接）`

## Task 8: server 集成

**Files:** Modify `src/server/index.ts`

- [ ] 建 `sessionRunner = new SessionRunner(runner, runningSessions)`；handleRun 用它
- [ ] notifier + FeishuBot：`loadFeishu()` 有配置→起 Bot；`sessionRunner.onFinished`：`source!=='feishu' && enableNotify`→notifier.notify
- [ ] GET `/api/config` 带 `publicFeishu()`；PUT 存 feishu；GET `/api/feishu/status`；POST `/api/feishu/restart`（start/stop Bot 实例）
- [ ] typecheck 通过；现有测试不回归；Bot 启动失败不阻断 sidecar（catch + 日志）

**Commit:** `feat(server): 接入飞书 Bot 端点与 sidecar 启动、本地任务完成通知`

## Task 9: 前端

**Files:** Create `web/src/components/FeishuSettings.vue`、`web/src/composables/useFeishuStatus.ts`；Modify 设置弹窗入口（仿 ProviderSettings）

- [ ] useFeishuStatus：2s 轮询 `/api/feishu/status`（useIntervalFn + vue-query/useFetch）
- [ ] FeishuSettings：appId/appSecret/白名单/domain/enableNotify/chatIdForNotify + 在线徽标；保存走 PUT /api/config
- [ ] 前端 typecheck 通过

**Commit:** `feat(web): 飞书机器人配置 UI 与在线状态`

## Task 10: 收尾

- [ ] `npm test`（后端全过）
- [ ] `npm run typecheck` + `cd web && npm run typecheck`
- [ ] `npm run build:server` 确认 lark sdk 进 bundle、无原生依赖报错
- [ ] `docs/design.md` 加飞书节（端点/模块/配置/限制）
- [ ] 最终提交

**Commit:** `docs(feishu): design 补飞书机器人节；收尾验证`

## 交付边界（实现者无法独自完成，需用户）

- 真实飞书联调：需用户在飞书开放平台建应用、配长连接事件 `im.message.receive_v1`、`im:message` 权限，并填入 appId/appSecret/白名单 open_id（见 spec §13）。代码做到「配置后即可用 + 单测 mock 覆盖」。
