/** provider 对话中的一条消息。 */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 模型可调用的工具（供"就 session 步骤提问"功能使用）。 */
export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 模型发起的工具调用。 */
export interface ProviderToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** provider 流的增量输出。 */
export type ProviderStreamDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolCall: ProviderToolCall }
  | { type: 'done' }
  | { type: 'error'; error: string };

/** 对 provider 的请求。 */
export interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  systemPrompt?: string;
  tools?: ProviderTool[];
  // signal?: AbortSignal; // v2：流式中途取消
}

/**
 * 统一的 provider 接口。v1 只有 Anthropic 一个 adapter；接口锁定，
 * 以便 v2 增加更多 adapter（OpenAI 兼容等）。
 *
 * 注（v2）：纯对话时，线路格式（OpenAI 兼容 vs Anthropic Messages）
 * 是 adapter 内部细节，在此不可见。工具调用时格式各异，这也是 v1 的
 * 工具查证只走 Anthropic 的原因。
 */
export interface Provider {
  readonly name: string;
  stream(req: ProviderRequest): AsyncIterable<ProviderStreamDelta>;
}