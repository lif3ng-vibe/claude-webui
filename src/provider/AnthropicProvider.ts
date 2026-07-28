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
 * 流式产出：text / thinking / tool_use / done / error。
 * 纯对话不传 tools；工具查证（read-only 磁盘工具）放下一步实现 agent 循环。
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
    try {
      const stream = this.client.messages.stream({
        model: req.model || this.cfg.defaultModel,
        max_tokens: this.cfg.maxTokens ?? 4096,
        ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        messages: req.messages.filter((m) => m.role !== 'system'),
        ...(req.tools?.length
          ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
          : {}),
      } as Anthropic.MessageCreateParamsStreaming);

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
      await stream.finalMessage();
      yield { type: 'done' };
    } catch (e) {
      yield { type: 'error', error: String((e as { message?: unknown })?.message ?? e) };
    }
  }
}