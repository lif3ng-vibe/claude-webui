// build:electron —— 出 unpacked 桌面包（不做安装包/签名）。
// 顺序：build:web -> build:server -> tsc electron/ -> electron-builder --dir
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
await run('npx', ['electron-builder', '--dir']);