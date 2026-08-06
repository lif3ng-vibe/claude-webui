// 终端工作区布局树变更：纯函数，不可变更新（structuredClone 后改、返回新树）。
// 所有需要新节点 id 的操作都由调用方（store）传入，保持本模块无副作用、可单测。
// DnD 事件层只负责「算落点 → 选函数 + 生成 id → 调用」，本模块不碰 DOM/事件。
import type { LayoutNode, SplitNode, TabGroupNode, TabDescriptor } from './types';

export type Strip = 'top' | 'left';
export type Edge = 'left' | 'right' | 'top' | 'bottom';

// 深拷贝：用 JSON 而非 structuredClone——后者对 Vue 响应式 Proxy 会抛 DataCloneError。
// 布局树是纯可序列化数据（字符串/数组/普通对象），JSON 拷贝足够且安全。
function clone<T>(t: T): T {
  return JSON.parse(JSON.stringify(t));
}

function isGroup(n: LayoutNode): n is TabGroupNode {
  return n.type === 'group';
}
function isSplit(n: LayoutNode): n is SplitNode {
  return n.type === 'split';
}

/** 把 sizes 规整为长度 n、和≈100。长度不符或含非正值 → 均分。 */
export function normalizeSizes(sizes: number[] | undefined, n: number): number[] {
  if (n <= 0) return [];
  const even = (): number[] => Array.from({ length: n }, () => 100 / n);
  if (!Array.isArray(sizes)) return even();
  const parsed = sizes.slice(0, n).map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  if (parsed.length !== n || parsed.some((x) => x === 0)) return even();
  const sum = parsed.reduce((a, b) => a + b, 0);
  return parsed.map((x) => (x / sum) * 100);
}

/** DFS 找组。 */
export function findGroup(root: LayoutNode | null, groupId: string): TabGroupNode | null {
  if (!root) return null;
  if (isGroup(root)) return root.id === groupId ? root : null;
  for (const c of root.children) {
    const g = findGroup(c, groupId);
    if (g) return g;
  }
  return null;
}

/** DFS 找任意节点（组或 split）by id。 */
export function findNode(root: LayoutNode | null, nodeId: string): LayoutNode | null {
  if (!root) return null;
  if (root.id === nodeId) return root;
  if (isSplit(root)) {
    for (const c of root.children) {
      const n = findNode(c, nodeId);
      if (n) return n;
    }
  }
  return null;
}

/** 找含某 tab 的组及其索引。 */
export function findGroupOfTab(root: LayoutNode | null, tabId: string): { group: TabGroupNode; index: number } | null {
  if (!root) return null;
  if (isGroup(root)) {
    const i = root.tabs.findIndex((t) => t.id === tabId);
    return i >= 0 ? { group: root, index: i } : null;
  }
  for (const c of root.children) {
    const r = findGroupOfTab(c, tabId);
    if (r) return r;
  }
  return null;
}

/** 收集树中所有 tab 描述（DFS）。 */
export function walkTabs(root: LayoutNode | null): TabDescriptor[] {
  if (!root) return [];
  if (isGroup(root)) return root.tabs.slice();
  return root.children.flatMap((c) => walkTabs(c));
}

/** 更新某 tab 的字段（patch 合并；用于 new 标签 sid 回填）。 */
export function updateTab(root: LayoutNode, tabId: string, patch: Partial<TabDescriptor>): LayoutNode {
  const next = clone(root);
  const f = findGroupOfTab(next, tabId);
  if (f) Object.assign(f.group.tabs[f.index], patch);
  return next;
}

/** 找某节点的父 split 及其在父中的索引（根节点无父 → null）。 */
export function findParent(root: LayoutNode | null, nodeId: string): { parent: SplitNode; index: number } | null {
  if (!root || isGroup(root)) return null;
  for (let i = 0; i < root.children.length; i++) {
    const c = root.children[i];
    if (c.id === nodeId) return { parent: root, index: i };
    const deep = findParent(c, nodeId);
    if (deep) return deep;
  }
  return null;
}

/** 新建单标签组。 */
export function makeGroup(id: string, tab: TabDescriptor, strip: Strip = 'top'): TabGroupNode {
  return { type: 'group', id, strip, tabs: [tab], activeTabId: tab.id };
}

/** 用 newNode 替换 id=oldId 的节点（在 clone 上操作）。 */
function replaceNode(root: LayoutNode, oldId: string, newNode: LayoutNode): LayoutNode {
  if (root.id === oldId) return newNode;
  if (isSplit(root)) root.children = root.children.map((c) => replaceNode(c, oldId, newNode));
  return root;
}

