import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { createFsToolExecutor, FS_TOOLS } from '../src/tools/fsTools.js';

describe('fsTools executor', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(os.tmpdir(), 'cwu-fs-'));
    await mkdir(join(root, 'sub')).catch(() => {});
    await writeFile(join(root, 'a.txt'), 'hello world\nfoo bar\n');
    await writeFile(join(root, 'sub', 'b.ts'), 'export const X = 1;\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('FS_TOOLS 含 read_file/list_files/grep', () => {
    expect(FS_TOOLS.map((t) => t.name).sort()).toEqual(['grep', 'list_files', 'read_file']);
  });

  it('read_file 读取作用域内文件', async () => {
    const ex = createFsToolExecutor([root]);
    const r = await ex({ id: '1', name: 'read_file', input: { path: 'a.txt' } });
    expect(r).toContain('hello world');
  });

  it('read_file 拒绝越界路径（../ 逃逸）', async () => {
    const ex = createFsToolExecutor([root]);
    const r = await ex({ id: '1', name: 'read_file', input: { path: '../../../etc/passwd' } });
    expect(r).toContain('ERROR');
  });

  it('list_files 列出目录（子目录带 /）', async () => {
    const ex = createFsToolExecutor([root]);
    const r = await ex({ id: '1', name: 'list_files', input: { path: '.' } });
    expect(r).toContain('a.txt');
    expect(r).toContain('sub/');
  });

  it('grep 递归搜索命中（文件:行:内容）', async () => {
    const ex = createFsToolExecutor([root]);
    const r = await ex({ id: '1', name: 'grep', input: { pattern: 'hello' } });
    expect(r).toContain('a.txt:1:');
    expect(r).toContain('hello world');
  });

  it('grep 无命中返回提示', async () => {
    const ex = createFsToolExecutor([root]);
    const r = await ex({ id: '1', name: 'grep', input: { pattern: 'zzzznotfound' } });
    expect(r).toBe('(无命中)');
  });

  it('绝对路径在作用域内也允许', async () => {
    const ex = createFsToolExecutor([root]);
    const r = await ex({ id: '1', name: 'read_file', input: { path: join(root, 'a.txt') } });
    expect(r).toContain('hello world');
  });
});