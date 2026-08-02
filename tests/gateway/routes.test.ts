import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleMessages, handleChatCompletions, resolveProviderByModel } from '../../src/gateway/routes.js';

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
        { id: 'p1', name: 'A', baseURL: 'https://up.a', apiKey: 'ka', model: 'claude-sonnet-5', type: 'anthropic' },
        { id: 'p2', name: 'B', baseURL: 'https://up.b', authToken: 'tb', model: 'gpt-x', type: 'openai' },
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
function stubFetch(bodyText: string, status = 200): { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const enc = new TextEncoder();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body?: string }) => {
      calls.push({ url, body: init?.body ?? '' });
      const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(bodyText)); c.close(); } });
      return { status, ok: status < 400, headers: new Map([['content-type', 'application/json']]), body: stream };
    }),
  );
  return { calls };
}

describe('resolveProviderByModel', () => {
  it('精确匹配 + 返回 type', async () => {
    await setupProviders();
    expect((await resolveProviderByModel('gpt-x'))?.id).toBe('p2');
    expect((await resolveProviderByModel('gpt-x'))?.type).toBe('openai');
    expect((await resolveProviderByModel('claude-sonnet-5'))?.type).toBe('anthropic');
  });
  it('无匹配用活动 provider', async () => {
    await setupProviders();
    expect((await resolveProviderByModel('unknown'))?.id).toBe('p1');
  });
  it('无 provider 返回 null', async () => {
    expect(await resolveProviderByModel('x')).toBeNull();
  });
});

describe('handleMessages（Anthropic 入参）', () => {
  it('同格式（anthropic 后端）透传', async () => {
    await setupProviders();
    const f = stubFetch(JSON.stringify({ id: 'm', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }));
    const m = mockRes();
    await handleMessages(mockReq(JSON.stringify({ model: 'claude-sonnet-5', messages: [] })), m.res);
    expect(m.status).toBe(200);
    expect(m.body).toContain('"type":"text"');
    expect(f.calls[0].url).toBe('https://up.a/v1/messages');
  });

  it('跨格式（openai 后端）转换：客户端收 Anthropic 风格', async () => {
    await setupProviders();
    stubFetch(JSON.stringify({ id: 'cc', model: 'gpt-x', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    const m = mockRes();
    await handleMessages(mockReq(JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })), m.res);
    expect(m.body).toContain('"type":"message"');
    expect(m.body).toContain('"text":"hello"');
    expect(m.body).toContain('"stop_reason"');
  });

  it('auth 失败 → 401', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ gatewayKey: 'k', providers: [{ id: 'p1', baseURL: 'https://x', apiKey: 'a', model: 'm', type: 'anthropic' }] }));
    stubFetch('{}');
    const m = mockRes();
    await handleMessages(mockReq(JSON.stringify({ model: 'm' })), m.res);
    expect(m.status).toBe(401);
  });

  it('无 provider → 503', async () => {
    stubFetch('{}');
    const m = mockRes();
    await handleMessages(mockReq(JSON.stringify({ model: 'm' })), m.res);
    expect(m.status).toBe(503);
  });
});

describe('handleChatCompletions（OpenAI 入参）', () => {
  it('同格式（openai 后端）透传', async () => {
    await setupProviders();
    const f = stubFetch(JSON.stringify({ id: 'cc', model: 'gpt-x', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }));
    const m = mockRes();
    await handleChatCompletions(mockReq(JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'x' }] })), m.res);
    expect(m.body).toContain('"choices"');
    expect(f.calls[0].url).toBe('https://up.b/v1/chat/completions');
  });

  it('跨格式（anthropic 后端）转换：客户端收 OpenAI 风格', async () => {
    await setupProviders();
    stubFetch(JSON.stringify({ id: 'm', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'world' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    const m = mockRes();
    await handleChatCompletions(mockReq(JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x' }] })), m.res);
    expect(m.body).toContain('"chat.completion"');
    expect(m.body).toContain('"content":"world"');
  });
});
