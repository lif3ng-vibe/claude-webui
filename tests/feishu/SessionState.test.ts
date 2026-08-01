import { describe, it, expect } from 'vitest';
import { SessionState } from '../../src/feishu/SessionState.js';

describe('SessionState', () => {
  it('初始 current 为 null', () => {
    expect(new SessionState().current()).toBeNull();
  });

  it('set / current', () => {
    const s = new SessionState();
    s.set({ sessionId: 'a', dirName: 'd', cwd: '/p' });
    expect(s.current()).toEqual({ sessionId: 'a', dirName: 'd', cwd: '/p' });
    s.set(null);
    expect(s.current()).toBeNull();
  });

  it('序号命中（从 1 开始）', () => {
    const s = new SessionState();
    s.setIndex([
      { sessionId: 'a', dirName: 'd', cwd: '/p' },
      { sessionId: 'b', dirName: 'd', cwd: '/q' },
    ]);
    expect(s.getByIndex(1)?.sessionId).toBe('a');
    expect(s.getByIndex(2)?.sessionId).toBe('b');
  });

  it('序号越界 / 未建索引返回 null', () => {
    const s = new SessionState();
    expect(s.getByIndex(1)).toBeNull();
    s.setIndex([{ sessionId: 'a', dirName: 'd', cwd: '/p' }]);
    expect(s.getByIndex(0)).toBeNull();
    expect(s.getByIndex(2)).toBeNull();
  });

  it('TTL 过期（>5min）后序号失效', () => {
    let t = 1000;
    const s = new SessionState(() => t);
    s.setIndex([{ sessionId: 'a', dirName: 'd', cwd: '/p' }]);
    expect(s.getByIndex(1)?.sessionId).toBe('a');
    t += 6 * 60 * 1000;
    expect(s.getByIndex(1)).toBeNull();
  });

  it('findByPrefix 在缓存中匹配', () => {
    const s = new SessionState();
    s.setIndex([{ sessionId: 'abc-123', dirName: 'd', cwd: '/p' }]);
    expect(s.findByPrefix('abc')?.sessionId).toBe('abc-123');
    expect(s.findByPrefix('xyz')).toBeNull();
    expect(s.findByPrefix('')).toBeNull();
  });
});
