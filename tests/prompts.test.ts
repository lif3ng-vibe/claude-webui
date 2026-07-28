import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { PromptsStore } from '../src/prompts.js';

describe('PromptsStore', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(os.tmpdir(), 'cwu-p-'));
    process.env.CLAUDE_WEBUI_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.CLAUDE_WEBUI_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('首次 list 落盘默认项并幂等', async () => {
    const s = new PromptsStore();
    const arr = await s.list();
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.some((p) => p.id === 'explain-step')).toBe(true);
    const arr2 = await s.list();
    expect(arr2).toEqual(arr);
  });

  it('upsert 新增并更新（同 id 覆盖，不重复）', async () => {
    const s = new PromptsStore();
    await s.upsert({ id: 'x', title: 'X', text: 't' });
    expect((await s.list()).some((p) => p.id === 'x')).toBe(true);
    await s.upsert({ id: 'x', title: 'X2', text: 't2' });
    const arr = await s.list();
    const x = arr.find((p) => p.id === 'x');
    expect(x?.title).toBe('X2');
    expect(arr.filter((p) => p.id === 'x')).toHaveLength(1);
  });

  it('remove 删除指定 id', async () => {
    const s = new PromptsStore();
    await s.upsert({ id: 'x', title: 'X', text: 't' });
    await s.remove('x');
    expect((await s.list()).some((p) => p.id === 'x')).toBe(false);
  });
});