// 工作区弹出/收回（混合窗口模型）：
//   弹出：把某组子树序列化到 localStorage，openWindow('/workspace?pop=<id>') 新 OS 窗口只渲染该子树；
//         主窗口先 release 该子树的终端（释放 per-sessionId 锁），新窗口再连。
//   收回：弹出窗经 BroadcastChannel('cwu-workspace') 广播 {dock, subtree} → 主窗口 insertSubtree 重新挂回。
//   持久化权威只在主窗口（poppedMode 不写 workspace.json）。
import type { LayoutNode } from './types';
import { openWindow } from '../openWindow';

const POP_PREFIX = 'cwu-pop-';
const CHANNEL = 'cwu-workspace';
let channel: BroadcastChannel | null = null;

function ch(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CHANNEL);
  return channel;
}

/** 写入弹出子树，返回新窗口 URL 用的 token。 */
export function writePop(subtree: LayoutNode): string {
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(POP_PREFIX + id, JSON.stringify(subtree));
  } catch {
    /* 忽略 */
  }
  return id;
}

/** 新窗口读取弹出子树。 */
export function readPop(id: string): LayoutNode | null {
  try {
    return JSON.parse(localStorage.getItem(POP_PREFIX + id) ?? 'null') as LayoutNode | null;
  } catch {
    return null;
  }
}

export function clearPop(id: string): void {
  try {
    localStorage.removeItem(POP_PREFIX + id);
  } catch {
    /* 忽略 */
  }
}

/** 弹出：主窗口释放子树终端 + 存子树 + 开新窗口。 */
export function popOutToWindow(subtree: LayoutNode, releaseTabs: (subtree: LayoutNode) => void): void {
  releaseTabs(subtree);
  const id = writePop(subtree);
  openWindow(`/workspace?pop=${encodeURIComponent(id)}`);
}

/** 收回：广播子树给主窗口。postMessage 走 structured clone，需先转纯对象（响应式 Proxy 不可克隆）。 */
export function broadcastDock(subtree: LayoutNode): void {
  const plain = JSON.parse(JSON.stringify(subtree)) as LayoutNode;
  ch()?.postMessage({ type: 'dock', subtree: plain });
}

/** 主窗口监听收回。返回卸载函数。 */
export function onDocked(cb: (subtree: LayoutNode) => void): () => void {
  const c = ch();
  if (!c) return () => {};
  const h = (e: MessageEvent) => {
    if (e.data?.type === 'dock' && e.data.subtree) cb(e.data.subtree as LayoutNode);
  };
  c.addEventListener('message', h);
  return () => c.removeEventListener('message', h);
}
