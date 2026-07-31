// dist:electron —— 出安装包（CI 用）：build:web -> build:server -> tsc electron/ -> electron-builder（无 --dir，--publish never）。
// 本机仅验证用 build:electron（--dir，unpacked）。
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${c}`))));
  });
}

await run('npm', ['run', 'build:web']);
await run('npm', ['run', 'build:server']);
await run('npx', ['tsc', '-p', 'electron/tsconfig.json']);
// --publish never：仅本地产出，不推任何发布渠道。mac 出 universal dmg，win 出 nsis exe（见 package.json build 配置）。
await run('npx', ['electron-builder', '--publish', 'never']);