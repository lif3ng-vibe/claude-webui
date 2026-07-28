import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { loadConfig, stripModelSuffix, publicConfig } from '../src/config.js';

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
    expect(stripModelSuffix('m[1h]')).toBe('m');
  });

  it('环境变量优先于配置文件', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ model: 'from-file', anthropicBaseURL: 'http://file' }));
    process.env.ANTHROPIC_MODEL = 'from-env';
    const c = await loadConfig();
    expect(c.model).toBe('from-env');
    expect(c.anthropicBaseURL).toBe('http://file'); // env 未设时取文件
  });

  it('无 env 时回退到配置文件', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ model: 'file-model', anthropicBaseURL: 'http://file' }));
    const c = await loadConfig();
    expect(c.model).toBe('file-model');
    expect(c.anthropicBaseURL).toBe('http://file');
  });

  it('publicConfig 不暴露密钥', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'super-secret-token';
    process.env.ANTHROPIC_MODEL = 'glm-5.2:cloud[1m]';
    const p = await publicConfig();
    expect(p.hasAuth).toBe(true);
    expect(p.model).toBe('glm-5.2:cloud'); // 去后缀
    expect(JSON.stringify(p)).not.toContain('super-secret-token');
  });
});