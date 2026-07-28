import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { loadConfig, stripModelSuffix, publicConfig, saveProviders, resolveProvider } from '../src/config.js';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'] as const;
let dir = '';
let saved: Record<string, string | undefined> = {};

describe('config', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(os.tmpdir(), 'cwu-cfg-'));
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.CLAUDE_WEBUI_DIR = dir;
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete process.env.CLAUDE_WEBUI_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('stripModelSuffix 去掉 [1m] 之类后缀', () => {
    expect(stripModelSuffix('glm-5.2:cloud[1m]')).toBe('glm-5.2:cloud');
    expect(stripModelSuffix('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('loadConfig 只读配置文件', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ activeProviderId: 'p1', providers: [{ id: 'p1', name: 'P1', baseURL: 'http://x', model: 'm[1m]' }] }));
    const c = await loadConfig();
    expect(c.providers?.[0].id).toBe('p1');
    expect(c.activeProviderId).toBe('p1');
  });

  it('publicConfig 含 env provider、去后缀、不暴露密钥', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'super-secret';
    process.env.ANTHROPIC_BASE_URL = 'http://env';
    process.env.ANTHROPIC_MODEL = 'glm-5.2:cloud[1m]';
    const p = await publicConfig();
    const env = p.providers.find((x) => x.id === 'env');
    expect(env).toBeTruthy();
    expect(env?.model).toBe('glm-5.2:cloud');
    expect(env?.hasAuth).toBe(true);
    expect(JSON.stringify(p)).not.toContain('super-secret');
    expect(p.activeProviderId).toBe('env');
  });

  it('saveProviders 持久化 + 密钥留空保留已有值', async () => {
    await saveProviders([{ id: 'p1', name: 'P1', baseURL: 'http://x', authToken: 'tok-1', model: 'm' }], 'p1');
    await saveProviders([{ id: 'p1', name: 'P1', baseURL: 'http://x', authToken: '', model: 'm' }], 'p1');
    const cfg = await resolveProvider('p1');
    expect(cfg.authToken).toBe('tok-1');
    expect(cfg.defaultModel).toBe('m');
  });

  it('resolveProvider 回退 env', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://env';
    process.env.ANTHROPIC_AUTH_TOKEN = 't';
    process.env.ANTHROPIC_MODEL = 'glm-5.2:cloud[1m]';
    const cfg = await resolveProvider(undefined);
    expect(cfg.baseURL).toBe('http://env');
    expect(cfg.defaultModel).toBe('glm-5.2:cloud');
  });
});