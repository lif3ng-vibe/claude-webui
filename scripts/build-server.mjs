// 把 src/server 打成单个 ESM bundle，供 Electron/Tauri 桌面壳作为 sidecar 启动。
// dev 用 tsx 跑源码，prod 用 `node dist-server/server.js`。
import { build } from 'esbuild';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outdir = resolve(root, 'dist-server');

await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'src/server/index.ts')],
  outfile: resolve(outdir, 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  // node-pty 是原生模块（N-API 预编译），不能打进单文件 bundle；external 后运行时从 node_modules 解析。
  // ws 是纯 JS，仍打进。
  external: ['node-pty'],
  // banner 注入 createRequire：防御 CJS 依赖（如 @anthropic-ai/sdk 的可选动态 require）在 ESM bundle 里需要 require。
  banner: {
    js: "import { createRequire as __createRequire } from 'module';\nconst require = __createRequire(import.meta.url);",
  },
  // 防御：若将来出现 .node 原生模块，按文件拷贝而非内联。
  loader: { '.node': 'file' },
  logLevel: 'info',
});

const size = (await stat(resolve(outdir, 'server.js'))).size;
console.log(`build:server -> dist-server/server.js (${(size / 1024).toFixed(1)} KB)`);
void result;