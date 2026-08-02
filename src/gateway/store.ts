import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '../config.js';
import type { GatewayLog } from './recorder.js';

const dir = (): string => join(configDir(), 'gateway');

/** 列出所有中转记录，按 createdAt 倒序。 */
export async function listLogs(): Promise<GatewayLog[]> {
  let files: string[];
  try {
    files = await readdir(dir());
  } catch {
    return [];
  }
  const logs: GatewayLog[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      logs.push(JSON.parse(await readFile(join(dir(), f), 'utf8')) as GatewayLog);
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return logs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getLog(id: string): Promise<GatewayLog | null> {
  try {
    return JSON.parse(await readFile(join(dir(), `${id}.json`), 'utf8')) as GatewayLog;
  } catch {
    return null;
  }
}

export async function removeLog(id: string): Promise<void> {
  try {
    await unlink(join(dir(), `${id}.json`));
  } catch {
    /* 忽略不存在 */
  }
}
