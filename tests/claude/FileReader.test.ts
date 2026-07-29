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
});