// 把一个版本号同步写进所有"版本来源"，保证 Electron / Tauri / web 三端版本一致。
// CI 打 tag 时调用：node scripts/sync-version.mjs "${GITHUB_REF_NAME#v}"
// 也可本地手动：node scripts/sync-version.mjs 1.2.3
import { readFileSync, writeFileSync } from 'node:fs';

const ver = process.argv[2];
if (!ver || !/^\d+\.\d+\.\d+([-+][\w.]+)*$/.test(ver)) {
  console.error('用法: node scripts/sync-version.mjs <x.y.z>   （仅接受 x.y.z 形式）');
  process.exit(1);
}

// JSON 文件：只替换首个顶层 "version": "..."，保留其余格式不被重排。
function setJsonVersion(file) {
  const s = readFileSync(file, 'utf8');
  const re = /^(\s*)"version"\s*:\s*"[^"]*"/m;
  if (!re.test(s)) throw new Error(`${file} 未找到 version 字段`);
  writeFileSync(file, s.replace(re, `$1"version": "${ver}"`));
}

// Cargo.toml：只替换首个 ^version = "..."（包版本，依赖项不以行首 version= 出现）。
function setCargoVersion(file) {
  const s = readFileSync(file, 'utf8');
  const re = /^version\s*=\s*"[^"]*"/m;
  if (!re.test(s)) throw new Error(`${file} 未找到 version 字段`);
  writeFileSync(file, s.replace(re, `version = "${ver}"`));
}

setJsonVersion('package.json');
setJsonVersion('web/package.json');
setJsonVersion('src-tauri/tauri.conf.json');
setCargoVersion('src-tauri/Cargo.toml');

console.log(`✓ 版本已同步到 ${ver}（package.json / web/package.json / tauri.conf.json / Cargo.toml）`);
