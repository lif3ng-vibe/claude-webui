import { describe, it, expect } from 'vitest';
import { AnthropicToOpenAIStream, OpenAIToAnthropicStream } from '../../src/gateway/streamConvert.js';

describe('AnthropicToOpenAIStream', () => {
  it('text 增量 → OpenAI content chunk + finish + [DONE]', () => {
    const s = new AnthropicToOpenAIStream();
    const all = [
      ...s.feed('message_start', { message: { model: 'claude' } }),
      ...s.feed('content_block_start', { index: 0, content_block: { type: 'text' } }),
      ...s.feed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'He' } }),
      ...s.feed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'llo' } }),
      ...s.feed('message_delta', { delta: { stop_reason: 'end_turn' } }),
      ...s.feed('message_stop', {}),
    ].join('');
    expect(all).toContain('"object":"chat.completion.chunk"');
    expect(all).toContain('"content":"He"');
    expect(all).toContain('"content":"llo"');
    expect(all).toContain('"finish_reason":"stop"');
    expect(all).toContain('[DONE]');
  });

  it('tool_use → OpenAI tool_calls', () => {
    const s = new AnthropicToOpenAIStream();
    const all = [
      ...s.feed('message_start', { message: { model: 'm' } }),
      ...s.feed('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't1', name: 'foo' } }),
      ...s.feed('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }),
      ...s.feed('message_delta', { delta: { stop_reason: 'tool_use' } }),
      ...s.feed('message_stop', {}),
    ].join('');
    expect(all).toContain('"tool_calls"');
    expect(all).toContain('"name":"foo"');
    expect(all).toContain('"finish_reason":"tool_calls"');
  });
});

describe('OpenAIToAnthropicStream', () => {
  it('delta.content → content_block_delta text_delta + message_stop', () => {
    const s = new OpenAIToAnthropicStream();
    const all = [
      ...s.feed({ model: 'gpt', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
      ...s.feed({ model: 'gpt', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] }),
      ...s.feed({ model: 'gpt', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ].join('');
    expect(all).toContain('event: message_start');
    expect(all).toContain('event: content_block_delta');
    expect(all).toContain('"text_delta"');
    expect(all).toContain('"text":"Hi"');
    expect(all).toContain('event: message_delta');
    expect(all).toContain('"stop_reason":"end_turn"');
    expect(all).toContain('event: message_stop');
  });
});
