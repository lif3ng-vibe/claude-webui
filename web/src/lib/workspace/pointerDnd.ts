// 基于 pointer 事件的拖拽（替代 HTML5 DnD——后者在 Tauri WebView2 不可靠）。
// 浏览器与 Tauri 下行为一致：pointerdown 起算，移动超阈值进入拖拽，pointermove 用
// elementFromPoint 命中目标（靠 data-ws-tab / data-ws-area 属性），pointerup 落定。
// 全局响应式 drag 态供各 TabGroup 渲染插入指示 / 分屏半区高亮（跨组一致）。
import { reactive } from 'vue';
import { resolveZone, type Zone } from './dnd';

export interface DragState {
  active: boolean;
  kind: 'tab' | 'group' | null;
  tabId: string | null;
  groupId: string | null; // kind='group' 时为源组
  fromGroupId: string | null;
  hoverTab: { groupId: string; index: number } | null;
  hoverArea: { groupId: string; zone: Zone } | null;
}

export const drag = reactive<DragState>({
  active: false,
  kind: null,
  tabId: null,
  groupId: null,
  fromGroupId: null,
  hoverTab: null,
  hoverArea: null,
});

export function startTabDrag(tabId: string, fromGroupId: string): void {
  Object.assign(drag, { active: true, kind: 'tab', tabId, groupId: null, fromGroupId, hoverTab: null, hoverArea: null });
}
export function startGroupDrag(groupId: string): void {
  Object.assign(drag, { active: true, kind: 'group', tabId: null, groupId, fromGroupId: groupId, hoverTab: null, hoverArea: null });
}
export function clearDrag(): void {
  Object.assign(drag, { active: false, kind: null, tabId: null, groupId: null, fromGroupId: null, hoverTab: null, hoverArea: null });
}

/** 由 pointermove 调用：用 elementFromPoint 找命中的 tab 或终端区。 */
export function updateHover(x: number, y: number): void {
  drag.hoverTab = null;
  drag.hoverArea = null;
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return;
  const tabEl = el.closest('[data-ws-tab]') as HTMLElement | null;
  if (tabEl && tabEl.dataset.wsTab) {
    const [gid, , idxStr] = tabEl.dataset.wsTab.split(':');
    const idx = Number(idxStr);
    const r = tabEl.getBoundingClientRect();
    const index = x <= r.left + r.width / 2 ? idx : idx + 1;
    drag.hoverTab = { groupId: gid, index };
    return;
  }
  const areaEl = el.closest('[data-ws-area]') as HTMLElement | null;
  if (areaEl && areaEl.dataset.wsArea) {
    drag.hoverArea = { groupId: areaEl.dataset.wsArea, zone: resolveZone(areaEl.getBoundingClientRect(), x, y) };
  }
}
