import { describe, it, expect } from 'vitest';
import { createAccumulator, toCard, Throttle } from '../../src/feishu/formatter.js';
import type { ClaudeRunEvent } from '../../src/claude/Runner.js';

function feed(events: ClaudeRunEvent[]) {
  const acc = createAccumulator();
  for (const e of events) acc.accumulate(e);
  return acc;
}

describe('formatter toCard', () => {
  it('assistant 正文 + tool_use + tool_result 都进卡片', () => {
    const acc = feed([
      { type: 'stream-json', data: { type: 'assistant', message: { uuid: 'u1', content: [{ type: 'text', text: 'Hello world' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/a' } }] } } },
      { type: 'stream-json', data: { type: 'user', message: { uuid: 'u2', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents here' }] } } },
      { type: 'exit', code: 0 },
    ]);
    const card = toCard(acc, { title: 'T', status: 'done', cwd: '/p', elapsedMs: 1500 });
    const s = JSON.stringify(card);
    expect(s).toContain('Hello world');
    expect(s).toContain('read_file');
    expect(s).toContain('file contents here');
    expect(s).toContain('✅ 完成');
    expect(s).toContain('1.5s');
    expect((card.header as { template?: string }).template).toBe('green');
  });

  it('同 uuid 的 assistant content 取最新', () => {
    const acc = feed([
      { type: 'stream-json', data: { type: 'assistant', message: { uuid: 'u1', content: [{ type: 'text', text: 'Hi' }] } } },
      { type: 'stream-json', data: { type: 'assistant', message: { uuid: 'u1', content: [{ type: 'text', text: 'Hi there' }] } } },
    ]);
    expect(JSON.stringify(toCard(acc, { title: 'T', status: 'running', cwd: '/p' }))).toContain('Hi there');
  });

  it('system 忽略；无正文时 result 作正文', () => {
    const acc = feed([
      { type: 'stream-json', data: { type: 'system', subtype: 'init' } },
      { type: 'stream-json', data: { type: 'result', result: 'final answer' } },
    ]);
    expect(JSON.stringify(toCard(acc, { title: 'T', status: 'done', cwd: '/p' }))).toContain('final answer');
  });

  it('超长正文截断 + 省略提示', () => {
    const long = 'x'.repeat(30000);
    const acc = feed([{ type: 'stream-json', data: { type: 'assistant', message: { uuid: 'u1', content: [{ type: 'text', text: long }] } } }]);
    const card = toCard(acc, { title: 'T', status: 'done', cwd: '/p' });
    const mdEl = (card.elements as Array<{ tag?: string; content?: string }>).find((e) => e.tag === 'markdown');
    expect(mdEl!.content!.length).toBeLessThan(30000);
    expect(mdEl!.content).toContain('省略');
  });

  it('error 状态红色 + exit code', () => {
    const acc = feed([{ type: 'exit', code: 2 }]);
    const card = toCard(acc, { title: 'T', status: 'error', cwd: '/p' });
    expect((card.header as { template?: string }).template).toBe('red');
    expect(JSON.stringify(card)).toContain('exit 2');
  });

  it('stderr 进卡片', () => {
    const acc = feed([{ type: 'stderr', text: 'some warning' }]);
    expect(JSON.stringify(toCard(acc, { title: 'T', status: 'running', cwd: '/p' }))).toContain('some warning');
  });

  it('running + thinking_tokens 计数显示思考指示；产出正文后/完成态不显示', () => {
    const acc = feed([
      { type: 'stream-json', data: { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 42 } },
    ]);
    const running = JSON.stringify(toCard(acc, { title: 'T', status: 'running', cwd: '/p' }));
    expect(running).toContain('思考中');
    expect(running).toContain('42');

    // 产出正文后让位
    const acc2 = feed([
      { type: 'stream-json', data: { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 42 } },
      { type: 'stream-json', data: { type: 'assistant', message: { uuid: 'u1', content: [{ type: 'text', text: 'answer' }] } } },
    ]);
    const withBody = JSON.stringify(toCard(acc2, { title: 'T', status: 'running', cwd: '/p' }));
    expect(withBody).toContain('answer');
    expect(withBody).not.toContain('思考中');

    // done 态不显示
    expect(JSON.stringify(toCard(acc, { title: 'T', status: 'done', cwd: '/p' }))).not.toContain('思考中');
  });
});

describe('Throttle', () => {
  it('按最小间隔判定', () => {
    const t = new Throttle(1000);
    expect(t.shouldRun(0)).toBe(true);
    t.mark(0);
    expect(t.shouldRun(500)).toBe(false);
    expect(t.shouldRun(1000)).toBe(true);
    t.mark(1000);
    expect(t.shouldRun(1500)).toBe(false);
    expect(t.shouldRun(2000)).toBe(true);
  });
});
