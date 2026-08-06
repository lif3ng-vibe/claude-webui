import { describe, it, expect } from 'vitest';
import type { LayoutNode, TabDescriptor, TabGroupNode } from '../../web/src/lib/workspace/types';
import {
  addTab,
  removeTab,
  setActiveTab,
  moveTab,
  mergeGroupsInto,
  splitGroup,
  setStrip,
  setStripSize,
  setSizes,
  flipOrientation,
  popOutSubtree,
  insertSubtree,
  findGroup,
  findGroupOfTab,
  makeGroup,
  normalizeSizes,
} from '../../web/src/lib/workspace/tree';

const tab = (id: string): TabDescriptor => ({ id, kind: 'resume', dirName: 'D', sessionId: 's-' + id });
const group = (id: string, ids: string[]): TabGroupNode => ({
  type: 'group',
  id,
  strip: 'top',
  tabs: ids.map(tab),
  activeTabId: ids[0],
});
const hsplit = (id: string, ...kids: LayoutNode[]): LayoutNode => ({
  type: 'split',
  id,
  orientation: 'horizontal',
  sizes: kids.map(() => 100 / kids.length),
  children: kids,
});
const vsplit = (id: string, ...kids: LayoutNode[]): LayoutNode => ({
  type: 'split',
  id,
  orientation: 'vertical',
  sizes: kids.map(() => 100 / kids.length),
  children: kids,
});

const ids = (g: TabGroupNode) => g.tabs.map((t) => t.id);

describe('tree — addTab', () => {
  it('空树 → 建新组', () => {
    const r = addTab(null, tab('a'), { newGroupId: 'g1' });
    expect(r.type).toBe('group');
    expect(ids(r as TabGroupNode)).toEqual(['a']);
  });
  it('追加进现有组并置为活动', () => {
    const r = addTab(group('g1', ['a']), tab('b'), { groupId: 'g1', newGroupId: 'g' });
    expect(ids(r as TabGroupNode)).toEqual(['a', 'b']);
    expect((r as TabGroupNode).activeTabId).toBe('b');
  });
  it('无目标组 → 用纵向 split 与现有并排', () => {
    const r = addTab(group('g1', ['a']), tab('b'), { newGroupId: 'g2' });
    expect(r.type).toBe('split');
    expect((r as { children: LayoutNode[] }).children).toHaveLength(2);
  });
});

describe('tree — removeTab', () => {
  it('删组内最后一个 tab → root=null', () => {
    expect(removeTab(group('g1', ['a']), 'a')).toBeNull();
  });
  it('删非活动 tab → 其余保留', () => {
    const g = group('g1', ['a', 'b', 'c']); // active=a
    const r = removeTab(g, 'b') as TabGroupNode;
    expect(ids(r)).toEqual(['a', 'c']);
    expect(r.activeTabId).toBe('a');
  });
  it('删活动 tab → 活动回落到第一个', () => {
    const g = group('g1', ['a', 'b']);
    const r = removeTab(g, 'a') as TabGroupNode;
    expect(ids(r)).toEqual(['b']);
    expect(r.activeTabId).toBe('b');
  });
  it('split 里某组空 → 塌缩提升兄弟', () => {
    const tree = hsplit('s', group('g1', ['a']), group('g2', ['b']));
    const r = removeTab(tree, 'a');
    expect(r).toEqual(group('g2', ['b'])); // 塌缩为单组
  });
});

describe('tree — setActiveTab', () => {
  it('切换活动标签', () => {
    const r = setActiveTab(group('g1', ['a', 'b']), 'g1', 'b');
    expect((r as TabGroupNode).activeTabId).toBe('b');
  });
});

describe('tree — moveTab', () => {
  it('跨组移动，目标置活动，源不空', () => {
    const tree = hsplit('s', group('g1', ['a', 'c']), group('g2', ['b']));
    const r = moveTab(tree, 'a', 'g2');
    expect(ids(findGroup(r, 'g1')!)).toEqual(['c']);
    expect(ids(findGroup(r, 'g2')!)).toEqual(['b', 'a']);
    expect(findGroup(r, 'g2')!.activeTabId).toBe('a');
  });
  it('源组空 → 塌缩，目标活动切到被移标签', () => {
    const tree = hsplit('s', group('g1', ['a']), group('g2', ['b']));
    const r = moveTab(tree, 'a', 'g2') as TabGroupNode;
    expect(r.type).toBe('group');
    expect(ids(r)).toEqual(['b', 'a']);
    expect(r.activeTabId).toBe('a');
  });
  it('同组重排', () => {
    const r = moveTab(group('g1', ['a', 'b', 'c']), 'a', 'g1', 2);
    expect(ids(r as TabGroupNode)).toEqual(['b', 'c', 'a']);
  });
});

describe('tree — mergeGroupsInto', () => {
  it('整组合并到目标组，活动切到被合并的首个', () => {
    const tree = hsplit('s', group('g1', ['a', 'b']), group('g2', ['c']));
    const r = mergeGroupsInto(tree, 'g2', 'g1');
    const g = findGroup(r, 'g1')!;
    expect(ids(g)).toEqual(['a', 'b', 'c']);
    expect(g.activeTabId).toBe('c');
  });
});

