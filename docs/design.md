# claude-webui — Design (v1)

> Status: design locked via a `grilling` session. This is the shared-understanding spec.

## Purpose

A **local, single-user, no-auth** web tool with two capabilities in one UI:

1. **Claude session viewer + continuer** — read `~/.claude/projects/**`, browse working dirs → sessions → message timeline; continue a session or send it an instruction by wrapping the `claude` CLI.
2. **Anthropic chat + session-step deep-study** — plain chat with a library of preset system prompts (test model capabilities across the Anthropic model family); and "ask the LLM about a step in a Claude session" using **read-only** filesystem tools so the LLM can read real files to explain it.

## Hard rules

- `~/.claude` is **read-only**. Never write back to session jsonl / `history.jsonl`.
- API keys live **only in the backend**; the browser never sees raw keys.
- Secrets (`settings*.json`, `mcp.json`, `.env`, `.ssh`, `.gnupg`) are never read or displayed.

## Resolved decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Audience / deployment | Single-user, pure local, no auth |
| 2 | Continue-session mechanism | CLI wrap (`claude --resume`), not API rebuild |
| 3 | Provider half | Plain chat + preset system-prompt library; tool-use only for "study a session step" |
| 4 | Disk-tool scope | Read-only; range = session cwd + `~/.claude` (read-only). No writes |
| 5 | CLI execution model | One-shot spawn per instruction (`claude --resume <id> -p ... --output-format stream-json --dangerously-skip-permissions`); per-`sessionId` lock. `--resume` does not fork by default |
| 6 | Permissions | Full `--dangerously-skip-permissions`; `ClaudeRunner` accepts `allowedTools`/`disallowedTools` (default empty = skip). Whitelist mode is a config switch |
| 7 | Providers | Anthropic only (chat + prompt tests + tool study); `Provider` interface reserved for extension |
| 8 | Backend runtime | Node + TypeScript |
| 9 | Frontend stack | Vue 3 + Vite + TS; Naive UI shell + markdown-it + Shiki + @tanstack/vue-virtual + custom message/tool-call components; Pinia + @tanstack/vue-query |
| 10 | Chat UI route | Compose (no chat-specific lib) — `assistant-ui` is React-only, a known cost of choosing Vue |
| 11 | Transport / storage | SSE; JSON files under `~/.claude-webui/` (`config.json`, `prompts.json`, `conversations/<id>.json`) |

## Read / display scope (v1)

Read **only** `~/.claude/projects/**`. Three-level display:

1. **Working dirs** — list `~/.claude/projects/*` (dir name is an encoding of the cwd). The real cwd is read authoritatively from the `cwd` field inside a session's jsonl messages; the encoded dir name is a fallback only.
2. **Sessions** — per dir: `sessionId`, last-activity (mtime), message count, first user message as preview, size.
3. **Message timeline** — per session: user / assistant / tool-call (name + input + truncated result) with timestamps. This timeline also feeds the "select a step to ask about" feature.

Deferred: `history.jsonl`, `stats-cache.json`, `memory/`, `settings*`/`mcp.json`, `plans`, `tasks`.

## Path encoding

Claude Code encodes a cwd into the projects dir name by replacing each `/`, `\`, and `:` with `-`:

- `C:\Users\lif3n\src\claude-webui` → `C--Users-lif3n-src-claude-webui`
- Case is preserved; literal `-` in folder names is preserved.

Decoding is **ambiguous** (a literal `-` is indistinguishable from a separator), so the authoritative cwd comes from the jsonl `cwd` field, not from decoding. `encodeCwd` is unit-tested against known mappings.

## Module skeleton

```
src/
  claude/
    pathEncoding.ts   # encodeCwd (+ heuristic decode), unit-tested
    FileReader.ts     # read-only access to ~/.claude/projects/**
    Runner.ts         # ClaudeRunner: wraps `claude --resume <id> -p` one-shot
  provider/
    Provider.ts       # Provider interface (stream + tool-use)
    AnthropicProvider.ts  # v1 adapter (stub)
tests/
  claude/
    pathEncoding.test.ts
    FileReader.test.ts
```

## Deferred to v2 (revisit with user before building)

- Multi-provider cross-vendor comparison; format differences (OpenAI-compatible vs Anthropic Messages) — irrelevant for the chat adapter, relevant for tool-use adapters.
- Disk-tool write capability (sandboxed temp dir).
- Persistent interactive execution model (B) + WebSocket bidirectional.
- SQLite persistence (when conversations need search/pagination).
- `memory/` browser, stats dashboard, history-prompt view.

## 当前进度 / 下一步

> 维护说明：每完成一个里程碑就更新本节。这是**随 git 仓库走**的进度来源；`~/.claude/projects/<cwd>/memory/` 下的项目记忆是本地镜像，可能滞后，以本文件为准。

**已完成（main 分支，未 push）：**
- `bad140f` 骨架：设计文档、claude/provider 接口、路径编码单测
- `a0f0b16` 可运行读侧：HTTP 服务（projects/sessions/messages 只读 API）+ session 浏览查看器 + 搜索高亮
- `f8c0b52` 续接能力：`ClaudeRunner`（prompt 经 stdin 传入避免注入、Windows 需 `shell:true`）+ SSE `/run` 端点 + per-sessionId 锁 + 前端发指令流式显示
- `7ee7443` provider 对话：`AnthropicProvider`（SDK 流式，text/thinking/tool_use/done/error，兼容 Anthropic 代理）+ `config`（env 优先、去 `[1m]` 后缀）+ `PromptsStore`（预置提示词库）+ `/api/config|prompts|chat` + 前端 Sessions/Chat 视图切换
- `c4b9e01` session 步骤深问：`AnthropicProvider` agent 循环（executeTool 回调）+ `fsTools` 只读磁盘工具（read_file/list_files/grep，路径越界防护，作用域 = session cwd + `~/.claude`）+ `/api/study`（SSE）+ 前端每步“🔍问”按钮流式深问
- 28 测试通过；`npm run dev` 启服务在 http://localhost:3000

**下一步（顺序）：**
1. Vue 3 + Vite 前端：Naive UI + markdown-it + Shiki + @tanstack/vue-virtual + 自写消息/tool-call 组件 + Pinia/@tanstack/vue-query（替换当前原生 HTML 查看器）
2. 打磨：续接后回读 jsonl 刷新、消息体折叠 tool-call/diff、消息内容搜索、markdown 代码高亮（当前为纯文本）
3. v2 项（见 Deferred）