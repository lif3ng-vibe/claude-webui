import { describe, it, expect } from 'vitest';
import { buildResumeCommand } from '../../src/claude/resumeCommand.js';

describe('buildResumeCommand', () => {
  it('无 env 返回裸命令', () => {
    expect(buildResumeCommand('/p', 's1')).toBe('cd "/p" && claude --resume s1');
  });
  it('有 env 返回 bash 风格 env 前缀，authToken 优先于 apiKey', () => {
    const cmd = buildResumeCommand('/p', 's1', {
      ANTHROPIC_BASE_URL: 'http://x',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_MODEL: 'm',
    });
    expect(cmd).toBe("cd \"/p\" && ANTHROPIC_BASE_URL='http://x' ANTHROPIC_AUTH_TOKEN='tok' ANTHROPIC_MODEL='m' claude --resume s1");
  });
  it('无 authToken 时用 apiKey', () => {
    const cmd = buildResumeCommand('/p', 's1', { ANTHROPIC_API_KEY: 'key' });
    expect(cmd).toContain("ANTHROPIC_API_KEY='key'");
    expect(cmd).not.toContain('ANTHROPIC_AUTH_TOKEN');
  });
});
