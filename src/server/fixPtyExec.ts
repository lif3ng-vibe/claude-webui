// node-pty 在 macOS 上用 posix_spawn 启动 spawn-helper 二进制（helper 内部再
// execvp 跑 claude）。但 npm 包里的 spawn-helper 默认无执行权限位（-rw-r--r--），
// 打包后也未恢复，导致 posix_spawn 报 EACCES → 前端看到 "posix_spawnp failed"。
// 此处在 server 启动最早期（加载 node-pty 之前）给 helper 加 +x，自愈打包环境。
import { createRequire } from 'node:module';
import { existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function fixPtyExecPermission(): void {
  if (process.platform === 'win32') return;

  // 用 require.resolve 定位 node-pty 包根目录（dev/prod 皆准，不依赖 cwd）。
  // 注意：用 req 而非 require，避免与 build-server banner 注入的全局 require 重复声明。
  let ptyDir: string | undefined;
  try {
    const req = createRequire(import.meta.url);
    ptyDir = dirname(req.resolve('node-pty/package.json'));
  } catch {
    return; // node-pty 未安装则跳过。
  }

  const plat = `${process.platform}-${process.arch}`;
  const candidates = [
    join(ptyDir, 'build', 'Release', 'spawn-helper'),
    join(ptyDir, 'build', 'Debug', 'spawn-helper'),
    join(ptyDir, 'prebuilds', plat, 'spawn-helper'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      chmodSync(p, 0o755);
    } catch {
      /* 权限不足时忽略；非致命。 */
    }
  }
}

// 模块加载即执行：须在 node-pty 首次 spawn 前完成。
fixPtyExecPermission();
