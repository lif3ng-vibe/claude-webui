// 运行中 claude 进程的检测与接管：查 ~/.claude/sessions 判断某 session 是否在跑、按 pid kill。
// 用于飞书「kill 接管」防分叉：避免飞书 spawn claude -p 与外部/终端里在跑的 claude 并发写同一 session。
import { exec } from 'node:child_process';
import type { ClaudeFileReader } from './FileReader.js';

/** pid 是否存活（signal 0 探活；不存在/无权限→false）。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 某 session 当前**存活**的运行 pid 列表。
 * 用 getRunningSessions 过滤 sessionId，再探活——避免 kill 后残留的 ~/.claude/sessions 文件误判仍忙。
 */
export async function runningPidsFor(reader: ClaudeFileReader, sessionId: string): Promise<number[]> {
  const all = await reader.getRunningSessions().catch(() => []);
  return all.filter((r) => r.sessionId === sessionId && r.pid).map((r) => r.pid).filter((pid) => isPidAlive(pid));
}

/** kill 一个 pid（Win 用 taskkill 杀进程树——claude 多在 cmd.exe 包裹下；POSIX 用 SIGKILL）。返回是否成功。 */
export function killPid(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? `taskkill /PID ${pid} /T /F` : `kill -9 ${pid}`;
    exec(cmd, (err) => resolve(!err));
  });
}
