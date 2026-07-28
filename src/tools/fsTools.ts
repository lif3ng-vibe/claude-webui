import { open, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ProviderTool, ProviderToolCall } from '../provider/Provider.js';

/** 只读磁盘工具定义（供“就 session 步骤提问”功能使用）。 */
export const FS_TOOLS: ProviderTool[] = [
  {
    name: 'read_file',
    description: '读取指定文件内容（最多 256KB）。path 可为相对于工作目录的路径或绝对路径。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: '列出目录下的文件与子目录名。path 默认为工作目录。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
  },
  {
    name: 'grep',
    description: '在工作目录下递归搜索匹配正则的文件内容，返回最多 50 条命中（文件:行:内容）。',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  },
];

/** 把模型给的路径解析到某个 rootDir 之内，否则抛错（防止 `..` 逃逸）。 */
function safeResolve(rootDirs: string[], p: string): string {
  const input = String(p ?? '');
  for (const root of rootDirs) {
    const full = isAbsolute(input) ? resolve(input) : resolve(root, input);
    const rel = relative(root, full);
    // rel === '' 表示正好是 root；否则必须不以 .. 开头
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return full;
  }
  throw new Error(`路径越界，仅允许在 ${rootDirs.join(', ')} 内：${input}`);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'out', 'build']);

async function grepWalk(root: string, origin: string, re: RegExp, out: string[], max: number): Promise<void> {
  if (out.length >= max) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return;
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) {
      await grepWalk(p, origin, re, out, max);
    } else if (e.isFile()) {
      try {
        const text = await readFile(p, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && out.length < max; i++) {
          if (re.test(lines[i])) out.push(`${relative(origin, p)}:${i + 1}:${lines[i].slice(0, 200)}`);
        }
      } catch {
        /* 跳过无法读取/非文本的文件 */
      }
    }
  }
}

/**
 * 构造一个只读工具执行器，作用域限定在 rootDirs 之内（典型为 session cwd + ~/.claude）。
 * 任何错误返回 `ERROR: ...` 字符串交给模型（不抛出），让模型自行调整。
 */
export function createFsToolExecutor(rootDirs: string[]): (toolCall: ProviderToolCall) => Promise<string> {
  return async (toolCall) => {
    const input = (toolCall.input ?? {}) as { path?: string; pattern?: string };
    try {
      switch (toolCall.name) {
        case 'read_file': {
          const full = safeResolve(rootDirs, input.path ?? '');
          const fh = await open(full, 'r');
          try {
            const buf = Buffer.alloc(262144);
            const { bytesRead } = await fh.read(buf, 0, 262144, 0);
            return buf.subarray(0, bytesRead).toString('utf8');
          } finally {
            await fh.close();
          }
        }
        case 'list_files': {
          const full = safeResolve(rootDirs, input.path ?? '.');
          const entries = await readdir(full, { withFileTypes: true });
          const out = entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n');
          return out || '(empty)';
        }
        case 'grep': {
          const pattern = String(input.pattern ?? '');
          let re: RegExp;
          try {
            re = new RegExp(pattern);
          } catch {
            return 'ERROR: 非法正则';
          }
          const full = safeResolve(rootDirs, input.path ?? '.');
          const matches: string[] = [];
          await grepWalk(full, full, re, matches, 50);
          return matches.length ? matches.join('\n') : '(无命中)';
        }
        default:
          return `ERROR: 未知工具 ${toolCall.name}`;
      }
    } catch (e) {
      return `ERROR: ${String((e as { message?: unknown })?.message ?? e)}`;
    }
  };
}