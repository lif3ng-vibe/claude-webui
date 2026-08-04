import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { writeProviderSettings, delProviderSettings } from '../../src/claude/providerSettings.js';

describe('providerSettings', () => {
  it('写临时 settings 文件内容为 {"env":{...}}，删除后不存在', async () => {
    const file = await writeProviderSettings({ ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_MODEL: 'm' });
    const content = await readFile(file, 'utf8');
    expect(JSON.parse(content)).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_MODEL: 'm' } });
    await delProviderSettings(file);
    await expect(access(file)).rejects.toThrow();
  });

  it('delProviderSettings 对不存在的文件不抛', async () => {
    await expect(delProviderSettings('C:\\nonexistent-xyz-12345.json')).resolves.toBeUndefined();
  });
});