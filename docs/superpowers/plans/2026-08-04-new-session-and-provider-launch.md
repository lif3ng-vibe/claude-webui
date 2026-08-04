# 目录内新建会话 + 右键选 provider 启动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 claude-webui 能在任意目录新建 Claude session（单发 + 交互终端两种模式，桌面端原生选目录框），并在「新建 / 续接发送 / 终端 / 复制命令」四类按钮上右键选 provider，把该 provider 的环境变量一次性注入这次启动；飞书侧加 `/provider` 命令做应用级注入。

**Architecture:** 统一收敛到 `providerEnv(id)` → `ClaudeRunner.run`/`runNew` 的 `env` 字段，merge 进 spawn 子进程 env（覆盖 process.env）。web 右键=按次注入；飞书 `/provider`=应用级持久化注入。新建会话复用已有 `ClaudeRunner.runNew`，加 web SSE 端点 `POST /api/sessions/new`（发 `created` 事件后前端 `router.push` 跳转）与交互终端 `WS /api/terminal/new?cwd=`。锁：新建用共享 `runningSessions` + key `"new:"+cwd`。

**Tech Stack:** Node + TypeScript（后端，vitest 单测）、Vue 3 + Vite + TS + Naive UI + VueUse（前端，无组件测试，靠 typecheck + 手动验证）、Electron + Tauri（桌面壳）。

**Spec:** `docs/superpowers/specs/2026-08-04-new-session-and-provider-launch-design.md`

## Global Constraints

- `~/.claude` 只读，绝不写 session jsonl / history.jsonl；新建会话只往用户指定工作目录跑 claude（transcript 由 claude 自己写）。
- API key 只存在后端，前端永不接触原始 key；provider 列表前端只有 `hasAuth` 布尔。
- 不读/不显示敏感文件（`settings*.json`/`mcp.json`/`.env`/`.ssh`/`.gnupg`）。
- 续接/终端 resume 按 sessionId 加锁；新建单发与新建交互终端共用 `runningSessions`、key `"new:"+cwd`。
- 注入的 Claude CLI 环境变量：`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（优先）/ `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`（`stripModelSuffix` 去后缀）。
- 代码注释和 commit message 用中文；标识符/字符串/技术术语用英文。
- 提交规范：`<type>(<scope>): <主题>`，scope 可选 `claude`/`provider`/`server`/`web`/`tooling`。
- 后端有 vitest 单测；前端无组件测试基础设施（仓库无 `web/**/*.test.ts`），前端任务用 `cd web && npm run typecheck` + 手动验证。
- typecheck 三处：`npm run typecheck`（后端测试 tsconfig）、`npm run build`（后端 src tsconfig）、`cd web && npm run typecheck`、`tsc -p electron/tsconfig.json`。

---

## File Structure

**后端新增：**
- `src/claude/resumeCommand.ts` — `buildResumeCommand(cwd, sid, env?)`：纯函数，拼 `cd ... && claude --resume` 命令串（📋 复制命令端点用，前端无密钥）。
- `src/claude/cwdGuard.ts` — `assertSafeCwd(cwd)`：纯异步函数，校验新建会话工作目录。
- `tests/claude/resumeCommand.test.ts`、`tests/claude/cwdGuard.test.ts` — 对应单测。

**后端改动：**
- `src/config.ts` — 加 `providerEnv(id?)`、`matchProvider(query)`。
- `src/claude/Runner.ts` — `ClaudeRunRequest`/`ClaudeNewRequest` 加 `env?`；run/runNew merge env；提升 `extractSessionId`（从 feishu/Bot.ts 搬来，导出）。
- `src/server/index.ts` — `handleRun` 接 providerId；新增 `POST /api/sessions/new`、`GET /api/projects/:dir/sessions/:sid/copy-command`；WS upgrade 路由 `/api/terminal/new` + provider query。
- `src/terminal/TerminalManager.ts` — 处理器签名改 `(ws, opts)` 判别联合；导出纯函数 `spawnSpec(opts)`、`TerminalOpts` 类型。
- `src/feishu/feishuConfig.ts` — `FeishuApp`/`PublicFeishuApp` 加 `providerId?`，读写贯通。
- `src/feishu/commands.ts` — `CommandContext` 加 `providers`/`currentProviderId`；`CommandResult` 加 `set-provider`；新增 `cmdProvider`。
- `src/feishu/Bot.ts` — `runNew`/`runContinue` 注入 env；`handleMessage` 处理 `set-provider`（`onSetProvider` 回调）；`BotDeps` 加 `onSetProvider?`；`/info` 显示 provider。

**前端新增：**
- `web/src/components/NewSessionDialog.vue` — 新建会话模态。
- `web/src/components/ProviderMenu.vue` — 右键 provider 下拉菜单。
- `web/src/composables/useProviderMenu.ts` — 菜单状态 composable。

**前端改动：**
- `web/src/lib/desktop.ts` — 加 `pickDirectory()`。
- `web/src/lib/openWindow.ts`（不动，复用）。
- `web/src/api.ts` — 加 `createSession`（SSE）、`copyCommand`。
- `web/src/router/index.ts` — 加 `/terminal/new` 路由 + title/favicon 分支。
- `web/src/views/TerminalPage.vue` — 支持 new 模式。
- `web/src/components/SessionsView.vue` — `+ 新会话`、`sendPrompt(providerId?)`、`popTerminal(...,providerId?)`、`copyResume(providerId?)`、右键菜单。
- `web/src/views/DirPage.vue` — `+ 新会话`、`copyResume(providerId?)`、`popTerminal`（如有）。
- `web/src/views/SessionPage.vue` — `sendPrompt`/`popTerminal`/`copyResume` 加 providerId + 右键。
- `web/src/components/FeishuSettings.vue` — provider 选择下拉。

**桌面壳改动：**
- `electron/preload.ts`、`electron/main.ts` — `pickDirectory`（`dialog.showOpenDialog`）。
- `src-tauri/src/lib.rs`（或新增命令模块）— `desktop_pick_directory` 命令（`tauri-plugin-dialog`）。
- `src-tauri/Cargo.toml` — 加 `tauri-plugin-dialog`。
- `src-tauri/permissions/commands.toml` + `src-tauri/capabilities/default.json` — 授权 `allow-desktop-pick-directory`。

---

## Task 1: `providerEnv` + `matchProvider`（config.ts）

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `providerEnv(providerId?: string): Promise<Record<string, string>>`；`matchProvider(query: string): Promise<string | undefined>`。

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.ts` 末尾（`describe('config', ...)` 块内）追加：

```ts
  it('providerEnv 把 provider 解析为 claude CLI env（authToken 优先于 apiKey）', async () => {
    await saveProviders([{ id: 'p1', name: 'P1', baseURL: 'http://x', authToken: 'tok', apiKey: 'key', model: 'm[1m]' }], 'p1');
    const env = await providerEnv('p1');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://x');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBe('m');
  });

  it('providerEnv 无 id 回退 env', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://env';
    process.env.ANTHROPIC_API_KEY = 'k';
    process.env.ANTHROPIC_MODEL = 'glm[1m]';
    const env = await providerEnv(undefined);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://env');
    expect(env.ANTHROPIC_API_KEY).toBe('k');
    expect(env.ANTHROPIC_MODEL).toBe('glm');
  });

  it('matchProvider 按 id/名称/前缀匹配', async () => {
    await saveProviders([{ id: 'p1', name: '生产', baseURL: 'http://x', authToken: 't', model: 'm' }], 'p1');
    expect(await matchProvider('p1')).toBe('p1');
    expect(await matchProvider('生产')).toBe('p1');
    expect(await matchProvider('P1')).toBe('p1'); // id 前缀大小写不敏感
    expect(await matchProvider('nope')).toBeUndefined();
  });
```

并把顶部 import 改为：
```ts
import { loadConfig, stripModelSuffix, publicConfig, saveProviders, resolveProvider, providerEnv, matchProvider } from '../src/config.js';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `providerEnv is not a function`（或导入失败）。

- [ ] **Step 3: 实现**

在 `src/config.ts` 末尾追加（`resolveProvider` 之后）：

```ts
/**
 * 把某 provider（或 active/env 兜底）解析为 Claude CLI 原生识别的环境变量字典。
 * 用于把 claude --resume / claude -p 绑定到特定 provider（右键选 provider、飞书 /provider）。
 * authToken 优先于 apiKey；model 去后缀。
 */
