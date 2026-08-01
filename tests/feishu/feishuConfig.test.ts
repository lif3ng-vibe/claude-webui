import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFeishu, publicFeishu, saveFeishu } from '../../src/feishu/feishuConfig.js';

let dir: string;
let oldDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cwu-feishu-'));
  oldDir = process.env.CLAUDE_WEBUI_DIR;
  process.env.CLAUDE_WEBUI_DIR = dir;
});

afterEach(async () => {
  if (oldDir === undefined) delete process.env.CLAUDE_WEBUI_DIR;
  else process.env.CLAUDE_WEBUI_DIR = oldDir;
  await rm(dir, { recursive: true, force: true });
});

describe('feishuConfig', () => {
  it('空配置：load/public 都返回 null', async () => {
    expect(await loadFeishu()).toBeNull();
    expect(await publicFeishu()).toBeNull();
  });

  it('save 后 public 不含 secret 且 hasSecret=true', async () => {
    await saveFeishu({ appId: 'cli_x', appSecret: 's3cr3t', allowedUserIds: ['ou_a'] });
    const pub = await publicFeishu();
    expect(pub).not.toBeNull();
    expect(pub!.hasSecret).toBe(true);
    expect(JSON.stringify(pub!)).not.toContain('s3cr3t');
    expect(pub!.appId).toBe('cli_x');
    expect(pub!.allowedUserIds).toEqual(['ou_a']);
  });

  it('save 时 appSecret 留空保留旧值', async () => {
    await saveFeishu({ appId: 'cli_x', appSecret: 's3cr3t' });
    await saveFeishu({ appId: 'cli_x', appSecret: '' });
    const cfg = await loadFeishu();
    expect(cfg!.appSecret).toBe('s3cr3t');
  });

  it('load 返回完整配置（含 secret）', async () => {
    await saveFeishu({ appId: 'cli_x', appSecret: 's3cr3t', domain: 'lark', enableNotify: false });
    const cfg = await loadFeishu();
    expect(cfg!.appSecret).toBe('s3cr3t');
    expect(cfg!.domain).toBe('lark');
    expect(cfg!.enableNotify).toBe(false);
  });

  it('appId 缺失（即使有 secret）视为未配置', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ feishu: { appSecret: 'x' } }));
    expect(await loadFeishu()).toBeNull();
  });

  it('domain 默认 feishu', async () => {
    await saveFeishu({ appId: 'cli_x', appSecret: 's' });
    expect((await loadFeishu())!.domain).toBe('feishu');
  });
});
