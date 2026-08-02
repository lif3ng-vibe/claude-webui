/** Anthropic 流式响应解析结果（供中转记录；透传不受影响）。 */
export interface ParsedResponse {
  content: Array<Record<string, unknown>>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 把 Anthropic 流式响应的累积 SSE 文本解析成结构化结果。
 * 处理 message_start / content_block_start / content_block_delta(text/thinking/input_json)
 * / message_delta(stop_reason, usage)。文本增量拼接，tool_use 的 input 从 input_json_delta 拼接后 JSON.parse。
 */
export function parseAnthropicSse(sseText: string): ParsedResponse {
  const out: ParsedResponse = { content: [] };
  const blocks = new Map<number, Record<string, unknown>>();

  const events = sseText
    .split(/\n\n/)
    .map((chunk) => {
      let type = '';
      let dataStr = '';
      for (const ln of chunk.split(/\n/)) {
        if (ln.startsWith('event:')) type = ln.slice(6).trim();
        else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
      }
      return type && dataStr ? { type, data: safeParse(dataStr) } : null;
    })
    .filter(Boolean) as Array<{ type: string; data: Record<string, unknown> }>;

  for (const { type, data } of events) {
    if (type === 'message_start') {
      const msg = data.message as Record<string, unknown> | undefined;
      if (msg) {
        out.model = msg.model as string | undefined;
        out.usage = msg.usage as ParsedResponse['usage'];
      }
    } else if (type === 'content_block_start') {
      const idx = data.index as number | undefined;
      if (idx != null) blocks.set(idx, { ...((data.content_block as Record<string, unknown>) ?? {}) });
    } else if (type === 'content_block_delta') {
      const idx = data.index as number | undefined;
      const b = idx != null ? blocks.get(idx) : undefined;
      const d = (data.delta as Record<string, unknown>) ?? {};
      if (b) {
        if (d.type === 'text_delta' && typeof d.text === 'string') b.text = (b.text as string | undefined ?? '') + d.text;
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') b.thinking = (b.thinking as string | undefined ?? '') + d.thinking;
        else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') b._json = (b._json as string | undefined ?? '') + d.partial_json;
      }
    } else if (type === 'message_delta') {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (delta?.stop_reason) out.stop_reason = delta.stop_reason as string;
      if (data.usage) out.usage = { ...out.usage, ...(data.usage as ParsedResponse['usage']) };
    }
  }

  out.content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => {
      if (b.type === 'tool_use' && b._json != null) {
        try {
          b.input = JSON.parse(b._json as string);
        } catch {
          /* 保留原始拼接串 */
        }
        delete b._json;
      }
      return b;
    });

  return out;
}
