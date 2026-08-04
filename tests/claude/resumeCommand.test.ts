import { describe, it, expect } from 'vitest';
import { buildResumeCommand } from '../../src/claude/resumeCommand.js';

describe('buildResumeCommand', () => {
  it('无 env 返回裸命令', () => {
    expect(buildResumeCommand('/p', 's1')).toBe('cd "/p" && claude --resume s1');
  });
  it('有 env 用 --settings JSON（盖过 ~/.claude/settings.json）', () => {
    const cmd = buildResumeCommand('/p', 's1', { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'm' });
    expect(cmd).toBe(`cd "/p" && claude --settings '{"env":{"ANTHROPIC_BASE_URL":"http://x","ANTHROPIC_AUTH_TOKEN":"tok","ANTHROPIC_MODEL":"m"}}' --resume s1`);
  });
  it('env 含 apiKey 也进 JSON（不再用 KEY=val 前缀）', () => {
    const cmd = buildResumeCommand('/p', 's1', { ANTHROPIC_API_KEY: 'key' });
    expect(cmd).toContain('"ANTHROPIC_API_KEY":"key"');
    expect(cmd).not.toContain('ANTHROPIC_API_KEY=');
    expect(cmd).toContain('--settings ');
  });
});