export async function providerEnv(providerId?: string): Promise<Record<string, string>> {
  const cfg = await resolveProvider(providerId);
  const env: Record<string, string> = {};
  if (cfg.baseURL) env.ANTHROPIC_BASE_URL = cfg.baseURL;
  if (cfg.authToken) env.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
  else if (cfg.apiKey) env.ANTHROPIC_API_KEY = cfg.apiKey;
  if (cfg.defaultModel) env.ANTHROPIC_MODEL = cfg.defaultModel;
  return env;
}

/**
 * 按名称/id 前缀匹配 provider（飞书 /provider 命令用）。
 * 顺序：精确 id → 名称大小写不敏感相等 → id 前缀（大小写不敏感）。返回 id 或 undefined。
 */
export async function matchProvider(query: string): Promise<string | undefined> {
  const q = query.trim();
  if (!q) return undefined;
  const { providers } = await publicConfig();
  const exact = providers.find((p) => p.id === q);
  if (exact) return exact.id;
  const byName = providers.find((p) => (p.name ?? '').toLowerCase() === q.toLowerCase());
  if (byName) return byName.id;
  const byPrefix = providers.find((p) => p.id.toLowerCase().startsWith(q.toLowerCase()));
  return byPrefix?.id;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(provider): providerEnv/matchProvider 解析 provider 为 claude CLI env"
```

---

## Task 2: Runner 加 `env` 字段 + 提升 `extractSessionId`

**Files:**
- Modify: `src/claude/Runner.ts`
- Modify: `src/feishu/Bot.ts`（删除本地 `extractSessionId`，改 import）
- Test: `tests/claude/Runner.test.ts`

**Interfaces:**
- Produces: `ClaudeRunRequest.env?`、`ClaudeNewRequest.env?`（`Record<string,string>`）；`extractSessionId(d: unknown): string | null`（从 `src/claude/Runner.js` 导出）。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

在 `tests/claude/Runner.test.ts` 顶部 import 追加 `extractSessionId`：
```ts
import { parseStreamJsonLine, streamChildEvents, extractSessionId } from '../../src/claude/Runner.js';
```
在文件末尾追加：
```ts
describe('extractSessionId', () => {
  it('从 session_id / sessionId / message.sessionId 提取', () => {
    expect(extractSessionId({ type: 'system', session_id: 'abc' })).toBe('abc');
    expect(extractSessionId({ sessionId: 'def' })).toBe('def');
    expect(extractSessionId({ message: { sessionId: 'ghi' } })).toBe('ghi');
    expect(extractSessionId({ type: 'assistant' })).toBeNull();
    expect(extractSessionId(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/claude/Runner.test.ts`
Expected: FAIL — `extractSessionId is not exported`。

- [ ] **Step 3: 实现 — Runner.ts**

在 `src/claude/Runner.ts`：

(a) `ClaudeRunRequest` 接口内、`signal?: AbortSignal;` 之前加：
```ts
  /** 注入子进程的环境变量（右键选 provider / 飞书 /provider），覆盖 process.env。 */
  env?: Record<string, string>;
```

(b) `ClaudeNewRequest` 接口同样加 `env?: Record<string, string>;`（在 `signal` 前）。

(c) `run()` 方法里 spawn 的 `env` 字段改为合并 req.env。定位现有：
```ts
      env: { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' },
```
改为（run 和 runNew 两处都改）：
```ts
      env: { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1', ...req.env },
```

(d) 在文件末尾（`AsyncQueue` 类之前或之后）加导出函数：
```ts
/** 从 stream-json 事件提取 session_id（新建 session 后用于设为当前 / 跳转）。 */
export function extractSessionId(d: unknown): string | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (typeof o.session_id === 'string') return o.session_id;
  if (typeof o.sessionId === 'string') return o.sessionId;
  const msg = o.message as Record<string, unknown> | undefined;
  if (msg && typeof msg.sessionId === 'string') return msg.sessionId;
  return null;
}
```

- [ ] **Step 4: 改 Bot.ts 用导入的 extractSessionId**

在 `src/feishu/Bot.ts`：
- 顶部 import 行 `import type { ClaudeRunEvent, ClaudeNewRequest } from '../claude/Runner.js';` 改为：
```ts
import type { ClaudeRunEvent, ClaudeNewRequest } from '../claude/Runner.js';
import { extractSessionId } from '../claude/Runner.js';
```
（或合并：`import { extractSessionId } from '../claude/Runner.js';` 单独一行，保留原 type import。）
- 删除文件末尾的本地 `function extractSessionId(d: unknown): string | null { ... }`（约 229-238 行整段）。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `npx vitest run tests/claude/Runner.test.ts tests/feishu/Bot.test.ts`
Expected: PASS（Bot 测试不应回归——extractSessionId 行为不变）。
Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/claude/Runner.ts src/feishu/Bot.ts tests/claude/Runner.test.ts
git commit -m "refactor(claude): Runner 请求体加 env 字段，提升 extractSessionId 为共享导出"
```

---

## Task 3: `buildResumeCommand` 纯函数（📋 复制命令用）

**Files:**
- Create: `src/claude/resumeCommand.ts`
- Test: `tests/claude/resumeCommand.test.ts`

**Interfaces:**
- Produces: `buildResumeCommand(cwd: string, sessionId: string, env?: Record<string,string>): string`。

- [ ] **Step 1: 写失败测试**

创建 `tests/claude/resumeCommand.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { buildResumeCommand } from '../../src/claude/resumeCommand.js';

describe('buildResumeCommand', () => {
  it('无 env 返回裸命令', () => {
    expect(buildResumeCommand('/p', 's1')).toBe('cd "/p" && claude --resume s1');
  });
  it('有 env 返回 bash 风格 env 前缀，authToken 优先于 apiKey', () => {
    const cmd = buildResumeCommand('/p', 's1', {
      ANTHROPIC_BASE_URL: 'http://x',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_MODEL: 'm',
    });
    expect(cmd).toBe("cd \"/p\" && ANTHROPIC_BASE_URL='http://x' ANTHROPIC_AUTH_TOKEN='tok' ANTHROPIC_MODEL='m' claude --resume s1");
  });
  it('无 authToken 时用 apiKey', () => {
    const cmd = buildResumeCommand('/p', 's1', { ANTHROPIC_API_KEY: 'key' });
    expect(cmd).toContain("ANTHROPIC_API_KEY='key'");
    expect(cmd).not.toContain('ANTHROPIC_AUTH_TOKEN');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/claude/resumeCommand.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

创建 `src/claude/resumeCommand.ts`：
```ts
/**
 * 拼「复制 resume 命令」的字符串。无 env = 裸命令；有 env = bash 风格环境变量前缀。
 * 前端无密钥，故含 provider 的命令由后端用此函数生成。
 * 已知限制：值用单引号包裹，若值含单引号会破坏（token/url 不含，可接受）。
 */
export function buildResumeCommand(cwd: string, sessionId: string, env?: Record<string, string>): string {
  const tail = `claude --resume ${sessionId}`;
  if (!env) return `cd "${cwd}" && ${tail}`;
  const parts: string[] = [];
  if (env.ANTHROPIC_BASE_URL) parts.push(`ANTHROPIC_BASE_URL='${env.ANTHROPIC_BASE_URL}'`);
  if (env.ANTHROPIC_AUTH_TOKEN) parts.push(`ANTHROPIC_AUTH_TOKEN='${env.ANTHROPIC_AUTH_TOKEN}'`);
  else if (env.ANTHROPIC_API_KEY) parts.push(`ANTHROPIC_API_KEY='${env.ANTHROPIC_API_KEY}'`);
  if (env.ANTHROPIC_MODEL) parts.push(`ANTHROPIC_MODEL='${env.ANTHROPIC_MODEL}'`);
  return `cd "${cwd}" && ${parts.join(' ')} ${tail}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/claude/resumeCommand.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/claude/resumeCommand.ts tests/claude/resumeCommand.test.ts
git commit -m "feat(claude): buildResumeCommand 纯函数拼含 provider env 的复制命令"
```

---

## Task 4: `assertSafeCwd` 纯函数（新建会话目录校验）

**Files:**
- Create: `src/claude/cwdGuard.ts`
- Test: `tests/claude/cwdGuard.test.ts`

**Interfaces:**
- Produces: `assertSafeCwd(cwd: string): Promise<void>`（不合法时 throw Error）。

- [ ] **Step 1: 写失败测试**

创建 `tests/claude/cwdGuard.test.ts`：
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { assertSafeCwd } from '../../src/claude/cwdGuard.js';

let dir = '';
describe('assertSafeCwd', () => {
  beforeEach(async () => { dir = await mkdtemp(join(os.tmpdir(), 'cwu-cwd-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('合法目录不抛', async () => {
    await expect(assertSafeCwd(dir)).resolves.toBeUndefined();
  });
  it('相对路径拒绝', async () => {
    await expect(assertSafeCwd('relative/path')).rejects.toThrow('绝对路径');
  });
  it('不存在拒绝', async () => {
    await expect(assertSafeCwd(join(dir, 'nope'))).rejects.toThrow('不存在');
  });
  it('非目录拒绝', async () => {
    const { writeFile } = await import('node:fs/promises');
    const f = join(dir, 'afile');
    await writeFile(f, 'x');
    await expect(assertSafeCwd(f)).rejects.toThrow('不是目录');
  });
  it('~/.claude 本身拒绝', async () => {
    await expect(assertSafeCwd(join(os.homedir(), '.claude'))).rejects.toThrow('状态目录');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/claude/cwdGuard.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

创建 `src/claude/cwdGuard.ts`：
```ts
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import os from 'node:os';

const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();

/**
 * 校验新建会话的工作目录：绝对路径、存在、是目录、且不在 ~/.claude 状态区（projects/sessions/本身）内。
 * 不合法时 throw Error（含中文原因），由调用方转 HTTP 400。
 */
export async function assertSafeCwd(cwd: string): Promise<void> {
  if (!cwd || !isAbsolute(cwd)) throw new Error('工作目录必须是绝对路径');
  let s;
  try {
    s = await stat(cwd);
  } catch {
    throw new Error('工作目录不存在');
  }
  if (!s.isDirectory()) throw new Error('工作目录不是目录');
  const claudeDir = join(os.homedir(), '.claude');
  const blocked = [claudeDir, join(claudeDir, 'projects'), join(claudeDir, 'sessions')].map(norm);
  if (blocked.includes(norm(cwd))) throw new Error('不能在 ~/.claude 状态目录内新建会话');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/claude/cwdGuard.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/claude/cwdGuard.ts tests/claude/cwdGuard.test.ts
git commit -m "feat(claude): assertSafeCwd 校验新建会话工作目录"
```

---

## Task 5: TerminalManager `spawnSpec` 纯函数 + mode 重构

**Files:**
- Modify: `src/terminal/TerminalManager.ts`
- Test: `tests/terminal/TerminalManager.test.ts`（新建）

**Interfaces:**
- Produces: `TerminalOpts`（判别联合，见下）；`spawnSpec(opts): { args: string[]; lockKey: string }`；`createTerminalHandler(reader, lockSet)` 返回 `(ws: WebSocket, opts: TerminalOpts) => void`。
- Consumes: Task 1 的 `providerEnv`（在 server 调用，不在本任务）。

- [ ] **Step 1: 写失败测试**

创建 `tests/terminal/TerminalManager.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { spawnSpec } from '../../src/terminal/TerminalManager.js';

describe('spawnSpec', () => {
  it('resume 模式：带 --resume，锁键=sessionId', () => {
    const s = spawnSpec({ mode: 'resume', dirName: 'd', sessionId: 's1' });
    expect(s.args).toEqual(['--resume', 's1', '--dangerously-skip-permissions']);
    expect(s.lockKey).toBe('s1');
  });
  it('new 模式：不带 --resume，锁键="new:"+cwd', () => {
    const s = spawnSpec({ mode: 'new', cwd: '/p' });
    expect(s.args).toEqual(['--dangerously-skip-permissions']);
    expect(s.lockKey).toBe('new:/p');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/terminal/TerminalManager.test.ts`
Expected: FAIL — `spawnSpec` 未导出。

- [ ] **Step 3: 重构 TerminalManager.ts**

把 `src/terminal/TerminalManager.ts` 改为如下（保留原协议注释，把 dirName/sessionId 直取改为 opts 判别）：

```ts
// 网页交互终端：WebSocket ↔ node-pty 跑 claude 的交互式 TUI。
// resume 模式：claude --resume <sid>（现有）。new 模式：fresh claude（不带 --resume），用于目录内新建会话。
// 协议：C→S 二进制=终端输入；文本={type:'resize',cols,rows}。S→C 二进制=PTY 输出；文本={type:'exit'|'error'}。
// 生命周期：WS 关 → kill PTY + 释放锁（断开即杀）。锁与单发续接共享 runningSessions。
import * as nodePty from 'node-pty';
import type { WebSocket } from 'ws';
import type { ClaudeFileReader } from '../claude/FileReader.js';

/** 终端启动选项：resume 续接既有 session；new 在指定 cwd 新建。env=注入的 provider 环境变量。 */
export type TerminalOpts =
  | { mode: 'resume'; dirName: string; sessionId: string; env?: Record<string, string> }
  | { mode: 'new'; cwd: string; env?: Record<string, string> };

/** 由 opts 推导 spawn 参数与锁键（纯函数，便于单测）。cwd 由调用方按 mode 决定来源。 */
export function spawnSpec(opts: TerminalOpts): { args: string[]; lockKey: string } {
  if (opts.mode === 'resume') {
    return { args: ['--resume', opts.sessionId, '--dangerously-skip-permissions'], lockKey: opts.sessionId };
  }
  return { args: ['--dangerously-skip-permissions'], lockKey: 'new:' + opts.cwd };
}

export interface TerminalHandle {
  (ws: WebSocket, opts: TerminalOpts): void;
}

export function createTerminalHandler(reader: ClaudeFileReader, lockSet: Set<string>): TerminalHandle {
  return async (ws, opts) => {
    let pty: nodePty.IPty | null = null;
    let cleaned = false;
    const { args, lockKey } = spawnSpec(opts);

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      lockSet.delete(lockKey);
      if (pty) {
        try { pty.kill(); } catch { /* 已退出 */ }
        pty = null;
      }
    };

    // 解析 cwd：resume 从 session jsonl；new 直接用 opts.cwd。
    let cwd: string | undefined;
    if (opts.mode === 'resume') {
      try { cwd = await reader.getSessionCwd(opts.dirName, opts.sessionId); } catch { cwd = undefined; }
    } else {
      cwd = opts.cwd;
    }
    if (!cwd) {
      ws.send(JSON.stringify({ type: 'error', msg: '无法确定该 session 的工作目录' }));
      ws.close(4000, 'no cwd');
      return;
    }

    if (lockSet.has(lockKey)) {
      ws.send(JSON.stringify({ type: 'error', msg: '该 session/目录正被另一处占用，请先结束' }));
      ws.close(4001, 'busy');
      return;
    }
    lockSet.add(lockKey);

    const isWin = process.platform === 'win32';
    const env = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1', ...opts.env };
    try {
      pty = isWin
        ? nodePty.spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'claude', ...args], { cwd, cols: 80, rows: 24, name: 'xterm-color', env })
        : nodePty.spawn('claude', args, { cwd, cols: 80, rows: 24, name: 'xterm-color', env });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', msg: `启动 claude 失败：${String(e)}` }));
      ws.close(4002, 'spawn failed');
      cleanup();
      return;
    }

    pty.onData((data: string) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8')); });
    pty.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ type: 'exit', code: exitCode })); ws.close(1000, 'claude exited'); }
      cleanup();
    });
    ws.on('message', (data, isBinary) => {
      if (!pty) return;
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
        pty.write(buf.toString('utf8'));
      } else {
        const msg = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        try {
          const ctrl = JSON.parse(msg) as { type: string; cols?: number; rows?: number };
          if (ctrl.type === 'resize' && ctrl.cols && ctrl.rows) { try { pty.resize(ctrl.cols, ctrl.rows); } catch { /* 忽略 */ } }
        } catch { /* 非法控制消息忽略 */ }
      }
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  };
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run tests/terminal/TerminalManager.test.ts`
Expected: PASS。
Run: `npm run typecheck`
Expected: 无错误（注意 server/index.ts 还在用旧签名——会在 Task 7 一并改；本步先不改 server，typecheck 可能报 server 调用签名不符。**故本步只跑该测试文件，不跑全局 typecheck**；全局 typecheck 在 Task 7 修复 server 后再跑。）

> 说明：Task 5 与 Task 7（server upgrade 路由）必须配套；中间状态 server 会类型报错，故全局 typecheck 推迟到 Task 7 后。

- [ ] **Step 5: 提交**

```bash
git add src/terminal/TerminalManager.ts tests/terminal/TerminalManager.test.ts
git commit -m "refactor(server): 终端处理器改判别联合 opts，新增 new 模式与 spawnSpec 纯函数"
```

---

## Task 6: server — `/run` providerId + `copy-command` + `sessions/new` + WS 路由

> 本任务把 Task 1/2/3/4/5 接到 HTTP/WS 端点。改完后跑全局 typecheck。

**Files:**
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `providerEnv`、`extractSessionId`、`buildResumeCommand`、`assertSafeCwd`、`encodeCwd`、新 `createTerminalHandler` 签名。
- Produces: `POST /api/sessions/new`（SSE）、`GET /api/projects/:dir/sessions/:sid/copy-command`、`/run` 接 `providerId`、WS `/api/terminal/new` + `?provider=`。

- [ ] **Step 1: 加 import**

在 `src/server/index.ts` 顶部 import 区加：
```ts
import { providerEnv } from '../config.js';
import { extractSessionId } from '../claude/Runner.js';
import { buildResumeCommand } from '../claude/resumeCommand.js';
import { assertSafeCwd } from '../claude/cwdGuard.js';
import { encodeCwd } from '../claude/pathEncoding.js';
```
（`resolveProvider` 等已有 import 保留；`encodeCwd` 若已 import 不重复。）

- [ ] **Step 2: handleRun 接 providerId**

定位 `handleRun` 内 `sessionRunner.runLocked({ sessionId, cwd, prompt, model: body.model, signal: ac.signal }, ...)`，在其前加 env 解析并传入：
```ts
  const env = body.providerId ? await providerEnv(String(body.providerId)) : undefined;
  const result = await sessionRunner.runLocked(
    { sessionId, cwd, prompt, model: body.model, env, signal: ac.signal },
    { ... /* 不变 */ },
  );
```

- [ ] **Step 3: 新增 `POST /api/sessions/new` 处理函数**

在 `handleRun` 函数定义之后、`handleChat` 之前，新增：
```ts
async function handleNewSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const cwd = String(body.cwd ?? '');
  const prompt = String(body.prompt ?? '');
  if (!prompt) { json(res, 400, { error: 'prompt 不能为空' }); return; }
  try { await assertSafeCwd(cwd); }
  catch (e) { json(res, 400, { error: String(e) }); return; }

  const lockKey = 'new:' + cwd;
  if (runningSessions.has(lockKey)) { json(res, 409, { error: '该目录正在新建会话' }); return; }
  runningSessions.add(lockKey);

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  res.writeHead(200, SSE_HEADERS);
  const write = sseWriter(res, req);
  const env = body.providerId ? await providerEnv(String(body.providerId)) : undefined;
  let createdSent = false;

  try {
    for await (const ev of runner.runNew({ cwd, prompt, env, signal: ac.signal })) {
      if (ev.type === 'stream-json') {
        const sid = extractSessionId(ev.data);
        if (sid && !createdSent) {
          createdSent = true;
          write(`event: created\ndata: ${JSON.stringify({ sessionId: sid, dirName: encodeCwd(cwd), cwd })}\n\n`);
        }
        write(`event: stream-json\ndata: ${JSON.stringify(ev.data)}\n\n`);
      } else if (ev.type === 'stderr') {
        write(`event: stderr\ndata: ${JSON.stringify({ text: ev.text })}\n\n`);
      } else if (ev.type === 'exit') {
        write(`event: exit\ndata: ${JSON.stringify({ code: ev.code })}\n\n`);
      }
    }
    if (createdSent) write('event: done\ndata: {}\n\n');
    else write(`event: error\ndata: ${JSON.stringify({ error: '未能从输出提取新 sessionId' })}\n\n`);
  } catch (e) {
    write(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`);
  } finally {
    runningSessions.delete(lockKey);
    try { if (!res.writableEnded) res.end(); } catch { /* 忽略 */ }
  }
}
```

- [ ] **Step 4: 路由表注册 + copy-command 端点**

在 `createServer` 路由里，紧接现有 `.../sessions/:sid/run` 的 match 块之后加：
```ts
    if (path === '/api/sessions/new' && req.method === 'POST') return await handleNewSession(req, res);
```
并在该 `if (m = path.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/run$/))` 块之后，加 copy-command（用新的 match 变量名避免与外层 `m` 冲突——注意外层已有 `let m`，复用即可，但 run 与 copy-command 是不同路径，分别 match）：
```ts
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/copy-command$/)) && req.method === 'GET') {
      const dirName = decodeURIComponent(m[1]);
      const sessionId = decodeURIComponent(m[2]);
      const providerId = url.searchParams.get('provider') || undefined;
      const cwd = await reader.getSessionCwd(dirName, sessionId);
      if (!cwd) return json(res, 400, { error: '无法确定该 session 的工作目录' });
      const env = providerId ? await providerEnv(providerId) : undefined;
      return json(res, 200, { command: buildResumeCommand(cwd, sessionId, env) });
    }
```

- [ ] **Step 5: WS upgrade 路由改判别 + new + provider query**

把 `server.on('upgrade', ...)` 整段替换为：
```ts
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const p = u.pathname;
  const provider = u.searchParams.get('provider') || undefined;
  const finish = (opts: Parameters<ReturnType<typeof createTerminalHandler>>[1]) => {
    wss.handleUpgrade(req, socket, head, (ws) => terminalHandler(ws as WebSocket, opts));
  };
  // 新会话终端：/api/terminal/new?cwd=...&provider=...
  if (p === '/api/terminal/new') {
    const cwd = u.searchParams.get('cwd') || '';
    void assertSafeCwd(cwd)
      .then(() => providerEnv(provider))
      .then((env) => finish({ mode: 'new', cwd, env }))
      .catch(() => { socket.destroy(); });
    return;
  }
  // 续接终端：/api/terminal/:dir/:sid[?provider=...]
  const m = p.match(/^\/api\/terminal\/([^/]+)\/([^/]+)$/);
  if (!m) { socket.destroy(); return; }
  const dirName = decodeURIComponent(m[1]);
  const sessionId = decodeURIComponent(m[2]);
  void providerEnv(provider).then((env) => finish({ mode: 'resume', dirName, sessionId, env }));
});
```

- [ ] **Step 6: 全局类型检查 + 测试**

Run: `npm run typecheck`
Expected: 无错误（Task 5 遗留的 server 签名问题已修）。
Run: `npm test`
Expected: 全部 PASS（无回归）。

- [ ] **Step 7: 提交**

```bash
git add src/server/index.ts
git commit -m "feat(server): /sessions/new + copy-command + /run providerId + 终端 new/provider 路由"
```

---

## Task 7: 飞书 app.providerId + `/provider` 命令

**Files:**
- Modify: `src/feishu/feishuConfig.ts`
- Modify: `src/feishu/commands.ts`
- Test: `tests/feishu/feishuConfig.test.ts`、`tests/feishu/commands.test.ts`

**Interfaces:**
- Produces: `FeishuApp.providerId?`、`PublicFeishuApp.providerId?`；`CommandContext.providers`/`currentProviderId`；`CommandResult` 的 `{ kind:'set-provider'; providerId: string | null }`。
- Consumes: Task 1 `matchProvider`、`publicConfig`。

- [ ] **Step 1: 写失败测试 — feishuConfig**

在 `tests/feishu/feishuConfig.test.ts` 末尾追加（参考该文件现有 mkdtemp + CLAUDE_WEBUI_DIR 模式；若已有 beforeEach 设 CLAUDE_WEBUI_DIR 则直接用）：
```ts
  it('providerId 读写贯通 + 留空保留旧值', async () => {
    await saveFeishuApps([{ id: 'a1', appId: 'a', appSecret: 's', allowedUserIds: [], domain: 'feishu', enableNotify: true, providerId: 'p1' }]);
    let apps = await loadFeishuApps();
    expect(apps[0].providerId).toBe('p1');
    // 留空（undefined）保留旧值
    await saveFeishuApps([{ id: 'a1', appId: 'a', appSecret: '', allowedUserIds: [], domain: 'feishu', enableNotify: true }]);
    apps = await loadFeishuApps();
    expect(apps[0].providerId).toBe('p1');
    // 显式 null 清除
    await saveFeishuApps([{ id: 'a1', appId: 'a', appSecret: '', allowedUserIds: [], domain: 'feishu', enableNotify: true, providerId: null }]);
    apps = await loadFeishuApps();
    expect(apps[0].providerId).toBeUndefined();
    // publicFeishuApps 也带 providerId
    const pub = await publicFeishuApps();
    expect(pub[0].providerId).toBeUndefined();
  });
```
（顶部 import 补 `loadFeishuApps`、`publicFeishuApps`、`saveFeishuApps` 若缺。）

- [ ] **Step 2: 写失败测试 — commands**

在 `tests/feishu/commands.test.ts` 改 `ctx` 增加 providers/currentProviderId/matchProvider：
```ts
function ctx(
  reader: ClaudeFileReader,
  state = new SessionState(),
  busy: string[] = [],
  providers: Array<{ id: string; name?: string }> = [],
  currentProviderId?: string,
  matchProvider?: (q: string) => Promise<string | undefined>,
): CommandContext {
  return { reader, state, busySessionIds: () => new Set(busy), providers, currentProviderId, matchProvider };
}
```
末尾追加：
```ts
  it('/provider 无参列出并标记当前', async () => {
    const r = await handleCommand('/provider', ctx(mockReader([], {}), new SessionState(), [], [{ id: 'p1', name: '生产' }, { id: 'p2', name: '测试' }], 'p1'));
    expect(r.kind).toBe('reply');
    expect(JSON.stringify((r as { card: unknown }).card)).toContain('生产');
    expect(JSON.stringify((r as { card: unknown }).card)).toContain('当前');
  });

  it('/provider <名称> 返回 set-provider（注入 matchProvider，不读盘）', async () => {
    const fake = async (q: string) => (q === '测试' ? 'p2' : undefined);
    const r = await handleCommand('/provider 测试', ctx(mockReader([], {}), new SessionState(), [], [], undefined, fake));
    expect(r).toEqual({ kind: 'set-provider', providerId: 'p2' });
  });

  it('/provider off 清除', async () => {
    const r = await handleCommand('/provider off', ctx(mockReader([], {})));
    expect(r).toEqual({ kind: 'set-provider', providerId: null });
  });

  it('/provider 未命中提示', async () => {
    const fake = async () => undefined;
    const r = await handleCommand('/provider nope', ctx(mockReader([], {}), new SessionState(), [], [], undefined, fake));
    expect(r.kind).toBe('reply-text');
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/feishu/feishuConfig.test.ts tests/feishu/commands.test.ts`
Expected: FAIL（providerId 字段/set-provider 不存在）。

- [ ] **Step 4: 实现 feishuConfig.ts**

- `FeishuApp` 接口加 `providerId?: string;`（在 `boundSession?` 后）。
- `PublicFeishuApp` 接口加 `providerId?: string;`。
- `normalizeApp` 返回对象加：`providerId: typeof r.providerId === 'string' ? r.providerId : undefined,`（注意：null/非字符串 → undefined）。
- `publicFeishuApps` 的 map 加 `providerId: a.providerId,`。
- `saveFeishuApps` 的 app 映射加：
```ts
      providerId: p.providerId !== undefined ? (p.providerId || undefined) : (old?.providerId ?? undefined),
```
（与 boundSession 同款：显式传值（含 null→undefined）覆盖；undefined 保留旧值。）

- [ ] **Step 5: 实现 commands.ts**

顶部加 import：`import { matchProvider } from '../config.js';`
- `CommandContext` 加：
```ts
  providers: Array<{ id: string; name?: string }>;
  currentProviderId?: string;
  /** 名称/id 匹配；默认用 config.matchProvider（读盘）。测试可注入 fake 避免读盘。 */
  matchProvider?: (query: string) => Promise<string | undefined>;
```
- `CommandResult` 联合加 `| { kind: 'set-provider'; providerId: string | null }`。
- `handleCommand` switch 加分支（在 `case 'new'` 附近）：
```ts
    case 'provider':
    case 'model':
      return await cmdProvider(arg, ctx);
```
- `HELP_TEXT` 数组中 `/new` 行后加一行：`'/provider [名称|id|off] — 设置本机器人使用的 provider',`
- 新增函数（文件末尾）：
```ts
async function cmdProvider(arg: string, ctx: CommandContext): Promise<CommandResult> {
  const provs = ctx.providers ?? [];
  const cur = ctx.currentProviderId;
  if (!arg.trim()) {
    if (!provs.length) return { kind: 'reply-text', text: '未配置任何 provider，当前用 env 默认。' };
    const lines = provs.map((p) => {
      const mark = p.id === cur ? ' ✅当前' : '';
      return `- ${p.name ?? p.id} (\`${p.id}\`)${mark}`;
    });
    return { kind: 'reply', card: mdCard('Provider', `当前：${cur ? `\`${cur}\`` : 'env 默认'}\n\n${lines.join('\n')}\n\n用 /provider <名称|id> 切换，/provider off 清除`, 'deep_blue') };
  }
  if (arg === 'off' || arg === 'default') return { kind: 'set-provider', providerId: null };
  const id = await (ctx.matchProvider ?? matchProvider)(arg);
  if (!id) return { kind: 'reply-text', text: `未找到匹配「${arg}」的 provider。` };
  return { kind: 'set-provider', providerId: id };
}
```

- [ ] **Step 6: 跑测试 + 类型检查**

Run: `npx vitest run tests/feishu/`
Expected: PASS。
Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add src/feishu/feishuConfig.ts src/feishu/commands.ts tests/feishu/feishuConfig.test.ts tests/feishu/commands.test.ts
git commit -m "feat(claude): 飞书 app.providerId + /provider 命令"
```

---

## Task 8: 飞书 Bot 注入 env + set-provider 处理

**Files:**
- Modify: `src/feishu/Bot.ts`
- Test: `tests/feishu/Bot.test.ts`

**Interfaces:**
- Consumes: Task 1 `providerEnv`、Task 7 `set-provider` result、`saveFeishuApps`（经 `onSetProvider` 回调）。
- Produces: `BotDeps.onSetProvider?: (providerId: string | null) => Promise<void>`；Bot 在 runNew/runContinue 注入 env。

- [ ] **Step 1: 写失败测试**

在 `tests/feishu/Bot.test.ts` 的 `makeBot` 里，把 `fakeRunner.run`/`runNew` 改为捕获 req：
```ts
  const capturedNew: any[] = [];
  const capturedRun: any[] = [];
  const fakeRunner = {
    async *run(rq: ClaudeRunRequest): AsyncGenerator<ClaudeRunEvent> { capturedRun.push(rq); for (const e of events) yield e; },
    async *runNew(rq: ClaudeNewRequest): AsyncGenerator<ClaudeRunEvent> { capturedNew.push(rq); for (const e of newEvents) yield e; },
  };
```
并在 `makeBot` opts 加 `providerId?: string`，传给 cfg：`providerId: opts.providerId`；返回对象加 `capturedNew, capturedRun`。
在 `describe` 块末尾追加：
```ts
  it('runNew 注入 app.providerId 的 env', async () => {
    const { bot, capturedNew } = makeBot({ providerId: 'p1' });
    // providerEnv 读 config，p1 不存在则回退 env；此处仅断言 env 字段被注入（非 undefined）
    process.env.ANTHROPIC_BASE_URL = 'http://env';
    await bot.handleMessage({ openId: 'ou_me', text: '/new D:\\proj hi', isMention: false });
    expect(capturedNew[0]?.env).toBeTruthy();
    expect(capturedNew[0]?.env?.ANTHROPIC_BASE_URL).toBe('http://env');
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('/provider <id> 触发 onSetProvider', async () => {
    const onSet: any[] = [];
    const { bot } = makeBot({ onSetProvider: async (id) => onSet.push(id) } as any);
    await bot.handleMessage({ openId: 'ou_me', text: '/provider off', isMention: false });
    expect(onSet).toEqual([null]);
  });
```
（`makeBot` 的 BotDeps 需支持 `onSetProvider`——见 Step 3。测试里用 `as any` 临时塞。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/feishu/Bot.test.ts`
Expected: FAIL（env 未注入 / onSetProvider 不存在）。

- [ ] **Step 3: 实现 Bot.ts**

- `BotDeps` 加：
```ts
  /** /provider 命令改 provider 后持久化（server 注入 saveFeishuApps 封装）。 */
  onSetProvider?: (providerId: string | null) => Promise<void>;
```
- `handleMessage` 里 `handleCommand` 的 ctx 加 `providers`/`currentProviderId`/`matchProvider`：
```ts
      const result = await handleCommand(clean, {
        reader: this.deps.reader,
        state: this.deps.state,
        busySessionIds: this.deps.busySessionIds,
        providers: [],          // server 注入真实列表（见 Task 9 server 接线）；Bot 内不读 config 列表
        currentProviderId: this.deps.config.providerId,
      });
```
> providers 列表：Bot 不直接读 config；`/provider`（无参）列表展示在 server 接线时由 server 预解析传入。**为简化**，让 `CommandContext.providers` 由 server 在调 handleCommand 前填充——但 Bot.handleMessage 内部调 handleCommand。**改法**：BotDeps 加 `providers: () => Promise<Array<{id:string;name?:string}>>`，handleMessage 里 `const providers = await this.deps.providers?.() ?? [];` 传入 ctx。server 注入 `() => publicConfig().then(c => c.providers)`。测试 makeBot 可注入空。
  
  故 `BotDeps` 再加 `providers?: () => Promise<Array<{ id: string; name?: string }>>;`，handleMessage 顶部（白名单校验后、调 handleCommand 前）加 `const providers = await this.deps.providers?.().catch(() => []) ?? [];`，ctx 传 `providers`。

- `handleMessage` 在 `if (result.kind === 'new-session')` 块附近加：
```ts
      if (result.kind === 'set-provider') {
        this.deps.config.providerId = result.providerId ?? undefined;
        try { await this.deps.onSetProvider?.(result.providerId); } catch { /* 忽略 */ }
        await this.deps.sender.sendText('open_id', openId, result.providerId ? `已切换 provider：${result.providerId}` : '已清除 provider，用 env 默认').catch(() => {});
        return;
      }
```
- `runNew` 与 `runContinue` 开头解析 env 并传入：
  - `runNew`：定位 `for await (const ev of this.deps.runner.runNew({ cwd, prompt, signal: ac.signal }))`，改前加 `const env = await providerEnv(this.deps.config.providerId);`，runNew 调用加 `env`。顶部 import 加 `import { providerEnv } from '../config.js';`。
  - `runContinue`：定位 `sessionRunner.runLocked({ sessionId: cur.sessionId, cwd: cur.cwd, prompt, signal: ac.signal }, ...)`，前加 `const env = await providerEnv(this.deps.config.providerId);`，调用加 `env`。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run tests/feishu/Bot.test.ts`
Expected: PASS。
Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/feishu/Bot.ts tests/feishu/Bot.test.ts
git commit -m "feat(claude): 飞书 Bot 注入 provider env + 处理 /provider set-provider"
```

---

## Task 9: server 接线飞书 providers/onSetProvider + /info

**Files:**
- Modify: `src/server/index.ts`（`startAllFeishuApps` 内构造 Bot 时注入）

**Interfaces:**
- Consumes: Task 8 `BotDeps.providers`/`onSetProvider`、`publicConfig`、`saveFeishuApps`。

- [ ] **Step 1: 注入 providers 与 onSetProvider**

在 `startAllFeishuApps` 里 `new FeishuBot({ ... })` 的 deps 对象中，`busySessionIds` 之后加：
```ts
        providers: async () => (await publicConfig()).providers.map((p) => ({ id: p.id, name: p.name })),
        onSetProvider: async (providerId) => {
          const cur = await loadFeishuApps();
          await saveFeishuApps(cur.map((a) => (a.id === cfg.id ? { ...a, providerId: providerId ?? undefined } : a)));
        },
```
（顶部 import 已有 `publicConfig`；`loadFeishuApps`/`saveFeishuApps` 已 import。）

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck && npm run build`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add src/server/index.ts
git commit -m "feat(claude): 飞书 Bot 注入 providers 列表与 onSetProvider 持久化"
```

---

## Task 10: 前端 desktop.pickDirectory（Electron + Tauri + web 回退）

**Files:**
- Modify: `web/src/lib/desktop.ts`
- Modify: `electron/preload.ts`、`electron/main.ts`
- Modify: `src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`、`src-tauri/permissions/commands.toml`、`src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: 前端 `pickDirectory(): Promise<string | null>`；桌面 bridge `window.__claudeWebuiDesktop.pickDirectory()`。

> 阅读现有 `web/src/lib/desktop.ts`、`electron/preload.ts`、`electron/main.ts`、`src-tauri/src/lib.rs`、`src-tauri/permissions/commands.toml`（已有 11 个命令的模式），按既有模式加第 12 个。

- [ ] **Step 1: web/desktop.ts 加 pickDirectory**

在 `web/src/lib/desktop.ts` 的 desktop 对象/导出中（与 `openWindow`、窗口控制同级）加：
```ts
  pickDirectory: (): Promise<string | null> => {
    const d = (globalThis as any).__claudeWebuiDesktop;
    if (d && typeof d.pickDirectory === 'function') return d.pickDirectory();
    return Promise.resolve(null); // web 回退（由调用方转输入框）
  },
```
（具体写法对齐该文件现有 `isDesktop`/`openWindow` 的导出结构。）

- [ ] **Step 2: Electron preload + main**

`electron/preload.ts` 的 `contextBridge.exposeInWorld('desktop', { ... })`（或 `__claudeWebuiDesktop`）里加：
```ts
  pickDirectory: () => ipcRenderer.invoke('desktop:pickDirectory'),
```
`electron/main.ts` 的 ipcMain 注册区加：
```ts
ipcMain.handle('desktop:pickDirectory', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
```
（顶部 `import { dialog, ipcMain } from 'electron';` 按需补。）

- [ ] **Step 3: Tauri 命令 + 插件 + 权限**

`src-tauri/Cargo.toml` 的 `[dependencies]` 加 `tauri-plugin-dialog = "2"`。
`src-tauri/src/lib.rs`：
- 在 tauri builder 的 `.plugin(...)` 链加 `.plugin(tauri_plugin_dialog::init())`。
- 在 `invoke_handler!` 的命令列表加 `desktop_pick_directory`，并实现：
```rust
#[tauri::command]
async fn desktop_pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}
```
（`blocking_pick_folder` 在异步命令里安全；若签名/类型按 tauri-plugin-dialog 实际 API 微调。）
`src-tauri/permissions/commands.toml` 加：
```toml
[[permission]]
identifier = "allow-desktop-pick-directory"
description = "允许打开系统文件夹选择对话框"
commands.allow = ["desktop_pick_directory"]
```
`src-tauri/capabilities/default.json` 的 `permissions` 数组加 `"allow-desktop-pick-directory"`（remote.urls 段已覆盖 localhost，无需改）。

- [ ] **Step 4: 类型检查（三处）**

Run: `cd web && npm run typecheck`
Run: `tsc -p electron/tsconfig.json`
Run（Tauri 编译检查）: `npm run build:tauri` 太重——改为 `cargo check --manifest-path src-tauri/Cargo.toml`（若环境有 rust）。
Expected: web/electron typecheck 无错误；cargo check 无错误（若有 rust 工具链；无则标记待实测）。

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/desktop.ts electron/preload.ts electron/main.ts src-tauri/
git commit -m "feat(web): pickDirectory 桌面原生选目录框（Electron dialog + Tauri plugin-dialog）"
```

---

## Task 11: 前端 useProviderMenu + ProviderMenu 组件

**Files:**
- Create: `web/src/composables/useProviderMenu.ts`
- Create: `web/src/components/ProviderMenu.vue`

**Interfaces:**
- Produces: `useProviderMenu()` → `{ open(e: MouseEvent, onPick: (providerId?: string) => void): void }`；`<ProviderMenu>` 渲染一个定位到光标的 NDropdown，选项=providers + 「默认（活动/env）」。

- [ ] **Step 1: composable**

创建 `web/src/composables/useProviderMenu.ts`：
```ts
import { ref } from 'vue';

/** 右键 provider 菜单状态：单例，由 <ProviderMenu> 渲染，任意按钮 @contextmenu 触发。 */
export function useProviderMenu() {
  const show = ref(false);
  const x = ref(0);
  const y = ref(0);
  let picker: ((providerId?: string) => void) | null = null;

  function open(e: MouseEvent, onPick: (providerId?: string) => void): void {
    e.preventDefault();
    picker = onPick;
    x.value = e.clientX;
    y.value = e.clientY;
    show.value = true;
  }
  function choose(providerId?: string): void {
    show.value = false;
    picker?.(providerId);
    picker = null;
  }
  return { show, x, y, open, choose };
}
```

- [ ] **Step 2: 组件**

创建 `web/src/components/ProviderMenu.vue`：
```vue
<script setup lang="ts">
import { computed } from 'vue';
import { NDropdown } from 'naive-ui';
import { useConfig } from '../composables/useConfig';
import type { DropdownOption } from 'naive-ui';

const props = defineProps<{
  show: boolean;
  x: number;
  y: number;
}>();
const emit = defineEmits<{ (e: 'choose', providerId?: string): void; (e: 'update:show', v: boolean): void }>();

const cfg = useConfig();
const options = computed<DropdownOption[]>(() => {
  const list: DropdownOption[] = [{ label: '默认（活动/env）', key: '' }];
  for (const p of cfg.data.value?.providers ?? []) {
    list.push({ label: `${p.name} · ${p.model}`, key: p.id });
  }
  return list;
});
function onSelect(key: string): void {
  emit('choose', key === '' ? undefined : key);
}
</script>

<template>
  <NDropdown
    placement="bottom-start"
    trigger="manual"
    :show="props.show"
    :x="props.x"
    :y="props.y"
    :options="options"
    @select="onSelect"
    @clickoutside="emit('update:show', false)"
  />
</template>
```

- [ ] **Step 3: 类型检查**

Run: `cd web && npm run typecheck`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add web/src/composables/useProviderMenu.ts web/src/components/ProviderMenu.vue
git commit -m "feat(web): useProviderMenu + ProviderMenu 右键选 provider 下拉"
```

---

## Task 12: 前端 NewSessionDialog + 新建会话 API + 入口按钮

**Files:**
- Modify: `web/src/api.ts`
- Create: `web/src/components/NewSessionDialog.vue`
- Modify: `web/src/components/SessionsView.vue`、`web/src/views/DirPage.vue`

**Interfaces:**
- Consumes: Task 10 `pickDirectory`、Task 11 `useProviderMenu`/`ProviderMenu`、`/api/sessions/new` SSE、`openWindow`、`broadcastInvalidate`、router。
- Produces: `createSessionStream(cwd, prompt, providerId?, onEvent, signal)`；`<NewSessionDialog>`；SessionsView/DirPage 的 `+ 新会话`。

- [ ] **Step 1: api.ts 加 createSessionStream**

在 `web/src/api.ts` 加：
```ts
import { readSSE, type SSEEvent } from './lib/sse';

/** 新建会话 SSE：POST /api/sessions/new，逐事件回调。 */
export async function createSessionStream(
  cwd: string,
  prompt: string,
  onEvent: (ev: SSEEvent) => void,
  opts: { providerId?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const resp = await fetch('/api/sessions/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, prompt, providerId: opts.providerId }),
    signal: opts.signal,
  });
  if (!resp.ok || !resp.body) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  await readSSE(resp, onEvent);
}
```

- [ ] **Step 2: NewSessionDialog.vue**

创建 `web/src/components/NewSessionDialog.vue`：
```vue
<script setup lang="ts">
import { ref } from 'vue';
import { NModal, NInput, NRadio, NRadioGroup, NButton, useMessage } from 'naive-ui';
import { useRouter } from 'vue-router';
import { createSessionStream } from '../api';
import { pickDirectory } from '../lib/desktop';
import { openWindow } from '../lib/openWindow';
import { broadcastInvalidate } from '../lib/broadcast';
import { useProviderMenu } from '../composables/useProviderMenu';
import ProviderMenu from './ProviderMenu.vue';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>();
const router = useRouter();
const msg = useMessage();

const cwd = ref('');
const mode = ref<'prompt' | 'terminal'>('prompt');
const prompt = ref('');
const running = ref(false);
const providerId = ref<string | undefined>(undefined); // 右键选的 provider

const menu = useProviderMenu();

async function chooseDir(): Promise<void> {
  const p = await pickDirectory();
  if (p) cwd.value = p;
}
function launch(overridePid?: string): void {
  const pid = overridePid !== undefined ? overridePid : providerId.value;
  if (pid !== undefined) providerId.value = pid;
  void (mode.value === 'prompt' ? runSingle(pid) : runTerminal(pid));
}
async function runSingle(pid?: string): Promise<void> {
  if (!cwd.value.trim()) { msg.warning('请选择或输入工作目录'); return; }
  if (!prompt.value.trim()) { msg.warning('请输入首条指令'); return; }
  running.value = true;
  try {
    await createSessionStream(cwd.value.trim(), prompt.value.trim(), (ev) => {
      if (ev.event === 'created' && ev.data?.sessionId) {
        broadcastInvalidate(['projects', 'sessions']);
        emit('update:show', false);
        router.push({ name: 'session', params: { dir: ev.data.dirName, sid: ev.data.sessionId } });
      } else if (ev.event === 'error') {
        msg.error(String(ev.data?.error ?? '失败'));
      }
    }, { providerId: pid });
  } catch (e) { msg.error(String(e)); }
  finally { running.value = false; }
}
function runTerminal(pid?: string): void {
  if (!cwd.value.trim()) { msg.warning('请选择或输入工作目录'); return; }
  emit('update:show', false);
  const q = `?cwd=${encodeURIComponent(cwd.value.trim())}${pid ? `&provider=${encodeURIComponent(pid)}` : ''}`;
  openWindow(`/terminal/new${q}`);
}
</script>

<template>
  <NModal :show="props.show" @update:show="emit('update:show', $event)" preset="card" title="新建会话" style="max-width: 520px">
    <div class="flex flex-col gap-3">
      <div class="flex gap-2">
        <NInput v-model:value="cwd" placeholder="工作目录绝对路径…" />
        <NButton @click="chooseDir">选择目录…</NButton>
      </div>
      <NRadioGroup v-model:value="mode">
        <NRadio value="prompt">单发首条指令</NRadio>
        <NRadio value="terminal">交互式终端</NRadio>
      </NRadioGroup>
      <NInput v-if="mode === 'prompt'" v-model:value="prompt" type="textarea" placeholder="首条指令…" :disabled="running" />
      <div class="flex justify-end gap-2">
        <NButton @click="emit('update:show', false)">取消</NButton>
        <NButton type="primary" :loading="running" :disabled="running" @click="launch()" @contextmenu.prevent="menu.open($event, (pid) => launch(pid))">
          启动
        </NButton>
      </div>
    </div>
    <ProviderMenu :show="menu.show.value" :x="menu.x.value" :y="menu.y.value" @choose="menu.choose" @update:show="menu.show.value = $event" />
  </NModal>
</template>
```

- [ ] **Step 3: SessionsView 接入 + 新建会话按钮**

在 `web/src/components/SessionsView.vue`：
- import `NewSessionDialog`、`useProviderMenu`、`ProviderMenu`。
- 加状态 `const showNew = ref(false);` 和 `const newMenu = useProviderMenu();`。
- 在左侧栏 header（搜索框上方那行 icon 按钮区，约 line 491 的「全部收起」按钮旁）加按钮：
```vue
<button class="icon-btn" title="新建会话（右键选 provider）" @click="showNew = true" @contextmenu.prevent="newMenu.open($event, () => { showNew = true })">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
</button>
```
- 在模板末尾（`</template>` 前）加：
```vue
<NewSessionDialog :show="showNew" @update:show="showNew = $event" />
<ProviderMenu :show="newMenu.show.value" :x="newMenu.x.value" :y="newMenu.y.value" @choose="newMenu.choose" @update:show="newMenu.show.value = $event" />
```

- [ ] **Step 4: DirPage 接入**

`web/src/views/DirPage.vue` 同样加 `showNew`、`newMenu`、header 的 `+ 新会话` 按钮、模板末尾的 `<NewSessionDialog>` + `<ProviderMenu>`（import 一致）。

- [ ] **Step 5: 类型检查 + 手动验证**

Run: `cd web && npm run typecheck`
Expected: 无错误。
手动（dev）：`npm run dev` + `cd web && npm run dev` → 打开 5173 → 点 `+ 新会话` → 选目录/输路径 → 单发首条指令 → 跳转到新 session 时间线；切换「交互式终端」→ 开新终端窗口。右键启动按钮 → 选 provider。

- [ ] **Step 6: 提交**

```bash
git add web/src/api.ts web/src/components/NewSessionDialog.vue web/src/components/SessionsView.vue web/src/views/DirPage.vue
git commit -m "feat(web): NewSessionDialog 目录内新建会话（单发+终端）+ 入口按钮"
```

---

## Task 13: 前端 TerminalPage new 模式 + 路由 + popTerminal provider

**Files:**
- Modify: `web/src/router/index.ts`
- Modify: `web/src/views/TerminalPage.vue`
- Modify: `web/src/components/SessionsView.vue`、`web/src/views/DirPage.vue`、`web/src/views/SessionPage.vue`

**Interfaces:**
- Consumes: `/api/terminal/new?cwd=&provider=`、`/api/terminal/:dir/:sid?provider=`。

- [ ] **Step 1: 路由 + title/favicon**

阅读 `web/src/router/index.ts` 现有 `/terminal/:dir/:sid` 路由与 `beforeEach` title 分支。加：
- 路由表加 `{ path: '/terminal/new', name: 'terminal-new', component: TerminalPage }`（注意要放在 `/terminal/:dir/:sid` **之前**，避免 `new` 被当 `:dir`）。
- `beforeEach` 里 `/terminal/new` 的 title/favicon 同 session 终端（`新会话 · 终端`）。

- [ ] **Step 2: TerminalPage 支持 new 模式**

阅读 `web/src/views/TerminalPage.vue` 现有 WS 连接（按 `route.params.dir/sid` 拼 `/api/terminal/<dir>/<sid>`）。改为：
```ts
const route = useRoute();
const isNew = computed(() => route.name === 'terminal-new');
const wsUrl = computed(() => {
  const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal`;
  if (isNew.value) {
    const cwd = String(route.query.cwd ?? '');
    const provider = route.query.provider ? `&provider=${encodeURIComponent(String(route.query.provider))}` : '';
    return `${base}/new?cwd=${encodeURIComponent(cwd)}${provider}`;
  }
  const dir = encodeURIComponent(String(route.params.dir));
  const sid = encodeURIComponent(String(route.params.sid));
  const provider = route.query.provider ? `?provider=${encodeURIComponent(String(route.query.provider))}` : '';
  return `${base}/${dir}/${sid}${provider}`;
});
```
标题：`isNew` 时 `新会话 · ${route.query.cwd}`，否则现有逻辑。WS 连接用 `wsUrl`。

- [ ] **Step 3: popTerminal 加 providerId**

`SessionsView.vue` 的 `popTerminal(dir, sid)` 改为 `popTerminal(dir: string, sid: string, providerId?: string)`：
```ts
function popTerminal(dir: string, sid: string, providerId?: string): void {
  const q = providerId ? `?provider=${encodeURIComponent(providerId)}` : '';
  openWindow(`/terminal/${encodeURIComponent(dir)}/${encodeURIComponent(sid)}${q}`);
}
```
🖥 按钮：左键 `@click.stop="popTerminal(node.p.dirName, s.sessionId)"`，右键 `@contextmenu.prevent="terminalMenu.open($event, (pid) => popTerminal(node.p.dirName, s.sessionId, pid))"`。在 SessionsView / SessionPage 各加一个 `useProviderMenu` 实例 `const terminalMenu = useProviderMenu();` + 模板末尾对应 `<ProviderMenu :show="terminalMenu.show.value" :x="terminalMenu.x.value" :y="terminalMenu.y.value" @choose="terminalMenu.choose" @update:show="terminalMenu.show.value = $event" />`。DirPage 无 🖥 按钮（session 级才进终端），不改。

- [ ] **Step 4: 类型检查 + 手动验证**

Run: `cd web && npm run typecheck`
Expected: 无错误。
手动：session 行 🖥 左键开终端；右键选 provider 后开终端（该终端 claude 用选中 provider）。`/terminal/new` 新会话终端可用。

- [ ] **Step 5: 提交**

```bash
git add web/src/router/index.ts web/src/views/TerminalPage.vue web/src/components/SessionsView.vue web/src/views/DirPage.vue web/src/views/SessionPage.vue
git commit -m "feat(web): TerminalPage new 模式 + /terminal/new 路由 + popTerminal provider 透传"
```

---

## Task 14: 前端 续接发送 + 复制命令 的 provider 右键

**Files:**
- Modify: `web/src/api.ts`（加 copyCommand）
- Modify: `web/src/components/SessionsView.vue`、`web/src/views/SessionPage.vue`（sendPrompt providerId）
- Modify: `web/src/components/SessionsView.vue`、`web/src/views/DirPage.vue`、`web/src/views/SessionPage.vue`（copyResume providerId）

**Interfaces:**
- Consumes: `/run` body `providerId`、`/copy-command` 端点。

- [ ] **Step 1: api.ts 加 copyCommand**

```ts
export async function copyCommand(dir: string, sid: string, providerId?: string): Promise<string> {
  const q = providerId ? `?provider=${encodeURIComponent(providerId)}` : '';
  const r = await fetch(`/api/projects/${dir}/sessions/${sid}/copy-command${q}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { command: string }).command;
}
```

- [ ] **Step 2: sendPrompt 加 providerId（SessionsView + SessionPage）**

`SessionsView.vue` 的 `sendPrompt(override?: string)` 改签名为 `sendPrompt(override?: string, providerId?: string)`，fetch body 改为：
```ts
      body: JSON.stringify({ prompt, providerId }),
```
发送按钮：左键 `sendPrompt()`，右键 `sendMenu.open($event, (pid) => sendPrompt(undefined, pid))`。加 `sendMenu = useProviderMenu()` + `<ProviderMenu>`。

SessionPage.vue 同样改（它有自己的 sendPrompt 副本）。

- [ ] **Step 3: copyResume 加 providerId**

`SessionsView.vue` 的 `copyResume(cwd, sid)` 改为 `copyResume(cwd: string, sid: string, providerId?: string)`：
- 无 providerId：保持现状（本地拼 `cd "${cwd}" && claude --resume ${sid}`）。
- 有 providerId：`const cmd = await copyCommand(store.dirName, sid, providerId);` 前加确认 `if (!confirm('复制将包含该 provider 的密钥（ANTHROPIC_AUTH_TOKEN），确认？')) return;`，再写剪贴板。
📋 按钮：左键 `copyResume(cwd, sid)`，右键 `copyMenu.open($event, (pid) => copyResume(cwd, sid, pid))`。加 `copyMenu` + `<ProviderMenu>`。

DirPage.vue / SessionPage.vue 的 copyResume 副本同样改（DirPage 用 `copyCommand(dir, sid, pid)`，dir 来自 route）。

- [ ] **Step 4: 类型检查 + 手动验证**

Run: `cd web && npm run typecheck`
Expected: 无错误。
手动：续接发送右键选 provider → 该次 resume 用选中 provider；📋 右键选 provider → 确认后复制含 env 前缀的命令。

- [ ] **Step 5: 提交**

```bash
git add web/src/api.ts web/src/components/SessionsView.vue web/src/views/DirPage.vue web/src/views/SessionPage.vue
git commit -m "feat(web): 续接发送/复制命令支持右键选 provider"
```

---

## Task 15: FeishuSettings provider 下拉 + 文档同步

**Files:**
- Modify: `web/src/components/FeishuSettings.vue`
- Modify: `docs/design.md`、`README.md`

- [ ] **Step 1: FeishuSettings 加 provider 选择**

阅读 `web/src/components/FeishuSettings.vue` 现有表单结构（每个 app 一组字段）。在每个 app 表单加 provider 下拉（选项来自 `useConfig()` 的 providers + 「默认」），绑定到 app 输入的 `providerId`（保存时随 `saveFeishuApps` 提交）。

- [ ] **Step 2: 文档同步**

`docs/design.md`：
- §4 新增小节「目录内新建会话」与「右键选 provider 启动」（端点 `/api/sessions/new`、`/api/terminal/new`、`/api/.../copy-command`；`providerEnv` 机制；桌面 `pickDirectory`）。
- §7 端点表加三行 + `/run` 标注 providerId。
- §11 终端加 new 模式 + provider query。
- §12 飞书加 `/provider` 命令 + `providerId` 字段 + onSetProvider。
- 「当前进度/下一步」更新。

`README.md`：功能列表加「新建会话（选目录/单发+终端）」「右键选 provider 启动/恢复」「飞书 /provider」。

- [ ] **Step 3: 全量验证**

Run: `npm test && npm run typecheck && npm run build && cd web && npm run typecheck && cd .. && tsc -p electron/tsconfig.json`
Expected: 全过。

- [ ] **Step 4: 提交**

```bash
git add web/src/components/FeishuSettings.vue docs/design.md README.md
git commit -m "docs: 同步新建会话+右键 provider 设计，FeishuSettings 加 provider 下拉"
```

---

## Self-Review 笔记（实现时自查）

- **Spec 覆盖**：§3 providerEnv→Task1；§4.2 Runner env→Task2；§4.3 端点→Task6；§4.4 TerminalManager→Task5；§5.1 NewSessionDialog→Task12；§5.2 TerminalPage→Task13；§5.3 desktop→Task10；§5.4 ProviderMenu→Task11；§5.5 四入口→Task12/13/14；§6 飞书→Task7/8/9；§7 cwdGuard→Task4；copy-command→Task3/14。全覆盖。
- **类型一致**：`providerEnv`、`matchProvider`、`extractSessionId`、`buildResumeCommand`、`assertSafeCwd`、`spawnSpec`、`TerminalOpts`、`createSessionStream`、`copyCommand`、`pickDirectory` 跨任务签名一致。
- **顺序依赖**：Task5 改 TerminalManager 签名 → 必须与 Task6（server）配套，中间全局 typecheck 会报错（Task5 Step4 已说明推迟）。Task7 的 `matchProvider` 注入问题已在 Step5 修正为 `ctx.matchProvider`。
