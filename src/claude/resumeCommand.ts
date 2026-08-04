/**
 * 拼「复制 resume 命令」的字符串。无 env = 裸命令；有 env = `claude --settings '<json>'` 形式。
 * 前端无密钥，故含 provider 的命令由后端用此函数生成（📋 右键选 provider 复制命令）。
 * 用 --settings 而非 bash env 前缀（`KEY=val claude`）：后者作为进程 env 会被
 * `~/.claude/settings.json` 的 env 块（cc-switch）覆盖，对 cc-switch 用户无效；
 * --settings 优先级更高，能盖过。JSON 用单引号包裹（bash），值含单引号会破坏（token/url 不含）。
 */
export function buildResumeCommand(cwd: string, sessionId: string, env?: Record<string, string>): string {
  if (!env) return `cd "${cwd}" && claude --resume ${sessionId}`;
  const settingsJson = JSON.stringify({ env });
  return `cd "${cwd}" && claude --settings '${settingsJson}' --resume ${sessionId}`;
}
