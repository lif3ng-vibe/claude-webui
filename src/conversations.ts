import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './config.js';

/** 一条对话消息（chat 为字符串；study 为 Anthropic 风格 blocks 数组）。 */
export interface ConvMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

/** 持久化的对话（chat 或 study）。 */
export interface Conversation {
  id: string;
  kind: 'chat' | 'study';
  title: string;
  systemPrompt?: string;
  model?: string;
  providerId?: string;
  cwd?: string;
  studySessionId?: string;
  messages: ConvMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary {
  id: string;
  kind: 'chat' | 'study';
  title: string;
  updatedAt: number;
}

const dir = (): string => join(configDir(), 'conversations');
const path = (id: string): string => join(dir(), `${id}.json`);

/** 对话存储：每条一个 JSON 文件，存于 ~/.claude-webui/conversations/。 */
class ConversationsStore {
  async list(): Promise<ConversationSummary[]> {
    let files: string[];
    try {
      files = await readdir(dir());
    } catch {
      return [];
    }
    const out: ConversationSummary[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(await readFile(join(dir(), f), 'utf8')) as Conversation;
        out.push({ id: c.id, kind: c.kind, title: c.title, updatedAt: c.updatedAt });
      } catch {
        /* 跳过无法解析的文件 */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Conversation | null> {
    try {
      return JSON.parse(await readFile(path(id), 'utf8')) as Conversation;
    } catch {
      return null;
    }
  }

  async save(c: Conversation): Promise<void> {
    await mkdir(dir(), { recursive: true });
    await writeFile(path(c.id), JSON.stringify(c, null, 2), 'utf8');
  }

  async remove(id: string): Promise<void> {
    try {
      await rm(path(id));
    } catch {
      /* 文件不存在 */
    }
  }
}

export const conversations = new ConversationsStore();