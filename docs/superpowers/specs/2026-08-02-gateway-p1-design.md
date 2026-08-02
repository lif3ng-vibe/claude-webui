# 多 provider 中转服务 P1（Anthropic 透传 + 请求查看）— 设计稿

> 日期：2026-08-02 ｜ 状态：待审阅
> 让 claude-webui 成为可观测的 LLM 网关：外部工具（Claude Code / Cursor / 脚本）把 `ANTHROPIC_BASE_URL` 指向它，请求被透传到配置的 Anthropic 兼容 provider，每次请求的提示词与返回都可查看。本稿是分阶段计划的 **P1**。

## 1. 背景与目标

claude-webui 现在是本地查看 Claude session + 对话的工具。本功能让它额外充当**外部工具的 LLM 代理端点**：透明转发 + 全量记录，便于观测"每个步骤的提示词和返回"（如 Claude Code 的工具调用全过程）。

P1 只做 **Anthropic 兼容透传**（最小可用 + 可观测）。OpenAI 端点 / provider / 格式转换留 P2/P3。

## 2. 范围

**P1 做**
- 对外 `POST /v1/messages`（Anthropic 兼容，非流式 + 流式 SSE）。
- 按 `model` 路由到配置的 Anthropic 兼容 provider（无匹配用活动 provider）。
- 字节级透传（请求体原样转发，响应流原样 pipe 回），保真。
- 记录每次请求（prompt + response + 元数据）到文件。
- 前端「中转日志」视图：列表 + 详情。
- 可选 gateway key（留空=本地不校验）。

**P1 不做**（P2/P3）
- OpenAI 兼容端点 `/v1/chat/completions`、OpenAI provider 后端。
- OpenAI↔Anthropic 格式转换（全矩阵）。
- SQLite 持久化（P1 用文件）、会话聚合、实时流式查看界面。
- `/v1/messages/count_tokens` 等其它 Anthropic 端点（按需后加）。

## 3. 关键决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| 1 | 定位 | 外部工具的代理端点（LLM 网关） | 用户选定 |
| 2 | 对外格式 | Anthropic 兼容（P1）；OpenAI 兼容留 P2 | P1 先最小可用 |
| 3 | 后端 provider | 复用现有 Anthropic 兼容 providers（多 baseURL/key） | 转换最少 |
| 4 | 透传方式 | `fetch` 字节级透传，**不用** AnthropicProvider | AnthropicProvider 跑 agent 循环 + 压缩 messages，破坏保真；透传要原样 |
| 5 | 路由 | `body.model` 匹配 provider.model；无匹配用活动 provider | 外部工具填对 model 名即路由 |
| 6 | 持久化 | 文件 `~/.claude-webui/gateway/<id>.json`（仿 conversations） | P1 量小；SQLite 留后续 |
| 7 | 认证 | 可选 `gatewayKey`（config，留空=不校验，本地零配置） | 与 claude-webui 本地定位一致 |
| 8 | 查看形态 | 请求列表 + 详情（点开看完整 request/response） | 用户选定 |

## 4. 架构与模块

### 4.1 新增 `src/gateway/`

- **`recorder.ts`** — 请求记录的读写。`save(record)` 写 `~/.claude-webui/gateway/<id>.json`；记录结构见 §6。
- **`store.ts`** — `list()`（按时间倒序，可选关键字过滤 model/provider）、`get(id)`。读目录。
- **`routes.ts`** — `POST /v1/messages` 处理器（见 §5）。
- **`auth.ts`** — 可选 gateway key 校验（读 header `x-api-key` 或 `authorization: Bearer`）。
- **`parseSse.ts`** — 把流式响应的累积 SSE 文本解析成 `{ content, stop_reason, usage }`（供记录；透传不受影响）。

### 4.2 集成点（`src/server/index.ts`）

- 在 server 路由加 `/v1/messages`（独立于 `/api/*`）→ `gateway.handleMessages`。
- 启动无需额外初始化（按请求即时读 provider 配置）。
- 配置：`AppConfig` 加可选 `gatewayKey?: string`（GET `/api/config` 的 public 版可回传 `hasGatewayKey` 布尔，不回 key）。

### 4.3 前端

- `web/src/views/GatewayLog.vue`（路由 `/gateway` 或 MainApp tab）+ `web/src/api.ts` 加 gateway list/get。
- MainApp 顶栏加「中转」入口。

## 5. 数据流（`POST /v1/messages`）

```
客户端 POST /v1/messages  (body: Anthropic {model, messages, system, tools, max_tokens, stream, ...})
  → auth: 若 config.gatewayKey 非空,校验 x-api-key/Authorization;不符→401
  → resolveProviderByModel(body.model): providers 里 model 字段匹配;无匹配→活动 provider
  → 上游请求:
      fetch(provider.baseURL + '/v1/messages', {
        method:'POST',
        headers: { content-type, 'anthropic-version':<透传客户端的或默认>, 'x-api-key': provider.apiKey / Authorization: provider.authToken },
        body: JSON.stringify(body),          // 原样
        duplex:'half',                       // 流式响应
      })
  → 响应透传 + 累积:
      - 状态码/headers 透传给客户端
      - upstream.body (web stream) → 边 pipe 到 res,边 tee 累积到 buffer
  → 结束后:
      - stream=true: parseSse(buffer) → {content, stop_reason, usage}
      - stream=false: buffer 即 JSON final message
      - recorder.save({ id, createdAt, providerId, model, request:body, response, elapsedMs, status, error? })
```

