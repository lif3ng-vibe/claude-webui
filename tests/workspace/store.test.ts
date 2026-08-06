import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

// configDir() 走 CLAUDE_WEBUI_DIR，测试里 beforeEach 指到临时目录（load/save 内部惰性读取）。

import { validateWorkspaceState, normalizeSizes, workspaceStore } from '../../src/workspace/store.js';

describe('workspace store — 校验', () => {
  it('null / 非对象 / 缺 root → 空 state', () => {
    expect(validateWorkspaceState(null)).toEqual({ version: 1, root: null });
    expect(validateWorkspaceState('x')).toEqual({ version: 1, root: null });
    expect(validateWorkspaceState({})).toEqual({ version: 1, root: null });
    expect(validateWorkspaceState({ root: null })).toEqual({ version: 1, root: null });
  });

  it('保留合法的单标签组', () => {
    const raw = {
      root: {
        type: 'group',
        id: 'g1',
        strip: 'left',
        stripSize: 22,
        tabs: [{ id: 't1', kind: 'resume', dirName: 'D', sessionId: 's1', title: '标题' }],
        activeTabId: 't1',
      },
    };
    const st = validateWorkspaceState(raw);
    expect(st.root).toEqual({
      type: 'group',
      id: 'g1',
      strip: 'left',
      stripSize: 22,
      tabs: [{ id: 't1', kind: 'resume', dirName: 'D', sessionId: 's1', title: '标题' }],
      activeTabId: 't1',
    });
  });

  it('过滤无效 tab；activeTabId 不在 tabs 时回落到第一个', () => {
    const raw = {
      root: {
        type: 'group',
        id: 'g1',
        strip: 'top',
        tabs: [
          { id: 'bad', kind: 'resume' }, // 缺 sessionId → 丢弃
          { id: 't2', kind: 'new', cwd: 'C:\\x' },
        ],
        activeTabId: 'missing',
      },
    };
    const st = validateWorkspaceState(raw);
    expect(st.root?.type).toBe('group');
    const g = st.root as { id: string; tabs: { id: string }[]; activeTabId: string };
    expect(g.id).toBe('g1');
    expect(g.tabs.map((t) => t.id)).toEqual(['t2']);
    expect(g.activeTabId).toBe('t2');
  });

  it('空组 → root=null', () => {
    const st = validateWorkspaceState({ root: { type: 'group', id: 'g', strip: 'top', tabs: [], activeTabId: 'x' } });
    expect(st.root).toBeNull();
  });

  it('split 单孩子 → 塌缩为孩子；0 孩子 → null', () => {
    const one = validateWorkspaceState({
      root: { type: 'split', orientation: 'horizontal', children: [{ type: 'group', id: 'g', strip: 'top', tabs: [{ id: 't', kind: 'new', cwd: 'c' }], activeTabId: 't' }] },
    });
    expect(one.root?.type).toBe('group'); // 塌缩

    const zero = validateWorkspaceState({ root: { type: 'split', orientation: 'horizontal', children: [] } });
    expect(zero.root).toBeNull();
  });

  it('保留嵌套 split 并规整 sizes', () => {
    const group = (id: string) => ({ type: 'group', id, strip: 'top', tabs: [{ id, kind: 'new', cwd: 'c' }], activeTabId: id });
    const raw = { root: { type: 'split', orientation: 'vertical', sizes: [3, 7], children: [group('a'), group('b')] } };
    const st = validateWorkspaceState(raw);
    const root = st.root as { type: string; sizes: number[]; children: unknown[] };
    expect(root.type).toBe('split');
    expect(root.sizes).toEqual([30, 70]);
    expect(root.children).toHaveLength(2);
  });
});

describe('normalizeSizes', () => {
  it('缺失/全零 → 均分', () => {
    expect(normalizeSizes(undefined, 3)).toEqual([100 / 3, 100 / 3, 100 / 3]);
    expect(normalizeSizes([0, 0], 2)).toEqual([50, 50]);
  });
  it('按比例归一到和≈100', () => {
    expect(normalizeSizes([1, 1, 2], 3)).toEqual([25, 25, 50]);
  });
  it('长度不足补齐', () => {
    expect(normalizeSizes([1], 2)).toEqual([50, 50]);
  });
});

describe('workspace store — 存取往返', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(os.tmpdir(), 'cwu-ws-'));
    process.env.CLAUDE_WEBUI_DIR = tmp;
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('save 后 load 往返一致', async () => {
    const state = {
      version: 1 as const,
      root: {
        type: 'group',
        id: 'g1',
        strip: 'top',
        tabs: [{ id: 't1', kind: 'resume', dirName: 'D', sessionId: 's1' }],
        activeTabId: 't1',
      },
      activeTabId: 't1',
    };
    await workspaceStore.save(state);
    const loaded = await workspaceStore.load();
    expect(loaded).toEqual(state);
  });

  it('load 不存在的文件 → 空 state', async () => {
    expect(await workspaceStore.load()).toEqual({ version: 1, root: null });
  });
});
