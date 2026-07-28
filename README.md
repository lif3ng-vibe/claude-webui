# claude-webui

A local, single-user web UI that:

1. Reads `~/.claude/projects/**` to view working directories and Claude Code session records, continue a session, or send it an instruction (via `claude --resume`).
2. Provides an Anthropic chat surface with a library of preset system prompts, and lets you ask an LLM about a specific step in a Claude session using read-only filesystem tools.

**Status:** v1 scaffold — interfaces + path-encoding tests. See [`docs/design.md`](docs/design.md) for the full design.

## Stack

- Backend: Node + TypeScript
- Frontend (planned): Vue 3 + Vite + TS, Naive UI, markdown-it + Shiki, @tanstack/vue-virtual, Pinia + @tanstack/vue-query
- Transport: SSE
- Storage: JSON files under `~/.claude-webui/`

## Develop

```bash
npm install
npm test        # run unit tests
npm run typecheck
```