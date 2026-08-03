import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testProvider } from '../../src/gateway/test.js';

let dir: string;
let oldDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cwu-gw-test-'));
  oldDir = process.env.CLAUDE_WEBUI_DIR;
  process.env.CLAUDE_WEBUI_DIR = dir;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (oldDir === undefined) delete process.env.CLAUDE_WEBUI_DIR;
  else process.env.CLAUDE_WEBUI_DIR = oldDir;
  await rm(dir, { recursive: true, force: true });
});

async function cfg(providers: unknown[]) {
  await writeFile(join(dir, 'config.json'), JSON.stringify({ providers, activeProviderId: (providers[0] as { id?: string })?.id }));
}
function stubFetch(respJson: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status, ok: status < 400, text: async () => JSON.stringify(respJson) })));
}

describe('testProvider', () => {
  it('无 provider → ok:false', async () => {
    expect((await testProvider()).ok).toBe(false);
  });

  it('anthropic provider → ok + content', async () => {
    await cfg([{ id: 'p1', baseURL: 'https://up', apiKey: 'k', model: 'm', type: 'anthropic' }]);
    stubFetch({ content: [{ type: 'text', text: 'OK' }], model: 'm', usage: { input_tokens: 5, output_tokens: 2 } });
    const r = await testProvider();
    expect(r.ok).toBe(true);
    expect(r.content).toBe('OK');
    expect(r.usage?.output_tokens).toBe(2);
  });

  it('openai provider → 转换后 ok', async () => {
    await cfg([{ id: 'p1', baseURL: 'https://up', apiKey: 'k', model: 'm', type: 'openai' }]);
    stubFetch({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
    const r = await testProvider();
    expect(r.ok).toBe(true);
    expect(r.content).toBe('OK');
  });

  it('上游非 2xx → ok:false + error', async () => {
    await cfg([{ id: 'p1', baseURL: 'https://up', apiKey: 'k', model: 'm' }]);
    stubFetch({ error: 'bad' }, 500);
    const r = await testProvider();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('500');
  });
});
