// dev:electron —— 编译 electron/ 到 dist-electron/，然后启动 electron（窗口指 Vite 5173）。
// 需另起两个终端：`npm run dev`（sidecar 3000）、`cd web && npm run dev`（Vite 5173）。
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectronPkg } from './ensureElectronPkg.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, env) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: root, env: { ...process.env, ...env }, shell: process.platform === 'win32' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
  });
}

await run('npx', ['tsc', '-p', 'electron/tsconfig.json'], {});
// dist-electron 是 CommonJS 编译产物；根 package.json 的 type:module 会把 .js 误当 ESM，故标记为 commonjs。
ensureElectronPkg(root);
await run('npx', ['electron', '.'], { CLAUDE_WEBUI_DEV: '1' });