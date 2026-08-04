import { describe, it, expect } from 'vitest';
import { spawnSpec } from '../../src/terminal/TerminalManager.js';

describe('spawnSpec', () => {
  it('resume 模式：带 --resume，锁键=sessionId', () => {
    const s = spawnSpec({ mode: 'resume', dirName: 'd', sessionId: 's1' });
    expect(s.args).toEqual(['--resume', 's1', '--dangerously-skip-permissions']);
    expect(s.lockKey).toBe('s1');
  });
  it('new 模式：不带 --resume，锁键="new:"+cwd', () => {
    const s = spawnSpec({ mode: 'new', cwd: '/p' });
    expect(s.args).toEqual(['--dangerously-skip-permissions']);
    expect(s.lockKey).toBe('new:/p');
  });
});
