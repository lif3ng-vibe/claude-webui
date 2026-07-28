import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { encodeCwd } from './pathEncoding.js';

/** 拥有 Claude Code session 的工作目录。 */
export interface ProjectEntry {
  /** ~/.claude/projects/ 下的编码目录名 */
  dirName: string;
  /** 权威 cwd，从 session jsonl 的 `cwd` 字段读取（兜底用 dirName） */
  cwd: string;
  sessionCount: number;
}

/** 一个 session 文件（~/.claude/projects/<dirName>/<sessionId>.jsonl）。 */
export interface SessionEntry {
  sessionId: string;
  dirName: string;
  mtimeMs: number;
  size: number;
}

/** session jsonl 的一行。结构宽松，Claude Code 会写多种 `type`。 */
export interface SessionMessage {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown };
  toolUseResult?: unknown;
  isSidechain?: boolean;
  /** 原始解析对象，供上面未提升的字段使用。 */
  raw: unknown;
}

/**
 * 只读访问 `~/.claude/projects/**`。
 *
 * 安全：本类不做任何写操作。它是读取 Claude 本地状态的唯一收口，
 * 因此保护措施（路径白名单、不碰密钥）都集中在这里。
 */
export class ClaudeFileReader {
  constructor(private readonly claudeDir: string = join(os.homedir(), '.claude')) {}

  projectsDir(): string {
    return join(this.claudeDir, 'projects');
  }

  /** 把 cwd 解析到其编码后的 projects 目录。 */
  projectDirForCwd(cwd: string): string {
    return join(this.projectsDir(), encodeCwd(cwd));
  }

  async listProjects(): Promise<ProjectEntry[]> {
    let entries: string[];
    try {
      entries = await readdir(this.projectsDir());
    } catch {
      return [];
    }
    const out: ProjectEntry[] = [];
    for (const dirName of entries) {
      const sessions = await this.listSessions(dirName);
      const cwd = await this.readCwd(dirName, sessions);
      out.push({ dirName, cwd, sessionCount: sessions.length });
    }
    return out;
  }

  async listSessions(dirName: string): Promise<SessionEntry[]> {
    const dir = join(this.projectsDir(), dirName);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const out: SessionEntry[] = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = join(dir, f);
      const s = await stat(filePath);
      out.push({
        sessionId: f.slice(0, -'.jsonl'.length),
        dirName,
        mtimeMs: s.mtimeMs,
        size: s.size,
      });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async readSessionMessages(dirName: string, sessionId: string): Promise<SessionMessage[]> {
    const filePath = join(this.projectsDir(), dirName, `${sessionId}.jsonl`);
    const text = await readFile(filePath, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const msgs: SessionMessage[] = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        msgs.push({
          type: raw.type,
          uuid: raw.uuid,
          parentUuid: raw.parentUuid,
          timestamp: raw.timestamp,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          message: raw.message,
          toolUseResult: raw.toolUseResult,
          isSidechain: raw.isSidechain,
          raw,
        });
      } catch {
        // 跳过无法解析的行，而不是让整个 session 失败
      }
    }
    return msgs;
  }

  /** 权威 cwd：该项目任意 session 中第一个带 `cwd` 字段的消息。 */
  private async readCwd(dirName: string, sessions: SessionEntry[]): Promise<string> {
    for (const s of sessions) {
      const msgs = await this.readSessionMessages(dirName, s.sessionId).catch(() => []);
      const withCwd = msgs.find((m) => m.cwd);
      if (withCwd?.cwd) return withCwd.cwd;
    }
    return dirName; // 没有 jsonl 带 cwd 字段时兜底
  }
}