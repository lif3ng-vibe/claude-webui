import { describe, it, expect, vi, afterEach } from 'vitest';
import { runningPidsFor, isPidAlive } from '../../src/claude/runningSessions.js';

const mockReader = (rows: Array<{ sessionId: string; pid: number }>) =>
  ({
    getRunningSessions: async () => rows.map((r) => ({ sessionId: r.sessionId, pid: r.pid, cwd: '/p', status: 'idle' })),
  }) as never;

describe('runningSessions', () => {
  const spy = vi.spyOn(process, 'kill');
  afterEach(() => spy.mockReset());

  it('isPidAlive：signal 0 探活（抛错=死，返回=活）', () => {
    spy.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(isPidAlive(1)).toBe(false);
    spy.mockImplementation(() => true);
    expect(isPidAlive(2)).toBe(true);
  });

  it('runningPidsFor：过滤 sessionId + 探活（死 pid / 残留文件丢弃）', async () => {
    spy.mockImplementation((pid: number) => {
      if (pid === 999) throw new Error('ESRCH');
      return true;
    });
    const reader = mockReader([
      { sessionId: 'aaa', pid: 100 },
      { sessionId: 'aaa', pid: 999 },
      { sessionId: 'bbb', pid: 200 },
    ]);
    expect(await runningPidsFor(reader, 'aaa')).toEqual([100]);
    expect(await runningPidsFor(reader, 'bbb')).toEqual([200]);
    expect(await runningPidsFor(reader, 'zzz')).toEqual([]);
  });
});
