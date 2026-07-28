/**
 * Claude Code 把 session 存放在 `~/.claude/projects/<编码后的cwd>/<sessionId>.jsonl`。
 *
 * 编码规则：把 cwd 中的路径分隔符（`/`、`\`）和 Windows 盘符冒号（`:`）替换为 `-`：
 *   C:\Users\lif3n\src\claude-webui  ->  C--Users-lif3n-src-claude-webui
 *
 * 已对照本机 `~/.claude/projects` 验证的观察：
 *  - 大小写保留（如 `C--` 与 `c--`）
 *  - 文件名中已有的 `-` 保留
 *
 * 重要：把目录名反解回 cwd 是有歧义的（字面 `-` 与分隔符无法区分）。
 * 权威 cwd 应从 session jsonl 消息里的 `cwd` 字段读取；下面的
 * `decodeCwdHeuristic` 仅为尽力而为的兜底。
 */

/** cwd -> 文件系统安全的 projects 目录名。须与 Claude Code 的编码一致。 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-');
}

/**
 * 尽力而为的 目录名 -> cwd。有歧义，不要依赖其正确性。
 * 优先从 session jsonl 读取 `cwd`。
 */
export function decodeCwdHeuristic(dirName: string, isWindows = true): string {
  if (isWindows) {
    // C--Users-...  ->  C:\Users\...   (恢复盘符冒号，再把 `-` -> `\`)
    const m = dirName.match(/^([A-Za-z])--(.+)$/);
    if (m) return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`;
    return dirName;
  }
  // -home-alice  ->  /home/alice
  return '/' + dirName.replace(/-/g, '/');
}