describe('tree — splitGroup', () => {
  it('右边缘 → 包成横向 split [target, new]', () => {
    const r = splitGroup(group('g1', ['a']), { targetGroupId: 'g1', tabId: 'a', edge: 'right', newGroupId: 'g2', newSplitId: 's1' });
    // g1 只有一个 tab a，分屏无意义 → 不操作
    expect(r).toEqual(group('g1', ['a']));
  });
  it('不同向父 → 包成横向 split 嵌套（不与纵向父合并）', () => {
    const tree = vsplit('s', group('g1', ['a', 'x']), group('g2', ['b']));
    const r = splitGroup(tree, { targetGroupId: 'g2', tabId: 'x', edge: 'right', newGroupId: 'g3', newSplitId: 's2' });
    const root = r as { orientation: string; children: LayoutNode[] };
    expect(root.orientation).toBe('vertical'); // 顶层仍是纵向
    expect(root.children).toHaveLength(2);
    const nested = root.children[1] as { type: string; orientation: string; children: TabGroupNode[] };
    expect(nested.type).toBe('split');
    expect(nested.orientation).toBe('horizontal');
    expect(ids(nested.children[0])).toEqual(['b']); // g2 在左
    expect(ids(nested.children[1])).toEqual(['x']); // g3 在右
  });
  it('同向父 split → 插为兄弟而非嵌套', () => {
    const tree = hsplit('s', group('g1', ['a', 'x']), group('g2', ['b']));
    const r = splitGroup(tree, { targetGroupId: 'g2', tabId: 'x', edge: 'left', newGroupId: 'g3', newSplitId: 's2' });
    const root = r as { children: TabGroupNode[]; orientation: string };
    expect(root.orientation).toBe('horizontal');
    expect(root.children).toHaveLength(3); // g1, g3, g2（left → new 在 target 前）
    expect(ids(root.children[1])).toEqual(['x']); // g3 在 g2 左侧
  });
  it('下边缘 → 纵向 split', () => {
    const r = splitGroup(group('g1', ['a', 'x']), { targetGroupId: 'g1', tabId: 'x', edge: 'bottom', newGroupId: 'g2', newSplitId: 's1' });
    const root = r as { orientation: string; children: TabGroupNode[] };
    expect(root.orientation).toBe('vertical');
    expect(ids(root.children[0])).toEqual(['a']);
    expect(ids(root.children[1])).toEqual(['x']);
  });
});

describe('tree — strip / sizes', () => {
  it('setStrip / setStripSize（钳制 10–50）', () => {
    let r = setStrip(group('g1', ['a']), 'g1', 'left');
    expect((r as TabGroupNode).strip).toBe('left');
    r = setStripSize(r, 'g1', 9999);
    expect((r as TabGroupNode).stripSize).toBe(50);
    r = setStripSize(r, 'g1', 1);
    expect((r as TabGroupNode).stripSize).toBe(10);
  });
  it('setSizes 归一', () => {
    const tree = hsplit('s', group('g1', ['a']), group('g2', ['b']));
    const r = setSizes(tree, 's', [1, 3]) as { sizes: number[] };
    expect(r.sizes).toEqual([25, 75]);
  });
  it('flipOrientation 横↔纵', () => {
    const tree = hsplit('s', group('g1', ['a']), group('g2', ['b']));
    const r = flipOrientation(tree, 's');
    expect((r as { orientation: string }).orientation).toBe('vertical');
    const r2 = flipOrientation(r, 's');
    expect((r2 as { orientation: string }).orientation).toBe('horizontal');
  });
});

describe('tree — popOut / insert', () => {
  it('弹出一个组，剩余塌缩', () => {
    const tree = vsplit('s', group('g1', ['a']), group('g2', ['b']));
    const { remaining, popped } = popOutSubtree(tree, 'g2');
    expect(remaining).toEqual(group('g1', ['a']));
    expect(popped).toEqual(group('g2', ['b']));
  });
  it('insertSubtree 空树 → 子树作根', () => {
    const r = insertSubtree(null, group('g2', ['b']), 's');
    expect(r).toEqual(group('g2', ['b']));
  });
  it('insertSubtree 接回 → 纵向 split 并排', () => {
    const r = insertSubtree(group('g1', ['a']), group('g2', ['b']), 's');
    expect(r.type).toBe('split');
    expect((r as { children: LayoutNode[] }).children).toHaveLength(2);
  });
});

describe('tree — normalizeSizes', () => {
  it('均分 / 比例', () => {
    expect(normalizeSizes([0, 0], 2)).toEqual([50, 50]);
    expect(normalizeSizes([1, 3], 2)).toEqual([25, 75]);
    expect(normalizeSizes(undefined, 3)[0]).toBeCloseTo(100 / 3);
  });
});

describe('tree — find helpers', () => {
  it('findGroupOfTab 返回组与索引', () => {
    const tree = vsplit('s', group('g1', ['a', 'b']), group('g2', ['c']));
    const r = findGroupOfTab(tree, 'b')!;
    expect(r.group.id).toBe('g1');
    expect(r.index).toBe(1);
  });
});
