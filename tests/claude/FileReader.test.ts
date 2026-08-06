import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { ClaudeFileReader } from '../../src/claude/FileReader.js';

describe('ClaudeFileReader', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(os.tmpdir(), 'cwu-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('lists a project, reads cwd from its session jsonl, and parses messages', async () => {
    const cwd = 'C:\\Users\\lif3n\\src\\demo-project';
    const dirName = 'C--Users-lif3n-src-demo-project';
    const sessionId = 'abc-123';

    const projectsDir = join(tmp, 'projects', dirName);
    await mkdir(projectsDir, { recursive: true });
    const line = JSON.stringify({
      type: 'user',
      cwd,
      message: { role: 'user', content: 'hello' },
      timestamp: '2026-07-28T06:05:46.857Z',
      sessionId,
    });
    await writeFile(join(projectsDir, `${sessionId}.jsonl`), line + '\n');

    const reader = new ClaudeFileReader(tmp);

    const projects = await reader.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].dirName).toBe(dirName);
    expect(projects[0].cwd).toBe(cwd); // authoritative cwd from jsonl, not decoded
    expect(projects[0].sessionCount).toBe(1);
    expect(projects[0].latestMtimeMs).toBeGreaterThan(0);

    const sessions = await reader.listSessions(dirName);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(sessionId);
    expect(sessions[0].preview).toBe('hello'); // 首条人类 prompt 的预览

    const msgs = await reader.readSessionMessages(dirName, sessionId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message?.role).toBe('user');
    expect(msgs[0].cwd).toBe(cwd);
  });

  it('returns empty lists when ~/.claude/projects is absent', async () => {
    const reader = new ClaudeFileReader(tmp);
    expect(await reader.listProjects()).toEqual([]);
    expect(await reader.listSessions('does-not-exist')).toEqual([]);
  });

  describe('readLatestTitle', () => {
    it('returns the last ai-title line of a session', async () => {
      const dirName = 'C--Users-lif3n-src-demo';
      const sessionId = 's-title';
      const projectsDir = join(tmp, 'projects', dirName);
      await mkdir(projectsDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId }),
        JSON.stringify({ type: 'ai-title', aiTitle: '任务A', sessionId }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant' }, sessionId }),
        JSON.stringify({ type: 'ai-title', aiTitle: '任务B-最新', sessionId }),
      ];
      await writeFile(join(projectsDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

      const reader = new ClaudeFileReader(tmp);
      expect(await reader.readLatestTitle(dirName, sessionId)).toBe('任务B-最新');
    });

    it('returns empty string when there is no ai-title line', async () => {
      const dirName = 'C--Users-lif3n-src-demo';
      const sessionId = 's-notitle';
      const projectsDir = join(tmp, 'projects', dirName);
      await mkdir(projectsDir, { recursive: true });
      await writeFile(
        join(projectsDir, `${sessionId}.jsonl`),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId }) + '\n',
      );
      const reader = new ClaudeFileReader(tmp);
      expect(await reader.readLatestTitle(dirName, sessionId)).toBe('');
    });

    it('returns empty string for a missing session file', async () => {
      const reader = new ClaudeFileReader(tmp);
      expect(await reader.readLatestTitle('nope', 'nope')).toBe('');
    });

    it('listSessions carries the latest title', async () => {
      const dirName = 'C--Users-lif3n-src-demo';
      const sessionId = 's-list';
      const projectsDir = join(tmp, 'projects', dirName);
      await mkdir(projectsDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'do thing' }, sessionId }),
        JSON.stringify({ type: 'ai-title', aiTitle: '做事情', sessionId }),
      ];
      await writeFile(join(projectsDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
      const reader = new ClaudeFileReader(tmp);
      const sessions = await reader.listSessions(dirName);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].title).toBe('做事情');
      expect(sessions[0].preview).toBe('do thing');
    });
  });
});