/**
 * 移除 id=nodeId 的节点，并沿途塌缩只剩 1 个孩子的 split、提升其孩子。
 * 根被移除 → 返回 null。
 */
function rebuildWithout(root: LayoutNode, nodeId: string): LayoutNode | null {
  if (root.id === nodeId) return null;
  if (isGroup(root)) return root;
  const kids = root.children.map((c) => rebuildWithout(c, nodeId)).filter((c): c is LayoutNode => c !== null);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0]; // 塌缩
  return { ...root, children: kids, sizes: normalizeSizes(root.sizes, kids.length) };
}

/** 加标签：root 为空 → 建新组；否则追加进 groupId 组。返回新树。 */
export function addTab(
  root: LayoutNode | null,
  tab: TabDescriptor,
  opts: { groupId?: string; newGroupId: string; strip?: Strip },
): LayoutNode {
  if (!root) return makeGroup(opts.newGroupId, tab, opts.strip ?? 'top');
  const next = clone(root);
  const g = opts.groupId ? findGroup(next, opts.groupId) : null;
  if (g) {
    g.tabs.push(tab);
    g.activeTabId = tab.id;
  } else {
    // 无目标组：用新 split 把现有 root 与新组并排（纵向堆叠）
    const newGroup = makeGroup(opts.newGroupId, tab, opts.strip ?? 'top');
    return { type: 'split', id: cryptoRandomId(), orientation: 'vertical', sizes: [50, 50], children: [next, newGroup] };
  }
  return next;
}

/** 关标签；组空则塌缩；root 变空返回 null。 */
export function removeTab(root: LayoutNode | null, tabId: string): LayoutNode | null {
  if (!root) return null;
  const next = clone(root);
  const found = findGroupOfTab(next, tabId);
  if (!found) return next;
  const { group, index } = found;
  group.tabs.splice(index, 1);
  if (group.tabs.length === 0) return rebuildWithout(next, group.id);
  if (group.activeTabId === tabId) group.activeTabId = group.tabs[0].id;
  return next;
}

/** 切活动标签。 */
export function setActiveTab(root: LayoutNode, groupId: string, tabId: string): LayoutNode {
  const next = clone(root);
  const g = findGroup(next, groupId);
  if (g && g.tabs.some((t) => t.id === tabId)) g.activeTabId = tabId;
  return next;
}

/** 移动标签到目标组（index 默认末尾）；源组空则塌缩；目标活动置为被移标签。 */
export function moveTab(root: LayoutNode, tabId: string, toGroupId: string, index?: number): LayoutNode | null {
  const next = clone(root);
  const src = findGroupOfTab(next, tabId);
  const dst = findGroup(next, toGroupId);
  if (!src || !dst) return next;
  const [tab] = src.group.tabs.splice(src.index, 1);
  if (src.group === dst) {
    // 同组重排：index 是拖动后应落入的最终位置（DnD 层据此计算，已排除被拖 tab）
    const at = Math.max(0, Math.min(index ?? dst.tabs.length, dst.tabs.length));
    dst.tabs.splice(at, 0, tab);
  } else {
    const at = Math.max(0, Math.min(index ?? dst.tabs.length, dst.tabs.length));
    dst.tabs.splice(at, 0, tab);
    if (src.group.tabs.length === 0) {
      // 源空：先塌缩，再定位目标组（id 不变）
      const collapsed = rebuildWithout(next, src.group.id);
      if (collapsed) {
        const dst2 = findGroup(collapsed, toGroupId);
        if (dst2) dst2.activeTabId = tabId;
        return collapsed;
      }
      return null;
    }
    if (src.group.activeTabId === tabId) src.group.activeTabId = src.group.tabs[0].id;
  }
  dst.activeTabId = tabId;
  return next;
}

/** 整组合并进目标组：源组 tabs 追加到目标组；删源组（塌缩）。 */
export function mergeGroupsInto(root: LayoutNode, srcGroupId: string, dstGroupId: string): LayoutNode {
  if (srcGroupId === dstGroupId) return root;
  const next = clone(root);
  const src = findGroup(next, srcGroupId);
  const dst = findGroup(next, dstGroupId);
  if (!src || !dst) return next;
  const moved = src.tabs;
  dst.tabs.push(...moved);
  dst.activeTabId = moved[0]?.id ?? dst.activeTabId;
  return rebuildWithout(next, srcGroupId) ?? next;
}

