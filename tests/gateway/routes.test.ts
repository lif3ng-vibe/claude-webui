import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleMessages, resolveProviderByModel } from '../../src/gateway/routes.js';

let dir: string;
let oldDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cwu-gw-route-'));
  oldDir = process.env.CLAUDE_WEBUI_DIR;
  process.env.CLAUDE_WEBUI_DIR = dir;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (oldDir === undefined) delete process.env.CLAUDE_WEBUI_DIR;
  else process.env.CLAUDE_WEBUI_DIR = oldDir;
  await rm(dir, { recursive: true, force: true });
});

async function setupProviders() {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      providers: [
        { id: 'p1', name: 'A', baseURL: 'https://up.a', apiKey: 'ka', model: 'claude-sonnet-5' },
        { id: 'p2', name: 'B', baseURL: 'https://up.b', authToken: 'tb', model: 'gpt-x' },
      ],
      activeProviderId: 'p1',
    }),
  );
}

function mockReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = headers;
  return r;
}

function mockRes(): { res: ServerResponse; status: number; body: string } {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (s: number) => {
      status = s;
    },
    write: (c: unknown) => {
      body += typeof c === 'string' ? c : Buffer.from(c as Uint8Array).toString();
    },
    end: (c?: unknown) => {
      if (c != null) body += typeof c === 'string' ? c : Buffer.from(c as Uint8Array).toString();
    },
  } as unknown as ServerResponse;
  return { res, get status() { return status; }, get body() { return body; } };
}

function stubFetch(bodyText: string, status = 200): void {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(bodyText));
      c.close();
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ status, ok: status < 400, headers: new Map([['content-type', 'application/json']]), body: stream })));
}

describe('resolveProviderByModel', () => {
  it('model 精确匹配', async () => {
    await setupProviders();
    expect(await resolveProviderByModel('gpt-x')).toBe('p2');
  });
  it('无匹配用活动 provider', async () => {
    await setupProviders();
    expect(await resolveProviderByModel('unknown-model')).toBe('p1');
  });
  it('无 provider 返回 null', async () => {
    expect(await resolveProviderByModel('x')).toBeNull();
  });
});

describe('handleMessages', () => {
  it('透传上游响应字节 + 记录（非流式）', async () => {
    await setupProviders();
    stubFetch(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }));
    const r = mockReq(JSON.stringify({ model: 'claude-sonnet-5', messages: [] }));
    const m = mockRes();
    await handleMessages(r, m.res);
    expect(m.status).toBe(200);
    expect(m.body).toContain('hi');
    // 记录写入
    const files = await readFile(join(dir, 'gateway', await firstLogId()), 'utf8');
    const log = JSON.parse(files);
    expect(log.providerId).toBe('p1');
    expect(log.status).toBe('ok');
    expect(log.response.usage.output_tokens).toBe(1);
  });

  it('上游 4xx 透传状态码 + 记录 error', async () => {
    await setupProviders();
    stubFetch(JSON.stringify({ type: 'error', error: { message: 'bad' } }), 400);
    const r = mockReq(JSON.stringify({ model: 'claude-sonnet-5' }));
    const m = mockRes();
    await handleMessages(r, m.res);
    expect(m.status).toBe(400);
  });

  it('auth 失败 → 401', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ gatewayKey: 'k', providers: [{ id: 'p1', baseURL: 'https://x', apiKey: 'a', model: 'm' }] }));
    stubFetch('{}');
    const r = mockReq(JSON.stringify({ model: 'm' }));
    const m = mockRes();
    await handleMessages(r, m.res);
    expect(m.status).toBe(401);
  });

  it('无 provider → 503', async () => {
    stubFetch('{}');
    const r = mockReq(JSON.stringify({ model: 'm' }));
    const m = mockRes();
    await handleMessages(r, m.res);
    expect(m.status).toBe(503);
  });
});

async function firstLogId(): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(join(dir, 'gateway'));
  return files[0];
}
