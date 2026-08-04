/**
 * 拼「复制 resume 命令」的字符串。无 env = 裸命令；有 env = bash 风格环境变量前缀。
 * 前端无密钥，故含 provider 的命令由后端用此函数生成（📋 右键选 provider 复制命令）。
 * 已知限制：值用单引号包裹，若值含单引号会破坏（token/url 不含，可接受）。
 */
export function buildResumeCommand(cwd: string, sessionId: string, env?: Record<string, string>): string {
  const tail = `claude --resume ${sessionId}`;
  if (!env) return `cd "${cwd}" && ${tail}`;
  const parts: string[] = [];
  if (env.ANTHROPIC_BASE_URL) parts.push(`ANTHROPIC_BASE_URL='${env.ANTHROPIC_BASE_URL}'`);
  if (env.ANTHROPIC_AUTH_TOKEN) parts.push(`ANTHROPIC_AUTH_TOKEN='${env.ANTHROPIC_AUTH_TOKEN}'`);
  else if (env.ANTHROPIC_API_KEY) parts.push(`ANTHROPIC_API_KEY='${env.ANTHROPIC_API_KEY}'`);
  if (env.ANTHROPIC_MODEL) parts.push(`ANTHROPIC_MODEL='${env.ANTHROPIC_MODEL}'`);
  return `cd "${cwd}" && ${parts.join(' ')} ${tail}`;
}
