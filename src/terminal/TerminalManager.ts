// 网页交互终端：WebSocket ↔ node-pty 跑 `claude --resume <sid>` 的交互式 TUI。
// 协议：
//   客户端 → 服务端：二进制帧 = 终端输入（UTF-8 字节）；文本帧 = JSON 控制消息（{type:'resize',cols,rows}）。
//   服务端 → 客户端：二进制帧 = PTY 输出（UTF-8 字节）；文本帧 = JSON（{type:'exit',code} / {type:'error',msg}）。
// 生命周期：WS 关 → kill PTY + 释放 sessionId 锁（断开即杀）。锁与单发续接共享 runningSessions，互斥。
import * as nodePty from 'node-pty';
import type { WebSocket } from 'ws';
import type { ClaudeFileReader } from '../claude/FileReader.js';

export interface TerminalHandle {
  /** 处理一条已升级的 WebSocket 连接（dir/sid 已从 URL 解析）。 */
  (ws: WebSocket, dirName: string, sessionId: string): void;
}

/**
 * 创建终端处理器。reader 用于解析 cwd；lockSet 与单发续接共用（按 sessionId 互斥）。
 */
export function createTerminalHandler(reader: ClaudeFileReader, lockSet: Set<string>): TerminalHandle {
  return async (ws, dirName, sessionId) => {
    let pty: nodePty.IPty | null = null;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      lockSet.delete(sessionId);
      if (pty) {
        try { pty.kill(); } catch { /* 已退出 */ }
        pty = null;
      }
    };

    // 解析 cwd。
    let cwd: string | undefined;
    try {
      cwd = await reader.getSessionCwd(dirName, sessionId);
    } catch {
      cwd = undefined;
    }
    if (!cwd) {
      ws.send(JSON.stringify({ type: 'error', msg: '无法确定该 session 的工作目录' }));
      ws.close(4000, 'no cwd');
      return;
    }

    // 锁互斥：与单发续接共享同一 sessionId 锁。
    if (lockSet.has(sessionId)) {
      ws.send(JSON.stringify({ type: 'error', msg: '该 session 正在被另一处续接（单发或终端），请先结束' }));
      ws.close(4001, 'busy');
      return;
    }
    lockSet.add(sessionId);

    // spawn 交互式 claude（不带 -p / --output-format，跑原生 TUI；--dangerously-skip-permissions 与单发一致）。
    const isWin = process.platform === 'win32';
    const args = ['--resume', sessionId, '--dangerously-skip-permissions'];
    try {
      pty = isWin
        ? nodePty.spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'claude', ...args], {
            cwd, cols: 80, rows: 24, name: 'xterm-color',
            env: { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' },
          })
        : nodePty.spawn('claude', args, {
            cwd, cols: 80, rows: 24, name: 'xterm-color',
            env: { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' },
          });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', msg: `启动 claude 失败：${String(e)}` }));
      ws.close(4002, 'spawn failed');
      cleanup();
      return;
    }

    // PTY 输出 → WS 二进制。
    pty.onData((data: string) => {
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8'));
    });
    pty.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        ws.close(1000, 'claude exited');
      }
      cleanup();
    });

    // WS → PTY：二进制=输入，文本=控制（resize）。
    ws.on('message', (data, isBinary) => {
      if (!pty) return;
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
        pty.write(buf.toString('utf8'));
      } else {
        const msg = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        try {
          const ctrl = JSON.parse(msg) as { type: string; cols?: number; rows?: number };
          if (ctrl.type === 'resize' && ctrl.cols && ctrl.rows) {
            try { pty.resize(ctrl.cols, ctrl.rows); } catch { /* 忽略 */ }
          }
        } catch {
          /* 非法控制消息忽略 */
        }
      }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  };
}