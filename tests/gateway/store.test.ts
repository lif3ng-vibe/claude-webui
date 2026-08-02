import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveLog, type GatewayLog } from '../../src/gateway/recorder.js';
import { listLogs, getLog, removeLog } from '../../src/gateway/store.js';
import { checkGatewayAuth } from '../../src/gateway/auth.js';

let dir: string;
let oldDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cwu-gateway-'));
  oldDir = process.env.CLAUDE_WEBUI_DIR;
  process.env.CLAUDE_WEBUI_DIR = dir;
});
afterEach(async () => {
  if (oldDir === undefined) delete process.env.CLAUDE_WEBUI_DIR;
  else process.env.CLAUDE_WEBUI_DIR = oldDir;
  await rm(dir, { recursive: true, force: true });
});

function mkLog(over: Partial<GatewayLog> = {}): GatewayLog {
  return { id: 'l1', createdAt: 100, providerId: 'p1', model: 'm', stream: false, request: {}, elapsedMs: 5, status: 'ok', ...over };
}

describe('gateway store', () => {
  it('save 后 list/get 命中，按 createdAt 倒序', async () => {
    await saveLog(mkLog({ id: 'a', createdAt: 100 }));
    await saveLog(mkLog({ id: 'b', createdAt: 200 }));
    const list = await listLogs();
    expect(list.map((l) => l.id)).toEqual(['b', 'a']);
    expect((await getLog('a'))?.id).toBe('a');
  });

  it('remove 后 get 返回 null', async () => {
    await saveLog(mkLog({ id: 'a' }));
    await removeLog('a');
    expect(await getLog('a')).toBeNull();
  });

  it('空目录 list 返回 []', async () => {
    expect(await listLogs()).toEqual([]);
  });
});

describe('gateway auth', () => {
  it('未配置 gatewayKey 一律放行', async () => {
    expect(await checkGatewayAuth({})).toBe(true);
  });

  it('配了 key：x-api-key 匹配放行，不符拒绝', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ gatewayKey: 'secret' }));
    expect(await checkGatewayAuth({ 'x-api-key': 'secret' })).toBe(true);
    expect(await checkGatewayAuth({ 'x-api-key': 'wrong' })).toBe(false);
    expect(await checkGatewayAuth({})).toBe(false);
  });

  it('Authorization: Bearer 也接受', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ gatewayKey: 'secret' }));
    expect(await checkGatewayAuth({ authorization: 'Bearer secret' })).toBe(true);
  });
});
