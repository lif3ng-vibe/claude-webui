import { describe, it, expect } from 'vitest';
import { openaiReqToAnthropic, anthropicReqToOpenai, anthropicRespToOpenai, openaiRespToAnthropic, type OpenAIReq } from '../../src/gateway/convert.js';

describe('请求转换 openaiReqToAnthropic', () => {
  it('system 提取到 top-level，user/assistant 文本透传', () => {
    const r = openaiReqToAnthropic({
      model: 'm',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(r.system).toBe('be nice');
    expect(r.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(r.max_tokens).toBe(4096);
  });

  it('assistant tool_calls → tool_use block；tool 消息 → tool_result', () => {
    const r = openaiReqToAnthropic({
      model: 'm',
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'foo', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'result text' },
      ],
    });
    const msgs = r.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toMatchObject({ role: 'assistant' });
    expect((msgs[0].content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_use' && b.name === 'foo')).toBe(true);
    expect(msgs[1]).toMatchObject({ role: 'user' });
    expect((msgs[1].content as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
  });

  it('tools 转换：function → input_schema', () => {
    const r = openaiReqToAnthropic({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'foo', description: 'd', parameters: { type: 'object' } } }],
    });
    expect(r.tools).toEqual([{ name: 'foo', description: 'd', input_schema: { type: 'object' } }]);
  });
});

describe('请求转换 anthropicReqToOpenai', () => {
  it('system → system 消息；tool_use/tool_result 反向', () => {
    const oai = anthropicReqToOpenai({
      model: 'm',
      system: 'be nice',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'foo', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'res' }] },
      ],
    });
    expect(oai.messages[0]).toMatchObject({ role: 'system', content: 'be nice' });
    expect(oai.messages[1]).toMatchObject({ role: 'user', content: 'hi' });
    const asst = oai.messages[2];
    expect(asst.tool_calls?.[0]).toMatchObject({ id: 't1', type: 'function', function: { name: 'foo', arguments: '{"a":1}' } });
    expect(oai.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 't1', content: 'res' });
    expect(oai.max_tokens).toBe(100);
  });
});

describe('响应转换', () => {
  it('anthropicRespToOpenai：text + usage + finish_reason', () => {
    const r = anthropicRespToOpenai({
      id: 'msg_1',
      model: 'claude',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    expect(r.object).toBe('chat.completion');
    const choice = (r.choices as Array<Record<string, unknown>>)[0];
    expect((choice.message as Record<string, unknown>).content).toBe('hello');
    expect(choice.finish_reason).toBe('stop');
    expect(r.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  it('anthropicRespToOpenai：tool_use → tool_calls + finish_reason tool_calls', () => {
    const r = anthropicRespToOpenai({
      content: [{ type: 'tool_use', id: 't1', name: 'foo', input: { a: 1 } }],
      stop_reason: 'tool_use',
    });
    const msg = ((r.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>);
    expect(Array.isArray(msg.tool_calls)).toBe(true);
    expect(((r.choices as Array<Record<string, unknown>>)[0]).finish_reason).toBe('tool_calls');
  });

  it('openaiRespToAnthropic：反向', () => {
    const r = openaiRespToAnthropic({
      id: 'cc_1',
      model: 'gpt',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    });
    expect(r.type).toBe('message');
    expect((r.content as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'text', text: 'hi' });
    expect(r.stop_reason).toBe('end_turn');
    expect(r.usage).toEqual({ input_tokens: 2, output_tokens: 1 });
  });
});
