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