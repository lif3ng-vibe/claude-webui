// Electron 打包后 node-pty 落在 app.asar.unpacked/ 下，该路径下 spawn-helper 的
// posix_spawn 会被 macOS 拒绝（即便 +x + 签名，复制到普通目录即恢复）→
// 前端 "posix_spawnp failed"。Tauri 的 Resources/ 路径无此问题，仅 Electron 需要。
//
// 此处在 server 启动最早期（index.ts 首个 import，先于 node-pty 加载）把 node-pty
// 整包复制到 ~/.claude-webui/cache/node_modules/node-pty（普通目录），并 patch
// Module._resolveFilename 让后续 require('node-pty') 解析到缓存副本——helperPath
// 随之指向缓存内的 spawn-helper（普通路径，posix_spawn 正常）。
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export function maybeRelocatePty(): void {
  if (process.platform === 'win32') return;
  const req = createRequire(import.meta.url);
  let srcPkg: string;
  try {
    srcPkg = req.resolve('node-pty/package.json');
  } catch {
    return; // node-pty 未安装则跳过。
  }
  // 仅 app.asar.unpacked（Electron 打包）需要迁移；其他路径（Tauri Resources / dev）直接返回。
  if (!srcPkg.includes('app.asar.unpacked')) return;

  const srcDir = dirname(srcPkg);
  const cacheMods = join(homedir(), '.claude-webui', 'cache', 'node_modules');
  const dstDir = join(cacheMods, 'node-pty');
  // 缺失才复制（避免每次启动重复 cp）；升级时由版本目录或手动清缓存刷新。
  if (!existsSync(join(dstDir, 'package.json'))) {
    mkdirSync(cacheMods, { recursive: true });
    execFileSync('cp', ['-R', srcDir, dstDir]);
  }

  // patch CJS 解析：require('node-pty') → 缓存副本（esbuild ESM bundle 经 banner 的
  // createRequire 调用 require，走 CJS Module 解析，故 _resolveFilename patch 生效）。
  const Module = req('module');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
    if (request === 'node-pty') {
      try {
        return orig.call(this, dstDir, parent, ...rest);
      } catch {
        /* 解析失败则回退原逻辑 */
      }
    }
    return orig.call(this, request, parent, ...rest);
  };
}

// 模块加载即执行：须在 node-pty 首次 require 前。
maybeRelocatePty();
