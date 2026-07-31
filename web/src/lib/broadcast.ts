// 跨窗口状态同步：BroadcastChannel 广播数据失效，其他窗口收到后
// invalidateQueries 重新拉取（vue-query 已在栈）。
// 桌面端 webview 同源同样支持 BroadcastChannel。

const CHANNEL = 'claude-webui';

export type InvalidateKey = readonly unknown[];

let channel: BroadcastChannel | null = null;

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CHANNEL);
  return channel;
}

/** 广播：某些 query key 失效了，其他窗口请重新拉 */
export function broadcastInvalidate(keys: InvalidateKey[]): void {
  const ch = ensureChannel();
  if (!ch) return;
  ch.postMessage({ type: 'invalidate', keys });
}

/** 监听广播并失效本窗口 query。返回卸载函数 */
export function setupBroadcastInvalidation(invalidate: (key: unknown[]) => void): () => void {
  const ch = ensureChannel();
  if (!ch) return () => {};
  const onMsg = (e: MessageEvent) => {
    const d = e.data;
    if (d?.type === 'invalidate' && Array.isArray(d.keys)) {
      for (const k of d.keys) invalidate(k);
    }
  };
  ch.addEventListener('message', onMsg);
  return () => ch.removeEventListener('message', onMsg);
}