import Anthropic from '@anthropic-ai/sdk';
import type { Provider, ProviderRequest, ProviderStreamDelta } from './Provider.js';

export interface AnthropicProviderConfig {
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  defaultModel: string;
  maxTokens?: number;
}

/**
 * v1 Anthropic adapter，走 `@anthropic-ai/sdk`。兼容 Anthropic 官方 API 与
 * 任何 Anthropic 兼容代理（通过 baseURL + authToken/apiKey 指向）。
 *
 * 流式产出：text / thinking / tool_use / tool_result / done / error。
 * - 不传 tools（或无 executeTool）：单轮对话。
 * - 传 tools + executeTool：跑 agent 循环——模型调工具 → 执行 → 回填
 *   tool_result → 继续，直到模型不再调工具。最多 12 轮防失控。
 *
 * 回填 assistant 轮时省略 thinking 块（已验证代理接受，省 token）。
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anth';
  private readonly client: Anthropic;

  constructor(private readonly cfg: AnthropicProviderConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      authToken: cfg.authToken,
      baseURL: cfg.baseURL,
    });
  }

  async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamDelta> {
    if (!this.cfg.defaultModel && !req.model) {
      yield { type: 'error', error: '未配置 model（设置 ANTHROPIC_MODEL 或 config.model）' };
      return;
    }
    const model = req.model || this.cfg.defaultModel;
    const maxTokens = this.cfg.maxTokens ?? 4096;
    const tools = req.tools?.length
      ? req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
      : undefined;
    const runLoop = Boolean(tools && req.executeTool);
    const exec = req.executeTool;

    // 内部结构化消息（content 为 block 数组）
    let messages: unknown[] = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] }));

    const MAX_ITERS = 12;
    try {
      for (let iter = 0; iter < MAX_ITERS; iter++) {
        const params: Record<string, unknown> = {
          model,
          max_tokens: maxTokens,
          ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
          messages,
          ...(tools ? { tools } : {}),
        };
        // 暴露完整请求内容供前端查看（深拷贝当前快照，避免后续 mutation 影响）
        yield { type: 'request', request: JSON.parse(JSON.stringify(params)) };
        const stream = this.client.messages.stream(params as unknown as Anthropic.MessageCreateParamsStreaming);

        for await (const evt of stream) {
          if (evt.type === 'content_block_delta') {
            const d = evt.delta as { type?: string; text?: string; thinking?: string };
            if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
            else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'thinking', text: d.thinking };
          } else if (evt.type === 'content_block_start') {
            const b = (evt as { content_block?: { type?: string; id?: string; name?: string; input?: unknown } }).content_block;
            if (b?.type === 'tool_use') yield { type: 'tool_use', toolCall: { id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} } };
          }
        }

        const final = (await stream.finalMessage()) as { content?: Array<{ type: string; id?: string; name?: string; input?: unknown }> };
        const content = final.content ?? [];
        const toolUses = content.filter((b) => b.type === 'tool_use');

        if (!runLoop || toolUses.length === 0) {
          yield { type: 'done' };
          return;
        }

        // 下一轮：回填 assistant 轮（去 thinking）+ user 工具结果轮
        const assistantBlocks = content.filter((b) => b.type !== 'thinking');
        messages = [...messages, { role: 'assistant', content: assistantBlocks }];

        const results: unknown[] = [];
        for (const tu of toolUses) {
          let result = '';
          try {
            if (exec) result = await exec({ id: tu.id ?? '', name: tu.name ?? '', input: tu.input });
          } catch (e) {
            result = `ERROR: ${String((e as { message?: unknown })?.message ?? e)}`;
          }
          yield { type: 'tool_result', id: tu.id ?? '', name: tu.name ?? '', result };
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
        }
        messages = [...messages, { role: 'user', content: results }];
      }
      yield { type: 'done' }; // 达到最大轮数
    } catch (e) {
      yield { type: 'error', error: String((e as { message?: unknown })?.message ?? e) };
    }
  }
}