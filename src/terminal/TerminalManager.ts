// 网页交互终端：WebSocket ↔ node-pty 跑 claude 的交互式 TUI。
// resume 模式：claude --resume <sid>（现有）。new 模式：fresh claude（不带 --resume），用于目录内新建会话。
// 协议：C→S 二进制=终端输入（UTF-8）；文本={type:'resize',cols,rows}。S→C 二进制=PTY 输出；文本={type:'exit'|'error'}。
// 生命周期：WS 关 → kill PTY + 释放锁（断开即杀）。锁与单发续接共享 runningSessions（resume 按 sid、new 按 "new:"+cwd）。
import * as nodePty from 'node-pty';
import type { WebSocket } from 'ws';
import type { ClaudeFileReader } from '../claude/FileReader.js';
import { writeProviderSettings, delProviderSettings } from '../claude/providerSettings.js';

/** 终端启动选项：resume 续接既有 session；new 在指定 cwd 新建。env=注入的 provider 环境变量。 */
export type TerminalOpts =
  | { mode: 'resume'; dirName: string; sessionId: string; env?: Record<string, string> }
  | { mode: 'new'; cwd: string; env?: Record<string, string> };

/** 由 opts 推导 spawn 参数与锁键（纯函数，便于单测）。 */
export function spawnSpec(opts: TerminalOpts): { args: string[]; lockKey: string } {
  if (opts.mode === 'resume') {
    return { args: ['--resume', opts.sessionId, '--dangerously-skip-permissions'], lockKey: opts.sessionId };
  }
  return { args: ['--dangerously-skip-permissions'], lockKey: 'new:' + opts.cwd };
}

export interface TerminalHandle {
  /** 处理一条已升级的 WebSocket 连接。 */
  (ws: WebSocket, opts: TerminalOpts): void;
}

/**
 * 创建终端处理器。reader 用于解析 cwd（resume 模式）；lockSet 与单发续接共用（按 lockKey 互斥）。
 */
export function createTerminalHandler(reader: ClaudeFileReader, lockSet: Set<string>): TerminalHandle {
  return async (ws, opts) => {
    let pty: nodePty.IPty | null = null;
    let cleaned = false;
    let settingsFile: string | undefined;
    const { args, lockKey } = spawnSpec(opts);

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      lockSet.delete(lockKey);
      if (pty) {
        try { pty.kill(); } catch { /* 已退出 */ }
        pty = null;
      }
      if (settingsFile) void delProviderSettings(settingsFile);
    };

    // 解析 cwd：resume 从 session jsonl；new 直接用 opts.cwd。
    let cwd: string | undefined;
    if (opts.mode === 'resume') {
      try { cwd = await reader.getSessionCwd(opts.dirName, opts.sessionId); } catch { cwd = undefined; }
    } else {
      cwd = opts.cwd;
    }
    if (!cwd) {
      ws.send(JSON.stringify({ type: 'error', msg: '无法确定该 session 的工作目录' }));
      ws.close(4000, 'no cwd');
      return;
    }

    // 锁互斥：与单发续接共享同一 lockSet（resume 按 sessionId、new 按 "new:"+cwd，key 不冲突）。
    if (lockSet.has(lockKey)) {
      ws.send(JSON.stringify({ type: 'error', msg: '该 session/目录正被另一处占用，请先结束' }));
      ws.close(4001, 'busy');
      return;
    }
    lockSet.add(lockKey);

    // provider env 经 --settings 注入（优先级高于 ~/.claude/settings.json，可盖过 cc-switch），
    // 而非 spawn env（会被 settings.json 的 env 块覆盖）。临时文件避免 cmd.exe 解析 JSON。
    if (opts.env && Object.keys(opts.env).length) {
      settingsFile = await writeProviderSettings(opts.env);
      args.push('--settings', process.platform === 'win32' ? `"${settingsFile}"` : settingsFile);
    }

    // spawn 交互式 claude（不带 -p / --output-format，跑原生 TUI；--dangerously-skip-permissions 与单发一致）。
    const isWin = process.platform === 'win32';
    const env = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' };
    try {
      pty = isWin
        ? nodePty.spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'claude', ...args], {
            cwd, cols: 80, rows: 24, name: 'xterm-color', env,
          })
        : nodePty.spawn('claude', args, {
            cwd, cols: 80, rows: 24, name: 'xterm-color', env,
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
