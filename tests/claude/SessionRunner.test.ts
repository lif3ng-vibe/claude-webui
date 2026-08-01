import { describe, it, expect } from 'vitest';
import { SessionRunner } from '../../src/claude/SessionRunner.js';
import type { ClaudeRunEvent, ClaudeRunRequest } from '../../src/claude/Runner.js';

function fakeRunner(events: ClaudeRunEvent[]) {
  return {
    async *run(_req: ClaudeRunRequest): AsyncGenerator<ClaudeRunEvent> {
      for (const e of events) yield e;
    },
  };
}

const req = (over: Partial<ClaudeRunRequest> = {}): ClaudeRunRequest => ({
  sessionId: 's1',
  cwd: '/p',
  prompt: 'x',
  ...over,
});

describe('SessionRunner', () => {
  it('锁占用时返回 busy 且不跑 runner', async () => {
    const lock = new Set<string>(['s1']);
    let ran = false;
    const runner = {
      async *run() {
        ran = true;
        yield { type: 'exit', code: 0 } as ClaudeRunEvent;
      },
    };
    const sr = new SessionRunner(runner, lock);
    const r = await sr.runLocked(req(), { source: 'web' });
    expect(r.busy).toBe(true);
    expect(r.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it('透传事件 + onDone.ok=true（exit 0）', async () => {
    const events: ClaudeRunEvent[] = [
      { type: 'stream-json', data: { type: 'assistant' } },
      { type: 'exit', code: 0 },
    ];
    const sr = new SessionRunner(fakeRunner(events), new Set());
    const seen: ClaudeRunEvent[] = [];
    let done: { ok: boolean } | undefined;
    const r = await sr.runLocked(req(), {
      source: 'feishu',
      onEvent: (e) => seen.push(e),
      onDone: (i) => (done = i),
    });
    expect(seen.map((e) => e.type)).toEqual(['stream-json', 'exit']);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(done!.ok).toBe(true);
  });

  it('exit 非零 → ok=false', async () => {
    const sr = new SessionRunner(fakeRunner([{ type: 'exit', code: 2 }]), new Set());
    const r = await sr.runLocked(req(), { source: 'web' });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
  });

  it('runner 抛异常 → ok=false 且释放锁', async () => {
    const lock = new Set<string>();
    const runner = { async *run() { throw new Error('boom'); } };
    const sr = new SessionRunner(runner, lock);
    const r = await sr.runLocked(req(), { source: 'web' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boom');
    expect(lock.has('s1')).toBe(false);
  });

  it('结束后释放锁，可再次获取', async () => {
    const lock = new Set<string>();
    const sr = new SessionRunner(fakeRunner([{ type: 'exit', code: 0 }]), lock);
    await sr.runLocked(req(), { source: 'web' });
    expect(lock.has('s1')).toBe(false);
    const r2 = await sr.runLocked(req({ prompt: 'y' }), { source: 'web' });
    expect(r2.busy).toBeUndefined();
  });

  it('onFinished 全局钩子触发（含 busy 情形）', async () => {
    const lock = new Set<string>(['s1']);
    const sr = new SessionRunner(fakeRunner([{ type: 'exit', code: 0 }]), lock);
    const calls: Array<{ info: { busy?: boolean; ok?: boolean }; src: string }> = [];
    sr.onFinished = (info, src) => calls.push({ info, src });
    await sr.runLocked(req(), { source: 'web' });
    expect(calls).toHaveLength(1);
    expect(calls[0].info.busy).toBe(true);
    expect(calls[0].src).toBe('web');
  });

  it('signal 已 abort → result.aborted=true', async () => {
    const ac = new AbortController();
    ac.abort();
    const runner = { async *run() { yield { type: 'exit', code: null } as ClaudeRunEvent; } };
    const sr = new SessionRunner(runner, new Set());
    const r = await sr.runLocked(req({ signal: ac.signal }), { source: 'web' });
    expect(r.aborted).toBe(true);
  });
});
