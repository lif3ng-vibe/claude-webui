// 桌面壳注入的 bridge 抽象层。
// Electron 在 preload 里用 contextBridge.exposeInMainWorld('__claudeWebuiDesktop', ...)；
// Tauri 在 initialization_script 里包 @tauri-apps/api 注入同一形状对象。
// web 下不存在该对象 → isDesktop=false，openWindow 回退 window.open，标题栏/服务页隐藏。
import { ref } from 'vue';

export type DesktopKind = 'electron' | 'tauri';

export interface ServiceStatus {
  running: boolean;
  port: number | null;
  pid: number | null;
  uptimeMs: number;
  startedAt: number | null;
}

export interface LogEntry {
  ts: number;
  level: 'log' | 'error' | 'info';
  msg: string;
}

export interface DesktopBridge {
  kind: DesktopKind;
  openWindow(path: string): void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  setAlwaysOnTop(v: boolean): void;
  openDevTools(): void;
  // 两端统一异步：Electron 用 ipcRenderer.invoke，Tauri 用 invoke 命令。
  isAlwaysOnTop(): Promise<boolean>;
  service: {
    status(): Promise<ServiceStatus>;
    start(): Promise<void>;
    stop(): Promise<void>;
    restart(): Promise<void>;
    /** 历史日志快照（shell 环形缓冲）。 */
    getLogs(): Promise<LogEntry[]>;
    /** 实时 tail；返回取消订阅函数。 */
    onLog(cb: (e: LogEntry) => void): () => void;
  };
}

const w = window as unknown as { __claudeWebuiDesktop?: DesktopBridge };

/** 桌面 bridge；web 下为 null。 */
export const desktop: DesktopBridge | null = w.__claudeWebuiDesktop ?? null;

/** 是否运行在桌面壳内（Electron/Tauri）。 */
export const isDesktop = desktop !== null;

/**
 * 打开新窗口：桌面端由 shell 创建新 OS 窗口（复用同一后端端口），
 * web 端回退 window.open 在新标签页打开同源路由。6 处调用点签名不变。
 */
export function openWindow(path: string): void {
  if (desktop) {
    desktop.openWindow(path);
  } else {
    window.open(path, '_blank', 'noopener');
  }
}

// 置顶状态：响应式，标题栏置顶按钮用。两端 isAlwaysOnTop 异步，mount 时由 TitleBar 初始化。
export const alwaysOnTop = ref(false);

export async function initAlwaysOnTop(): Promise<void> {
  if (desktop) alwaysOnTop.value = await desktop.isAlwaysOnTop();
}

export async function toggleAlwaysOnTop(): Promise<void> {
  if (!desktop) return;
  const next = !alwaysOnTop.value;
  await desktop.setAlwaysOnTop(next);
  alwaysOnTop.value = await desktop.isAlwaysOnTop();
}

export function minimize(): void {
  desktop?.minimize();
}

export function toggleMaximize(): void {
  desktop?.toggleMaximize();
}

export function closeWindow(): void {
  desktop?.close();
}