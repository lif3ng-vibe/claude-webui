// 终端工作区状态：布局树 + 持久化 + 调用 tree 纯函数的 action。
// 终端实例生命周期在 registry，本 store 只管树结构与存盘；removeTab 时释放对应终端。
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { LayoutNode, TabDescriptor, WorkspaceState, TabGroupNode } from '../lib/workspace/types';
import * as tree from '../lib/workspace/tree';
import { getWorkspace, saveWorkspace } from '../api';
import { terminalRegistry } from '../lib/workspace/registry';
import { popOutToWindow } from '../lib/workspace/popout';

export const useWorkspaceStore = defineStore('workspace', () => {
  const root = ref<LayoutNode | null>(null);
  const loaded = ref(false);
  const activeTabId = ref<string | undefined>(undefined);
  /** 弹出窗模式：不持久化、不 load，root 由外部注入。 */
  const poppedMode = ref(false);
  /** "添加终端"对话框目标组（undefined=新组）。null=对话框关闭。 */
  const addTarget = ref<{ groupId?: string } | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function openAdd(groupId?: string): void {
    addTarget.value = { groupId };
  }
  function closeAdd(): void {
    addTarget.value = null;
  }

  async function load(): Promise<void> {
    const st = await getWorkspace();
    root.value = st.root;
    activeTabId.value = st.activeTabId;
    loaded.value = true;
  }

  function scheduleSave(): void {
    if (poppedMode.value) return; // 弹出窗非持久化权威
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const state: WorkspaceState = { version: 1, root: root.value, activeTabId: activeTabId.value };
      void saveWorkspace(state).catch(() => {});
    }, 500);
  }

  /** 用新树替换 root 并防抖存盘。 */
  function commit(next: LayoutNode | null): void {
    root.value = next;
    scheduleSave();
  }

  function genId(): string {
    return crypto.randomUUID();
  }

  function addTab(tab: TabDescriptor, opts: { groupId?: string; strip?: 'top' | 'left' } = {}): void {
    commit(tree.addTab(root.value, tab, { newGroupId: genId(), groupId: opts.groupId, strip: opts.strip }));
    activeTabId.value = tab.id;
  }

  function removeTab(tabId: string): void {
    terminalRegistry.release(tabId);
    commit(tree.removeTab(root.value, tabId));
    if (activeTabId.value === tabId) activeTabId.value = undefined;
  }

  function setActiveTab(groupId: string, tabId: string): void {
    if (!root.value) return;
    commit(tree.setActiveTab(root.value, groupId, tabId));
    activeTabId.value = tabId;
  }

  function moveTab(tabId: string, toGroupId: string, index?: number): void {
    if (!root.value) return;
    commit(tree.moveTab(root.value, tabId, toGroupId, index));
    activeTabId.value = tabId;
  }

  function mergeGroupsInto(srcGroupId: string, dstGroupId: string): void {
    if (!root.value) return;
    commit(tree.mergeGroupsInto(root.value, srcGroupId, dstGroupId));
  }

  function splitGroup(opts: { targetGroupId: string; tabId: string; edge: tree.Edge; newGroupId?: string }): void {
    if (!root.value) return;
    commit(
      tree.splitGroup(root.value, {
        targetGroupId: opts.targetGroupId,
        tabId: opts.tabId,
        edge: opts.edge,
        newGroupId: opts.newGroupId ?? genId(),
        newSplitId: genId(),
      }),
    );
  }

  function setStrip(groupId: string, strip: 'top' | 'left'): void {
    if (!root.value) return;
    commit(tree.setStrip(root.value, groupId, strip));
  }

  function setStripSize(groupId: string, sizePct: number): void {
    if (!root.value) return;
    commit(tree.setStripSize(root.value, groupId, sizePct));
  }

  function setSizes(splitId: string, sizes: number[]): void {
    if (!root.value) return;
    // 防循环：与当前一致就不提交（splitpanes 加减 pane 也会触发 resized）
    const node = tree.findNode(root.value, splitId);
    if (node && node.type === 'split') {
      const norm = tree.normalizeSizes(sizes, node.children.length);
      if (norm.every((v, i) => Math.abs(v - (node.sizes[i] ?? 0)) < 0.01)) return;
    }
    commit(tree.setSizes(root.value, splitId, sizes));
  }

  /** 翻转某 split 的方向（左右 ↔ 上下）。 */
  function flipSplit(splitId: string): void {
    if (!root.value) return;
    commit(tree.flipOrientation(root.value, splitId));
  }

  function popOut(nodeId: string): LayoutNode | null {
    if (!root.value) return null;
    const { remaining, popped } = tree.popOutSubtree(root.value, nodeId);
    commit(remaining);
    return popped;
  }

  function insertSubtree(subtree: LayoutNode): void {
    commit(tree.insertSubtree(root.value, subtree, genId()));
  }

  /** new 标签 sid 回填：升级为 resume。 */
  function backfillTab(tabId: string, patch: Partial<TabDescriptor>): void {
    if (!root.value) return;
    commit(tree.updateTab(root.value, tabId, patch));
  }

  /** 释放子树里所有终端（弹出前用，让新窗口能连）。 */
  function releaseSubtreeTabs(subtree: LayoutNode): void {
    for (const t of tree.walkTabs(subtree)) terminalRegistry.release(t.id);
  }

  /** 弹出某组到独立 OS 窗口：从主树移除 + 释放终端 + 存子树 + 开窗。 */
  function popOutGroup(groupId: string): void {
    if (!root.value) return;
    const { remaining, popped } = tree.popOutSubtree(root.value, groupId);
    commit(remaining);
    popOutToWindow(popped, releaseSubtreeTabs);
  }

  /** 弹出窗模式：注入子树作 root（不持久化、不 load）。 */
  function loadPopped(subtree: LayoutNode): void {
    root.value = subtree;
    poppedMode.value = true;
    loaded.value = true;
  }

  /** 收回：把广播来的子树重新挂回主树（TerminalSlot 会自动重连）。 */
  function dock(subtree: LayoutNode): void {
    if (poppedMode.value) return;
    commit(tree.insertSubtree(root.value, subtree, genId()));
  }

  /** 查某 tab 的描述（供 TerminalSlot acquire）。 */
  function getTabDescriptor(tabId: string): TabDescriptor | undefined {
    const f = tree.findGroupOfTab(root.value, tabId);
    return f ? f.group.tabs[f.index] : undefined;
  }

  /** 查某组的节点（供组件渲染）。 */
  function getGroup(groupId: string): TabGroupNode | null {
    return tree.findGroup(root.value, groupId);
  }

  return {
    root,
    loaded,
    activeTabId,
    poppedMode,
    addTarget,
    load,
    openAdd,
    closeAdd,
    addTab,
    removeTab,
    setActiveTab,
    moveTab,
    mergeGroupsInto,
    splitGroup,
    setStrip,
    setStripSize,
    setSizes,
    flipSplit,
    popOut,
    insertSubtree,
    backfillTab,
    popOutGroup,
    loadPopped,
    dock,
    getTabDescriptor,
    getGroup,
    genId,
  };
});
