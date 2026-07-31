// 新窗口打开抽象层：转发到 desktop bridge。
// web 模式：bridge 不存在 → 回退 window.open 在新标签页打开同源路由。
// 桌面端（Electron/Tauri）：bridge.openWindow 由 shell 创建新 OS 窗口，复用同一后端端口。
// 实现见 desktop.ts；调用点签名不变。
export { openWindow } from './desktop';