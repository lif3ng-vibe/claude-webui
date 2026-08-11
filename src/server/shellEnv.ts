// 打包后的桌面应用从 macOS 图形界面（Dock/Finder/launchd）启动，
// 继承的 PATH 极简（通常仅 /usr/bin:/bin:/usr/sbin:/sbin），找不到用户经
// homebrew / npm-global / nvm / cargo 等安装的 claude / git / node 等命令，
// 表现为 node-pty.spawn('claude', ...) 报 posix_spawnp failed。
// 此处在 server 进程启动最早期，通过登录 shell 同步拉取完整 PATH 注入 process.env，
// 使后续所有子进程（终端、单发续接等）都能正确解析命令路径。
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

/** 仅这些平台需要修复：Windows 图形应用继承系统全局 PATH，无需处理。 */
function needsFix(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

/** 回退用：注入常见用户命令安装根目录，覆盖 homebrew / npm / cargo / bun / deno 等。 */
function fallbackPaths(): string[] {
  const home = homedir();
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    `${home}/.npm-global/bin`,
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.deno/bin`,
    `${home}/.cargo/bin`,
    `${home}/.opencode/bin`,
  ];
}

/**
 * 同步修复 PATH，必须在任何子进程 spawn 之前调用。
 * 登录 shell 获取失败时回退到常见路径列表。
 */
export function syncShellEnv(): void {
  if (!needsFix()) return;

  const current = (process.env.PATH || '').split(':').filter(Boolean);
  let resolved: string[] = [];

  const shell = process.env.SHELL || '/bin/zsh';
  try {
    // -l 登录（读取 .zprofile/.zshenv 等 PATH 设置）；非交互避免交互式副作用。
    const out = execSync(`${shell} -l -c 'echo $PATH'`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // echo $PATH 输出形如 /a:/b:/c；偶有 motd 多行时取最后一个含 / 与 : 的行。
    const line = out.split('\n').filter((l) => l.includes('/') && l.includes(':')).pop() || out;
    if (line.includes('/')) {
      resolved = line.split(':').filter(Boolean);
    }
  } catch {
    // 登录 shell 拉取失败：静默回退到常见路径。
  }

  if (resolved.length === 0) {
    resolved = fallbackPaths();
  }

  // 合并去重：登录 shell 的 PATH 优先，再附加原 PATH 独有项（保底不丢系统路径）。
  const merged = [...new Set([...resolved, ...current])];
  process.env.PATH = merged.join(':');
}

// 模块加载即执行：作为 index.ts 首个 import，保证在任何子进程 spawn 前完成修复。
syncShellEnv();
