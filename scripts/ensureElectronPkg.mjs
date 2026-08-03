// 确保 dist-electron 编译产物被当 CommonJS 加载。
// 根 package.json 的 "type":"module" 会让 Node 把 dist-electron/*.js 误判为 ESM，
// 而 tsc（electron/tsconfig.json 的 module:CommonJS）产出的是 CJS（开头即 exports/require），
// 运行时报 "exports is not defined in ES module scope"，打包出来的 app 直接打不开。
// 在产物目录放一个 {"type":"commonjs"} 作为最近祖先 package.json，覆盖根的 type 声明。
// dev:electron / build:electron / dist:electron 在 tsc 之后都要调用——任一路径漏掉都会复发。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function ensureElectronPkg(root) {
  const dir = join(root, 'dist-electron');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n');
}
