import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFeishuApps, publicFeishuApps, saveFeishuApps } from '../../src/feishu/feishuConfig.js';

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

describe('feishuConfig (apps 数组)', () => {
  it('空配置：load/publicFeishuApps 都返回 []', async () => {
    expect(await loadFeishuApps()).toEqual([]);
    expect(await publicFeishuApps()).toEqual([]);
  });

  it('save 多 app 后 load 回来（含 boundSession）', async () => {
    await saveFeishuApps([
      { id: 'a1', appId: 'cli_1', appSecret: 's1', allowedUserIds: ['ou_a'], domain: 'feishu', enableNotify: true },
      { id: 'a2', appId: 'cli_2', appSecret: 's2', allowedUserIds: [], domain: 'lark', enableNotify: false, boundSession: { dirName: 'd1', sessionId: 'sx' } },
    ]);
    const apps = await loadFeishuApps();
    expect(apps).toHaveLength(2);
    expect(apps[0].appId).toBe('cli_1');
    expect(apps[1].domain).toBe('lark');
    expect(apps[1].boundSession).toEqual({ dirName: 'd1', sessionId: 'sx' });
  });

  it('public 不含 secret 且 hasSecret=true', async () => {
    await saveFeishuApps([{ id: 'a1', appId: 'cli_1', appSecret: 's3cr3t', allowedUserIds: [], domain: 'feishu', enableNotify: true }]);
    const pub = await publicFeishuApps();
    expect(pub).toHaveLength(1);
    expect(JSON.stringify(pub)).not.toContain('s3cr3t');
    expect(pub[0].hasSecret).toBe(true);
  });

  it('save 时 appSecret 留空保留旧值', async () => {
    await saveFeishuApps([{ id: 'a1', appId: 'cli_1', appSecret: 's3cr3t', allowedUserIds: [], domain: 'feishu', enableNotify: true }]);
    await saveFeishuApps([{ id: 'a1', appId: 'cli_1', appSecret: '', allowedUserIds: [], domain: 'feishu', enableNotify: true }]);
    expect((await loadFeishuApps())[0].appSecret).toBe('s3cr3t');
  });

  it('旧单 app 配置自动迁移为 [single]', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ feishu: { appId: 'cli_old', appSecret: 'so', domain: 'feishu', enableNotify: true } }));
    const apps = await loadFeishuApps();
    expect(apps).toHaveLength(1);
    expect(apps[0].appId).toBe('cli_old');
  });

  it('apps 里 appId/appSecret 缺失的条目被过滤', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ feishu: { apps: [{ id: 'a1', appSecret: 's' }, { id: 'a2', appId: 'cli', appSecret: 's2' }] } }));
    const apps = await loadFeishuApps();
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('a2');
  });
});
