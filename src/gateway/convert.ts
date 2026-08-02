/**
 * OpenAI ⇄ Anthropic 格式转换（请求/响应；流式见 streamConvert.ts）。
 * 覆盖：system、text、tool_use/tool_calls、tool_result/tool 消息、tools、usage、stop_reason。
 * 不覆盖：image/content 多模态（v1 跳过，仅文本）、thinking（OpenAI 无对应，丢弃）。
 */

// —— OpenAI 类型 ——
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface OpenAIMessage {
  role: string;
  content?: unknown;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface OpenAIReq {
  model: string;
  messages: OpenAIMessage[];
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  [k: string]: unknown;
}

function contentToText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === 'object' && p && typeof (p as Record<string, unknown>).text === 'string') return (p as Record<string, string>).text;
        return String(p ?? '');
      })
      .join('');
  }
  return String(c ?? '');
}

// —— 请求转换 ——
/** OpenAI 请求 → Anthropic 请求。 */
export function openaiReqToAnthropic(req: OpenAIReq): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: unknown[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: contentToText(m.content) }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks: unknown[] = [];
      const t = contentToText(m.content);
      if (t) blocks.push({ type: 'text', text: t });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* 保留空 */
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: contentToText(m.content) });
  }
  const out: Record<string, unknown> = { model: req.model, max_tokens: req.max_tokens ?? 4096, messages };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? {} }));
  }
  if (req.stream) out.stream = true;
  return out;
}

/** Anthropic 请求 → OpenAI 请求。 */
export function anthropicReqToOpenai(req: Record<string, unknown>): OpenAIReq {
  const out: OpenAIMessage[] = [];
  if (typeof req.system === 'string' && req.system) out.push({ role: 'system', content: req.system });
  const msgs = Array.isArray(req.messages) ? (req.messages as Array<Record<string, unknown>>) : [];
  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content;
    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (Array.isArray(content)) {
      const texts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      const toolResults: OpenAIMessage[] = [];
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text') texts.push(String(b.text ?? ''));
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: String(b.id ?? ''), type: 'function', function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) } });
        } else if (b.type === 'tool_result') {
          const c = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<Record<string, unknown>>).map((x) => String(x.text ?? '')).join('') : JSON.stringify(b.content ?? '');
          toolResults.push({ role: 'tool', tool_call_id: String(b.tool_use_id ?? ''), content: c });
        }
      }
      if (role === 'assistant') {
        const msg: OpenAIMessage = { role: 'assistant', content: texts.join('') };
        if (toolCalls.length) msg.tool_calls = toolCalls;
        out.push(msg);
      } else {
        if (texts.join('')) out.push({ role: 'user', content: texts.join('') });
        out.push(...toolResults);
      }
      continue;
    }
    out.push({ role, content: String(content ?? '') });
  }
  const oai: OpenAIReq = { model: String(req.model ?? ''), messages: out };
  if (typeof req.max_tokens === 'number') oai.max_tokens = req.max_tokens;
  if (Array.isArray(req.tools)) {
    oai.tools = (req.tools as Array<Record<string, unknown>>).map((t) => ({
      type: 'function' as const,
      function: { name: String(t.name ?? ''), description: t.description as string | undefined, parameters: t.input_schema ?? {} },
    }));
  }
  if (req.stream) oai.stream = true;
  return oai;
}

function stopToFinish(sr: unknown): string {
  if (sr === 'tool_use') return 'tool_calls';
  if (sr === 'max_tokens') return 'length';
  return 'stop';
}
function finishToStop(finish: unknown): string {
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  return 'end_turn';
}

// —— 响应转换（非流式）——
/** Anthropic 响应 → OpenAI chat.completion。 */
export function anthropicRespToOpenai(resp: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(resp.content) ? (resp.content as Array<Record<string, unknown>>) : [];
  const texts: string[] = [];
  const toolCalls: unknown[] = [];
  for (const b of content) {
    if (b.type === 'text') texts.push(String(b.text ?? ''));
    else if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id ?? '', type: 'function', function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) } });
    }
  }
  const message: Record<string, unknown> = { role: 'assistant', content: texts.join('') };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = resp.usage as Record<string, unknown> | undefined;
  const pt = Number(usage?.input_tokens) || 0;
  const ct = Number(usage?.output_tokens) || 0;
  return {
    id: resp.id ?? 'chatcmpl-x',
    object: 'chat.completion',
    model: resp.model ?? '',
    choices: [{ index: 0, message, finish_reason: stopToFinish(resp.stop_reason) }],
    usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
  };
}

/** OpenAI 响应 → Anthropic message。 */
export function openaiRespToAnthropic(resp: Record<string, unknown>): Record<string, unknown> {
  const choice = (resp.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const msg = (choice?.message as Record<string, unknown>) ?? {};
  const blocks: unknown[] = [];
  if (typeof msg.content === 'string' && msg.content) blocks.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
      let input: unknown = {};
      try {
        input = JSON.parse(String((tc.function as Record<string, unknown> | undefined)?.arguments ?? '{}'));
      } catch {
        /* 保留空 */
      }
      blocks.push({ type: 'tool_use', id: tc.id ?? '', name: (tc.function as Record<string, unknown> | undefined)?.name ?? '', input });
    }
  }
  const usage = resp.usage as Record<string, unknown> | undefined;
  return {
    id: resp.id ?? 'msg_x',
    type: 'message',
    role: 'assistant',
    model: resp.model ?? '',
    content: blocks.length ? blocks : [{ type: 'text', text: '' }],
    stop_reason: finishToStop(choice?.finish_reason),
    usage: { input_tokens: Number(usage?.prompt_tokens) || 0, output_tokens: Number(usage?.completion_tokens) || 0 },
  };
}
