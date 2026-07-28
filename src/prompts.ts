import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './config.js';

/** 预置系统提示词。 */
export interface PresetPrompt {
  id: string;
  title: string;
  text: string;
}

const promptsPath = (): string => join(configDir(), 'prompts.json');

const DEFAULTS: PresetPrompt[] = [
  {
    id: 'explain-step',
    title: '解释某一步',
    text: '你是一个资深工程师。我会给你 Claude Code session 里的某一步（用户指令或工具调用），请结合磁盘上的真实文件，解释它为什么这么做、做了什么、有没有更好的做法。',
  },
  {
    id: 'code-review',
    title: '代码审查',
    text: '你是严格但务实的代码审查者。指出正确性、安全、可读性问题，按严重程度排序，给出具体修复建议和代码片段。',
  },
  {
    id: 'summarize',
    title: '归纳 session',
    text: '把以下对话/操作归纳为要点：目标、关键决策、结果、遗留问题。用中文，简洁。',
  },
];

/** 预置提示词的读写存储（~/.claude-webui/prompts.json）。 */
export class PromptsStore {
  async list(): Promise<PresetPrompt[]> {
    let arr: PresetPrompt[];
    try {
      arr = JSON.parse(await readFile(promptsPath(), 'utf8'));
    } catch {
      arr = DEFAULTS.slice();
      await this.persist(arr); // 首次读取时落盘默认项
    }
    return arr;
  }

  async upsert(p: PresetPrompt): Promise<PresetPrompt[]> {
    const arr = await this.list();
    const i = arr.findIndex((x) => x.id === p.id);
    if (i >= 0) arr[i] = p;
    else arr.push(p);
    await this.persist(arr);
    return arr;
  }

  async remove(id: string): Promise<PresetPrompt[]> {
    const arr = (await this.list()).filter((x) => x.id !== id);
    await this.persist(arr);
    return arr;
  }

  private async persist(arr: PresetPrompt[]): Promise<void> {
    await mkdir(configDir(), { recursive: true });
    await writeFile(promptsPath(), JSON.stringify(arr, null, 2), 'utf8');
  }
}