**错误**：上游非 2xx → 透传状态码 + body 给客户端；记录 status:'error' + error。上游网络错 → 502 + 记录。

## 6. 记录结构与持久化

```jsonc
{
  "id": "<uuid>",
  "createdAt": 1234567890,
  "providerId": "p1",
  "model": "claude-sonnet-5",
  "stream": true,
  "request": { "model": "...", "system": "...", "messages": [...], "tools": [...], "max_tokens": 4096 },
  "response": { "content": [...], "stop_reason": "end_turn", "usage": { "input_tokens": 12, "output_tokens": 34 } },
  "elapsedMs": 1234,
  "status": "ok"            // 'ok' | 'error'
  // "error": "..."         // status=error 时
}
```

- 存 `~/.claude-webui/gateway/<id>.json`。
- `request` 存原始 body（可能含敏感内容；与 session jsonl 同级，仅本地）。
- 超大响应（如长流式）`response.content` 文本截断 ~64KB 存储提示，原始不截（详情可显示截断标记）。

## 7. 认证

- config `gatewayKey?: string`。留空 → 不校验（本地零配置）。
- 非空 → 客户端须带 `x-api-key: <key>` 或 `Authorization: Bearer <key>`，否则 401。
- 上游始终用 provider 自己的 apiKey/authToken（替换客户端的 key），不泄露后端 key 给客户端。
- `GET /api/config` public 版回 `hasGatewayKey` 布尔；前端设置里可设/改 gatewayKey（secret 不回传，留空保留旧值，同 provider 逻辑）。

## 8. 前端「中转日志」

- 列表：时间 / model / provider / 耗时 / input·output token / status，按 createdAt 倒序；关键字过滤（model/provider/状态）。
- 详情抽屉：
  - 元信息（provider/model/耗时/usage/status）。
  - **请求**：model / system / messages（每条 role + content，markdown 渲染）/ tools / max_tokens。仿 session 时间线风格。
  - **响应**：content blocks（text markdown / tool_use 折叠 / thinking 折叠）/ stop_reason / usage。
- 复用 `web/src/lib/render.ts` 的 `renderContent` 渲染 content blocks。

## 9. 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/messages` | 中转入口（Anthropic 兼容，透传） |
| GET | `/api/gateway/logs?q=&status=` | 记录列表（前端） |
| GET | `/api/gateway/logs/:id` | 单条记录详情 |
| DELETE | `/api/gateway/logs/:id` | 删除一条 |
| GET | `/api/config` | 扩展：含 `hasGatewayKey` |
| PUT | `/api/config` | 扩展：可存 `gatewayKey`（留空保留旧值） |

## 10. 错误处理

- 上游 4xx/5xx：状态码 + body 透传客户端；记录 status:'error'。
- 上游网络失败/超时：502 + 记录 error。
- 未配置任何 provider / model 解析失败：503 + 记录 error。
- gateway key 校验失败：401（不记录，或记录一条 status:'error' error:'auth'）。
- 流式中客户端断开：停止上游读取（abort），记录已累积部分，status:'ok'（客户端主动断开不算错误）。

## 11. 测试策略

- `parseSse`：样本 Anthropic SSE（message_start/content_block_*/message_delta/message_stop）→ {content,stop_reason,usage}。
- `store`/`recorder`：list/get/save/remove（用 `CLAUDE_WEBUI_DIR` 临时目录，仿 feishuConfig 测试）。
- `routes`（mock fetch）：透传 body 不改、状态码/headers 透传、model 路由（匹配/无匹配）、流式 pipe + 记录、非流式记录、上游错误记录、auth 校验。
- 沿用现有纯函数 + mock 模式；`npm test` / `typecheck` 通过。

## 12. 风险与待办

- **保真**：fetch 字节透传应保真；但需确认 Node 18+ fetch 对 SSE 流式响应 pipe 稳定（duplex:'half'）。若不稳，退回 SDK 重序列化（牺牲未知字段保真）。
- **headers 透传**：`anthropic-version` 等需透传或设默认；仅 `x-api-key`/`Authorization` 替换为 provider 凭证，其余透传客户端的。
- **claude-webui 自己的 Chat**：P1 中转独立于现有 `/api/chat`（后者走 AnthropicProvider agent 循环）。两者并存。
- **记录体量**：长流式响应可能大；超长截断（见 §6）。
- **P2/P3 衔接**：P1 的 `routes` 只处理 Anthropic；P2 加 `/v1/chat/completions` + OpenAI provider + 转换层时，gateway 内会引入 `convert.ts`，P1 的 fetch 透传继续作为"同格式"快路径。

## 13. 默认假设（可调）

- 持久化用文件（非 SQLite）。
- 认证可选（本地默认关）。
- model 路由：精确匹配 provider.model；无匹配用活动 provider。
- 记录默认开启（每次中转都记）；暂不做"记录开关"。
- 前端入口：MainApp 顶栏加「中转」tab。
