// 新窗口打开抽象层。
// web 模式：window.open 在新标签页/窗口打开同源路由。
// 桌面端（Electron/Tauri）：只需替换本文件实现为新窗口 API，调用点不变。

export function openWindow(path: string): void {
  const url = path.startsWith('http') ? path : path;
  // history 模式：直接用 path 作为同源 URL
  window.open(url, '_blank', 'noopener');
}