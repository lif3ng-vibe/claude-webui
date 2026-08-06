// 工作区拖拽：自定义 MIME 载荷 + 落点区域判定（纯逻辑，可单测）。
// 注意 HTML5 DnD 安全限制：dragenter/dragover 期间 dataTransfer.getData() 在多数浏览器返回空，
// 只有 drop 事件能读到数据。故 dragover 只做几何落点判定，drop 才读 payload 决定动作。
import type { Edge } from './tree';

export const MIME_TAB = 'application/x-cwebui-tab';
export const MIME_GROUP = 'application/x-cwebui-group';

export interface TabDragPayload {
  tabId: string;
  fromGroupId: string;
}
export interface GroupDragPayload {
  groupId: string;
}

export type Zone = 'center' | Edge;

/** 矩形（结构类型：DOMRect 满足；测试可传纯对象，不依赖 DOM lib）。 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
/** DataTransfer 最小结构（DragEvent.dataTransfer 满足）。 */
export interface LikeDataTransfer {
  getData: (type: string) => string;
}

/**
 * 由光标相对容器矩形的位置判定落点区域。
 * 边缘阈值 EDGE（容器宽/高的比例）：落在某轴的边缘阈值内 → 该方向；否则中心。
 */
export function resolveZone(rect: Rect, x: number, y: number, edge = 0.25): Zone {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  // 左右优先于上下（横向分屏更常用）
  if (rx < edge) return 'left';
  if (rx > 1 - edge) return 'right';
  if (ry < edge) return 'top';
  if (ry > 1 - edge) return 'bottom';
  return 'center';
}

export interface DropPayload {
  kind: 'tab' | 'group' | null;
  tabId?: string;
  fromGroupId?: string;
  groupId?: string;
}

/** 从 drop 事件读载荷（dragover 期间读不到，仅 drop 用）。 */
export function readPayload(e: { dataTransfer: LikeDataTransfer | null }): DropPayload {
  const dt = e.dataTransfer;
  if (!dt) return { kind: null };
  const tab = dt.getData(MIME_TAB);
  if (tab) {
    try {
      const p = JSON.parse(tab) as TabDragPayload;
      if (p.tabId) return { kind: 'tab', tabId: p.tabId, fromGroupId: p.fromGroupId };
    } catch {
      /* 忽略 */
    }
  }
  const grp = dt.getData(MIME_GROUP);
  if (grp) {
    try {
      const p = JSON.parse(grp) as GroupDragPayload;
      if (p.groupId) return { kind: 'group', groupId: p.groupId };
    } catch {
      /* 忽略 */
    }
  }
  return { kind: null };
}

/** tab 在 chip 上的左右半判定：返回插入用的最终索引（before=该 chip 索引，after=索引+1）。 */
export function chipDropIndex(chipIndex: number, x: number, chipRect: Pick<Rect, 'left' | 'width'>): number {
  const mid = chipRect.left + chipRect.width / 2;
  return x <= mid ? chipIndex : chipIndex + 1;
}
