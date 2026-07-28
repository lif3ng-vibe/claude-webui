# claude-webui

本地、单用户、无鉴权的 web 工具：查看/续接 Claude Code session，并与 Anthropic 对话。详见 `docs/design.md`。

## 语言约定
- **代码注释和 commit message 使用中文。**
- 标识符（变量、函数、类型）、字符串字面量、技术术语用英文。
- 文档（design.md 等）以中文为主。

## 提交规范（Conventional Commits，中文）
- 格式：`<type>(<scope>): <主题>`
- type：`feat` / `fix` / `chore` / `docs` / `refactor` / `test` / `build` / `perf`
- scope（可选）：`claude` / `provider` / `server` / `web` / `tooling`
- 主题：祈使句、≤72 字符、句末不加句号
- body：每行 ≤72 字符，解释“为什么”
- 破坏性变更在 footer 用 `BREAKING CHANGE:`
- 例：`feat(claude): 解析 stream-json 并以 SSE 转发 delta`

## 硬规则（不可违反）
- `~/.claude` 只读，绝不写回 session jsonl / history.jsonl。
- API key 只存在后端，前端永不接触原始 key。
- 永不读取或显示敏感文件（`settings*.json` / `mcp.json` / `.env` / `.ssh` / `.gnupg`）。

## 开发
- `npm test` 跑单测；`npm run typecheck` 类型检查；`npm run build` 编译。
- `npm run dev` 启开发服务（http://localhost:3000）。
- 续接 session 前置：每个 sessionId 加锁，禁止并发写同一 session。

## 当前进度
状态与下一步见 `docs/design.md` 的"当前进度 / 下一步"一节。开工前先读该节，再按需读全文。