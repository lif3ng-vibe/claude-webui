import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * 把 provider 的环境变量写成临时 settings JSON 文件（`{"env":{...}}`），
 * 供 `claude --settings <file>` 使用。
 *
 * 为什么用 --settings 而非 spawn env：Claude Code 启动时会用 `~/.claude/settings.json`
 * 的 `env` 块覆盖进程环境变量（cc-switch 等工具即靠此切换 provider）。实测 `--settings`
 * CLI 参数的 env 优先级高于 `~/.claude/settings.json`，故经此注入才能盖过 cc-switch。
 * 文件形式（而非内联 JSON）避免 Windows cmd.exe 对 JSON 引号/花括号的 shell 解析问题。
 */
export async function writeProviderSettings(env: Record<string, string>): Promise<string> {
  const file = join(os.tmpdir(), `cwu-prov-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({ env }), 'utf8');
  return file;
}

/** 删除临时 settings 文件（run 结束后调用，失败忽略）。 */
export async function delProviderSettings(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    /* 已删或不存在 */
  }
}