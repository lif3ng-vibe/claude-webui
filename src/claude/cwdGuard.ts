import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import os from 'node:os';

const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();

/**
 * 校验新建会话的工作目录：绝对路径、存在、是目录、且不在 ~/.claude 状态区（projects/sessions/本身）内。
 * 不合法时 throw Error（含中文原因），由调用方转 HTTP 400。
 */
export async function assertSafeCwd(cwd: string): Promise<void> {
  if (!cwd || !isAbsolute(cwd)) throw new Error('工作目录必须是绝对路径');
  let s;
  try {
    s = await stat(cwd);
  } catch {
    throw new Error('工作目录不存在');
  }
  if (!s.isDirectory()) throw new Error('工作目录不是目录');
  const claudeDir = join(os.homedir(), '.claude');
  const blocked = [claudeDir, join(claudeDir, 'projects'), join(claudeDir, 'sessions')].map(norm);
  if (blocked.includes(norm(cwd))) throw new Error('不能在 ~/.claude 状态目录内新建会话');
}
