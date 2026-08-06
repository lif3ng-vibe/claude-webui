// 终端注册表：把「终端实例生命周期」与「布局结构」解耦。
// 每个 tab 对应一个 entry：持有 xterm 实例 + WebSocket + 一个终身不换的 hostEl。
// 标签在分屏/标签组间被拖拽时，只移动 hostEl（appendChild 搬家），xterm 实例与 WS 永不重建——
// 历史滚动与实时连接不丢。重的 term/fit/ws 对象 markRaw，只对 status/title 响应式。
//
// 协议同 TerminalPage / 后端 TerminalManager：二进制=终端 IO，文本 JSON=resize/exit/error。
import { markRaw, ref, type Ref, nextTick } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TabDescriptor } from './types';

export type TerminalStatus = 'connecting' | 'live' | 'exited' | 'locked' | 'error';

interface TerminalEntry {
  tabId: string;
  descriptor: TabDescriptor;
  term: Terminal; // markRaw
  fit: FitAddon; // markRaw
  ws: WebSocket; // markRaw
  /** xterm 只 open 进这一个 div，终身不换；搬家时移动它。 */
  hostEl: HTMLDivElement;
  /** 是否已 term.open（首次 attach 时在 DOM 内 open）。 */
  opened: boolean;
  status: Ref<TerminalStatus>;
  title: Ref<string>;
  statusMsg: Ref<string>;
}

const enc = new TextEncoder();

function wsUrl(desc: TabDescriptor): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${proto}://${location.host}/api/terminal`;
  const prov = desc.providerId ? `&provider=${encodeURIComponent(desc.providerId)}` : '';
  if (desc.kind === 'new') {
    return `${base}/new?cwd=${encodeURIComponent(desc.cwd ?? '')}${prov}`;
  }
  return `${base}/${encodeURIComponent(desc.dirName ?? '')}/${encodeURIComponent(desc.sessionId ?? '')}${prov}`;
}

class TerminalRegistry {
  private entries = new Map<string, TerminalEntry>();

  get(tabId: string): TerminalEntry | undefined {
    return this.entries.get(tabId);
  }

  /** 复用已有 entry，否则创建（建 xterm + WS + hostEl，但不 open）。 */
  acquire(desc: TabDescriptor): TerminalEntry {
    const existing = this.entries.get(desc.id);
    if (existing) {
      existing.descriptor = desc;
      return existing;
    }
    const hostEl = document.createElement('div');
    hostEl.className = 'ws-term-host';
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#1a1a1a', foreground: '#ddd', cursor: '#8ab4f8' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const entry: TerminalEntry = {
      tabId: desc.id,
      descriptor: desc,
      term: markRaw(term),
      fit: markRaw(fit),
      ws: undefined as unknown as WebSocket, // connect() 里赋真实 ws 时再 markRaw；markRaw(undefined) 会抛错
      hostEl,
      opened: false,
      status: ref<TerminalStatus>('connecting'),
      title: ref(desc.title ?? ''),
      statusMsg: ref(''),
    };
    this.entries.set(desc.id, entry);

    // Ctrl+C：有选中复制；Ctrl/Cmd+V：粘贴剪贴板到终端（沿用 TerminalPage）。
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && (ev.key === 'c' || ev.key === 'C')) {
        const sel = term.getSelection();
        if (sel.length > 0) {
          navigator.clipboard?.writeText(sel).catch(() => {});
          return false;
        }
        return true;
      }
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) this.send(entry, enc.encode(text));
          })
          .catch(() => {});
        return false;
      }
      return true;
    });

    // 终端输入 → 后端（二进制）。
    term.onData((d) => this.send(entry, enc.encode(d)));

    this.connect(entry);
    return entry;
  }

  private connect(entry: TerminalEntry): void {
    const ws = new WebSocket(wsUrl(entry.descriptor));
    ws.binaryType = 'arraybuffer';
    entry.ws = markRaw(ws);

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        entry.term.write(new Uint8Array(e.data));
      } else {
        try {
          const ctrl = JSON.parse(e.data as string) as { type: string; msg?: string; code?: number };
          if (ctrl.type === 'error') {
            entry.statusMsg.value = ctrl.msg ?? '错误';
          } else if (ctrl.type === 'exit') {
            entry.statusMsg.value = `claude 已退出（code=${ctrl.code}）`;
            entry.status.value = 'exited';
          }
        } catch {
          /* 忽略 */
        }
      }
    };
    ws.onopen = () => {
      entry.status.value = 'live';
      entry.statusMsg.value = '';
      this.fitAndResize(entry.tabId);
    };
    ws.onclose = (e) => {
      // 仅在尚未进入终态时据关闭码置态（exit/error 已设则不覆盖）。
      if (entry.status.value === 'live' || entry.status.value === 'connecting') {
        if (e.code === 4001) {
          entry.status.value = 'locked';
          entry.statusMsg.value = '该 session 正在被另一处续接，请先结束';
        } else if (e.code === 4000) {
          entry.status.value = 'error';
          entry.statusMsg.value = '无法确定该 session 的工作目录';
        } else if (e.code === 4002) {
          entry.status.value = 'error';
          entry.statusMsg.value = '启动 claude 失败';
        } else if (e.code !== 1000) {
          entry.status.value = 'error';
          entry.statusMsg.value = `连接已断开（${e.code}）`;
        }
      }
    };
    ws.onerror = () => {
      if (!entry.statusMsg.value) entry.statusMsg.value = '连接错误';
    };
  }

  /** 重新连接（锁冲突/退出后手动重试）。先关旧 WS 再连。 */
  reconnect(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    try {
      entry.ws.close();
    } catch {
      /* 忽略 */
    }
    entry.status.value = 'connecting';
    entry.statusMsg.value = '';
    this.connect(entry);
  }

  private send(entry: TerminalEntry, data: Uint8Array): void {
    if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(data);
  }

  /** 把 hostEl 挂进容器；首次在 DOM 内 term.open；随后 fit + 通知后端 resize。 */
  attach(tabId: string, container: HTMLElement): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    if (entry.hostEl.parentElement !== container) container.appendChild(entry.hostEl);
    if (!entry.opened) {
      entry.term.open(entry.hostEl);
      entry.opened = true;
    }
    void nextTick(() => this.fitAndResize(tabId));
  }

  /** 从当前父容器摘下 hostEl（不释放；标签仍在，只是不可见）。 */
  detach(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    entry.hostEl.parentElement?.removeChild(entry.hostEl);
  }

  /** 重算列行并通知后端 resize（容器尺寸变化时调）。 */
  fitAndResize(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (!entry || !entry.opened) return;
    try {
      entry.fit.fit();
    } catch {
      /* 容器无尺寸时忽略 */
    }
    if (entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify({ type: 'resize', cols: entry.term.cols ?? 80, rows: entry.term.rows ?? 24 }));
    }
  }

  /** 关闭并释放：断 WS（后端释放锁）→ dispose xterm → 移除 hostEl。 */
  release(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    try {
      entry.ws.close();
    } catch {
      /* 忽略 */
    }
    try {
      entry.term.dispose();
    } catch {
      /* 忽略 */
    }
    entry.hostEl.parentElement?.removeChild(entry.hostEl);
    this.entries.delete(tabId);
  }

  releaseAll(): void {
    for (const id of [...this.entries.keys()]) this.release(id);
  }
}

export const terminalRegistry = new TerminalRegistry();
