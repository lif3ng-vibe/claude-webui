import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '../config.js';

/** 一条中转请求记录。 */
export interface GatewayLog {
  id: string;
  createdAt: number;
  providerId: string;
  model: string;
  stream: boolean;
  request: Record<string, unknown>;
  response?: {
    content?: unknown[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    model?: string;
  };
  elapsedMs: number;
  status: 'ok' | 'error';
  error?: string;
}

const dir = (): string => join(configDir(), 'gateway');

/** 写一条中转记录到 ~/.claude-webui/gateway/<id>.json。 */
export async function saveLog(log: GatewayLog): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(join(dir(), `${log.id}.json`), JSON.stringify(log, null, 2), 'utf8');
}
