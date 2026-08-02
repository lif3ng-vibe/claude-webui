/**
 * 流式转换（OpenAI ⇄ Anthropic SSE），事件级状态机。
 * feed() 接收上游事件，返回目标格式的 SSE 文本片段数组（已含 \n\n）。
 * 覆盖常见：text 增量、tool_use/tool_calls、finish。不保证字节级等价，目标是兼容主流客户端。
 */

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

/** Anthropic 流式事件 → OpenAI chat.completion.chunk 文本。 */
export class AnthropicToOpenAIStream {
  private id = 'chatcmpl-' + Math.random().toString(36).slice(2, 10);
  private model = '';
  private sentRole = false;
  private toolIdx = -1;

  feed(type: string, data: Record<string, unknown>): string[] {
    const out: string[] = [];
    const chunk = (obj: Record<string, unknown>): void => {
      out.push(`data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', model: this.model, ...obj })}\n\n`);
    };
    const ensureRole = (): void => {
      if (!this.sentRole) {
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        this.sentRole = true;
      }
    };

    if (type === 'message_start') {
      this.model = String((data.message as Record<string, unknown> | undefined)?.model ?? '');
    } else if (type === 'content_block_start') {
      const cb = (data.content_block as Record<string, unknown> | undefined) ?? {};
      if (cb.type === 'tool_use') {
        this.toolIdx++;
        ensureRole();
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: this.toolIdx, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }] }, finish_reason: null }] });
      } else {
        ensureRole();
      }
    } else if (type === 'content_block_delta') {
      const d = (data.delta as Record<string, unknown> | undefined) ?? {};
      if (d.type === 'text_delta') {
        ensureRole();
        chunk({ choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] });
      } else if (d.type === 'input_json_delta') {
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: this.toolIdx, function: { arguments: d.partial_json } }] }, finish_reason: null }] });
      }
    } else if (type === 'message_delta') {
      const delta = (data.delta as Record<string, unknown> | undefined) ?? {};
      if (delta.stop_reason) {
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: stopToFinish(delta.stop_reason) }] });
      }
    } else if (type === 'message_stop') {
      out.push('data: [DONE]\n\n');
    }
    return out;
  }
}

/** OpenAI chat.completion.chunk → Anthropic 流式事件文本。 */
export class OpenAIToAnthropicStream {
  private model = '';
  private started = false;
  private blockIdx = 0;
  private textOpen = false;
  private toolBlock: Record<number, number> = {}; // OpenAI tool index → Anthropic block index

  feed(data: Record<string, unknown>): string[] {
    const out: string[] = [];
    const evt = (t: string, d: Record<string, unknown>): void => {
      out.push(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    };

    if (!this.started) {
      this.model = String(data.model ?? '');
      evt('message_start', {
        type: 'message_start',
        message: { id: 'msg_x', type: 'message', role: 'assistant', model: this.model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
      });
      this.started = true;
    }
    const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : [];
    const ch = choices[0] ?? {};
    const delta = (ch.delta as Record<string, unknown> | undefined) ?? {};

    if (typeof delta.content === 'string' && delta.content) {
      if (!this.textOpen) {
        evt('content_block_start', { type: 'content_block_start', index: this.blockIdx, content_block: { type: 'text', text: '' } });
        this.textOpen = true;
      }
      evt('content_block_delta', { type: 'content_block_delta', index: this.blockIdx, delta: { type: 'text_delta', text: delta.content } });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
        const idx = Number(tc.index) || 0;
        const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
        if (this.toolBlock[idx] === undefined) {
          if (this.textOpen) {
            evt('content_block_stop', { type: 'content_block_stop', index: this.blockIdx });
            this.blockIdx++;
            this.textOpen = false;
          }
          this.toolBlock[idx] = this.blockIdx;
          evt('content_block_start', { type: 'content_block_start', index: this.blockIdx, content_block: { type: 'tool_use', id: tc.id ?? '', name: fn.name ?? '', input: {} } });
          this.blockIdx++;
        } else if (typeof fn.arguments === 'string') {
          evt('content_block_delta', { type: 'content_block_delta', index: this.toolBlock[idx], delta: { type: 'input_json_delta', partial_json: fn.arguments } });
        }
      }
    }

    if (ch.finish_reason) {
      if (this.textOpen) {
        evt('content_block_stop', { type: 'content_block_stop', index: this.blockIdx });
        this.textOpen = false;
      }
      evt('message_delta', { type: 'message_delta', delta: { stop_reason: finishToStop(ch.finish_reason) }, usage: { output_tokens: 0 } });
      evt('message_stop', { type: 'message_stop' });
    }
    return out;
  }
}
