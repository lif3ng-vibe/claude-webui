# claude-webui

本地、单用户、无鉴权的 web 工具，两大能力：

1. **Claude session 查看与续接** — 只读 `~/.claude/projects/**`，浏览工作目录 / session / 消息时间线；选某步向 LLM 深问（只读磁盘工具查证）；续接 session 发指令（CLI 包裹 `claude --resume`，SSE 流式）。
2. **Anthropic 对话** — 预置系统提示词库 + 系统提示词编辑 + 流式对话。兼容任何 Anthropic 兼容代理（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`）。

设计决策见 [`docs/design.md`](docs/design.md)（含“当前进度 / 下一步”）。约定见 [`CLAUDE.md`](CLAUDE.md)。

## 技术栈

- 后端：Node + TypeScript（`src/`），`node:http` + SSE
- 前端：Vue 3 + Vite + TS + UnoCSS + VueUse + Naive UI + Pinia + @tanstack/vue-query + markdown-it + Shiki（`web/`）
- 传输：SSE；持久化：`~/.claude-webui/` 下 JSON 文件（config / prompts / conversations）

## 运行

### 开发模式（双进程，热更新）

```bash
npm install              # 后端依赖
npm run dev              # 后端 API：http://localhost:3000

cd web && npm install    # 前端依赖
cd web && npm run dev    # 前端 UI：http://localhost:5173（代理 /api 到 3000）
```

开发时打开 **http://localhost:5173**。

### 单进程模式（构建后）

```bash
npm install
npm run build:web        # 构建前端到 web/dist
npm run dev              # 后端同时 serve web/dist
```

打开 **http://localhost:3000**（后端 serve 构建产物 + API）。

## 配置

provider 凭据从环境变量读取（优先）或 `~/.claude-webui/config.json`：

- `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`（Anthropic 兼容代理）
- `ANTHROPIC_MODEL`（自动去掉 `[1m]` 之类上下文窗口后缀）

预置系统提示词存于 `~/.claude-webui/prompts.json`（UI 内可增删）。

## 测试 / 检查

```bash
npm test            # 后端单测（vitest）
npm run typecheck   # 后端 + 前端类型检查（cd web && npm run typecheck 单独查前端）
```

## 安全说明

- `~/.claude` 只读，绝不写回 session jsonl。
- API key 只在后端，前端不接触原始 key。
- 续接 session 以 `--dangerously-skip-permissions` 运行 `claude --resume`，会真实修改目标 session 及其工作目录——UI 发送前有确认弹窗。
- 深问的磁盘工具只读（read_file/list_files/grep），作用域限 session cwd + `~/.claude`，路径越界拒绝。