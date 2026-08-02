import { describe, it, expect } from 'vitest';
import { parseAnthropicSse } from '../../src/gateway/parseSse.js';

const TEXT_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

describe('parseAnthropicSse', () => {
  it('解析文本流：拼接 text、stop_reason、usage、model', () => {
    const r = parseAnthropicSse(TEXT_SSE);
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.stop_reason).toBe('end_turn');
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe('text');
    expect(r.content[0].text).toBe('Hello world');
  });

  it('解析 tool_use：input_json_delta 拼接成对象', () => {
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"foo","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
    ].join('\n');
    const r = parseAnthropicSse(sse);
    expect(r.content[0].type).toBe('tool_use');
    expect(r.content[0].input).toEqual({ a: 1 });
    expect(r.stop_reason).toBe('tool_use');
  });

  it('空串/无效 → 空 content', () => {
    expect(parseAnthropicSse('').content).toEqual([]);
    expect(parseAnthropicSse('not sse').content).toEqual([]);
  });
});