/** 边缘分屏：把 tab 从源组取出，在 targetGroupId 旁按 edge 方向新建兄弟组。 */
export function splitGroup(
  root: LayoutNode,
  opts: { targetGroupId: string; tabId: string; edge: Edge; newGroupId: string; newSplitId: string },
): LayoutNode {
  let next = clone(root);
  const tabEntry = findGroupOfTab(next, opts.tabId);
  if (!tabEntry) return next;
  // 若目标组就是源组且只有这一个 tab，分屏无意义 → 不操作
  if (tabEntry.group.id === opts.targetGroupId && tabEntry.group.tabs.length === 1) return next;

  const tab = tabEntry.group.tabs[tabEntry.index];
  // 先把 tab 从源移除（复用 removeTab，处理源空塌缩）
  next = removeTab(next, opts.tabId) ?? next;

  const target = findGroup(next, opts.targetGroupId);
  if (!target) return next; // 目标随塌缩消失（不应发生）
  const newGroup = makeGroup(opts.newGroupId, { ...tab });
  const edgeOrient: 'horizontal' | 'vertical' = opts.edge === 'left' || opts.edge === 'right' ? 'horizontal' : 'vertical';
  const insertBefore = opts.edge === 'left' || opts.edge === 'top';
  const parent = findParent(next, opts.targetGroupId);
  if (parent && parent.parent.orientation === edgeOrient) {
    // 同向父 split：直接插入为兄弟，避免无谓嵌套
    const at = insertBefore ? parent.index : parent.index + 1;
    parent.parent.children.splice(at, 0, newGroup);
    parent.parent.sizes.splice(at, 0, 100 / parent.parent.children.length);
    parent.parent.sizes = normalizeSizes(parent.parent.sizes, parent.parent.children.length);
    return next;
  }
  // 包裹：用新 split 替换 target，内含 target 与 newGroup
  const newSplit: SplitNode = {
    type: 'split',
    id: opts.newSplitId,
    orientation: edgeOrient,
    sizes: [50, 50],
    children: insertBefore ? [newGroup, target] : [target, newGroup],
  };
  return replaceNode(next, opts.targetGroupId, newSplit);
}

/** 设标签栏方向 / 列宽。 */
export function setStrip(root: LayoutNode, groupId: string, strip: Strip): LayoutNode {
  const next = clone(root);
  const g = findGroup(next, groupId);
  if (g) g.strip = strip;
  return next;
}
export function setStripSize(root: LayoutNode, groupId: string, sizePct: number): LayoutNode {
  const next = clone(root);
  const g = findGroup(next, groupId);
  if (g) g.stripSize = Math.max(10, Math.min(50, Math.round(sizePct)));
  return next;
}

/** 设某 split 的 sizes（splitpanes @resized 回写）。 */
export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  const next = clone(root);
  const s = findNode(next, splitId);
  if (s && isSplit(s)) s.sizes = normalizeSizes(sizes, s.children.length);
  return next;
}

/** 翻转某 split 的方向：horizontal(左右) ↔ vertical(上下)。 */
export function flipOrientation(root: LayoutNode, splitId: string): LayoutNode {
  const next = clone(root);
  const s = findNode(next, splitId);
  if (s && isSplit(s)) s.orientation = s.orientation === 'horizontal' ? 'vertical' : 'horizontal';
  return next;
}

/** 弹出某节点子树：返回 {剩余树, 被弹出的子树}。 */
export function popOutSubtree(root: LayoutNode, nodeId: string): { remaining: LayoutNode | null; popped: LayoutNode } {
  const popped = findNode(clone(root), nodeId);
  if (!popped) return { remaining: root, popped: root };
  const remaining = rebuildWithout(clone(root), nodeId);
  return { remaining, popped };
}

/** 把子树接回：root 为空 → 子树作根；否则用新 split 与现有 root 并排堆叠。 */
export function insertSubtree(root: LayoutNode | null, subtree: LayoutNode, newSplitId: string): LayoutNode {
  if (!root) return subtree;
  return { type: 'split', id: newSplitId, orientation: 'vertical', sizes: [50, 50], children: [clone(root), clone(subtree)] };
}

// crypto.randomUUID 的薄封装（Node 18+ / 现代浏览器均有；放末尾以便纯函数测试可注入 id 替代）。
function cryptoRandomId(): string {
  return crypto.randomUUID();
}
