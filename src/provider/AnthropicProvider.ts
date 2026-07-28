import type { Provider, ProviderRequest, ProviderStreamDelta } from './Provider.js';

/**
 * v1 的 Anthropic adapter，实现 `Provider` 接口。流式 + 工具调用实现待补；
 * 接口已锁定，应用其余部分（对话面、session 步骤深问）可据此契约构建。
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anth';

  async *stream(_req: ProviderRequest): AsyncGenerator<ProviderStreamDelta> {
    throw new Error('AnthropicProvider.stream: 未实现（v1 骨架）');
  }
}