import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { assertSafeCwd } from '../../src/claude/cwdGuard.js';

let dir = '';
describe('assertSafeCwd', () => {
  beforeEach(async () => { dir = await mkdtemp(join(os.tmpdir(), 'cwu-cwd-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('合法目录不抛', async () => {
    await expect(assertSafeCwd(dir)).resolves.toBeUndefined();
  });
  it('相对路径拒绝', async () => {
    await expect(assertSafeCwd('relative/path')).rejects.toThrow('绝对路径');
  });
  it('不存在拒绝', async () => {
    await expect(assertSafeCwd(join(dir, 'nope'))).rejects.toThrow('不存在');
  });
  it('非目录拒绝', async () => {
    const f = join(dir, 'afile');
    await writeFile(f, 'x');
    await expect(assertSafeCwd(f)).rejects.toThrow('不是目录');
  });
  it('~/.claude 本身拒绝', async () => {
    await expect(assertSafeCwd(join(os.homedir(), '.claude'))).rejects.toThrow('状态目录');
  });
});
