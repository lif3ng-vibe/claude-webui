import { open, readFile, readdir, stat } from 'node:fs/promises';
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
  /** 该目录下最新 session 的 mtime（ms），供“最近更新”排序，无需前端预加载 */
  latestMtimeMs: number;
}

/** 一个 session 文件（~/.claude/projects/<dirName>/<sessionId>.jsonl）。 */
export interface SessionEntry {
  sessionId: string;
  dirName: string;
  mtimeMs: number;
  size: number;
  /** 首条人类 prompt 的预览，用作可读标题（截断 ~120 字符）。 */
  preview: string;
  /** 最新 AI 标题（jsonl 最后一条 type:"ai-title" 的 aiTitle）；无则空串。 */
  title?: string;
}

/** 运行中的 Claude Code 会话状态（来自 ~/.claude/sessions/<pid>.json）。 */
export interface RunningSessionInfo {
  sessionId: string;
  /** 进程 pid（来自 json 的 pid 字段，兜底取文件名）。 */
  pid: number;
  cwd: string;
  status: string; // "busy" | "idle" | ...
  name?: string;
  updatedAt?: number;
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

  /** 该 reader 读取的 ~/.claude 根目录（供只读工具作用域使用）。 */
  claudeHome(): string {
    return this.claudeDir;
  }

  /** 当前正在运行的 Claude Code 会话（来自 ~/.claude/sessions/<pid>.json，进程退出后文件被清）。 */
  async getRunningSessions(): Promise<RunningSessionInfo[]> {
    const dir = join(this.claudeDir, 'sessions');
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const out: RunningSessionInfo[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(join(dir, f), 'utf8'));
        if (raw.sessionId) out.push({ sessionId: raw.sessionId, pid: Number(raw.pid) || Number(f.slice(0, -'.json'.length)) || 0, cwd: raw.cwd || '', status: raw.status || '', name: raw.name, updatedAt: raw.updatedAt });
      } catch {
        /* 跳过无法解析的文件 */
      }
    }
    return out;
  }

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
      const latestMtimeMs = sessions.length ? Math.max(...sessions.map((s) => s.mtimeMs)) : 0;
      out.push({ dirName, cwd, sessionCount: sessions.length, latestMtimeMs });
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
      const sessionId = f.slice(0, -'.jsonl'.length);
      out.push({
        sessionId,
        dirName,
        mtimeMs: s.mtimeMs,
        size: s.size,
        preview: await this.readSessionPreview(dirName, sessionId),
        title: await this.readLatestTitle(dirName, sessionId),
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

  /**
   * 读取首条人类 prompt 的预览（用作 session 可读标题）。
   * 只读文件前 256KB 以避免加载整条大 session；找不到则返回空串。
   */
  async readSessionPreview(dirName: string, sessionId: string, maxBytes = 262144): Promise<string> {
    const filePath = join(this.projectsDir(), dirName, `${sessionId}.jsonl`);
    let fh;
    try {
      fh = await open(filePath, 'r');
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      const chunk = buf.subarray(0, bytesRead).toString('utf8');
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        let raw: any;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        if (raw.type !== 'user' || raw.message?.role !== 'user') continue;
        const content = raw.message.content;
        const preview =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? (content.find((b: any) => b.type === 'text')?.text ?? '')
              : '';
        if (preview) return preview.slice(0, 120);
      }
      return '';
    } catch {
      return '';
    } finally {
      await fh?.close();
    }
  }

  /** 按 `${dirName}/${sessionId}` → {mtimeMs, title} 缓存，文件未变零开销。 */
  private readonly titleCache = new Map<string, { mtimeMs: number; title: string }>();

  /**
   * session 的最新 AI 标题：取 jsonl **最后一条** `type:"ai-title"` 的 `aiTitle`。
   * 只读文件尾部 ~256KB（标题随会话演进更新，最新一条靠近文件末尾），按 mtime 缓存。
   * 无则返回空串（前端兜底用 preview / sid）。
   */
  async readLatestTitle(dirName: string, sessionId: string, tailBytes = 262144): Promise<string> {
    const filePath = join(this.projectsDir(), dirName, `${sessionId}.jsonl`);
    let st;
    try {
      st = await stat(filePath);
    } catch {
      return '';
    }
    const key = `${dirName}/${sessionId}`;
    const cached = this.titleCache.get(key);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.title;
    const title = await this.scanLatestTitle(filePath, tailBytes);
    this.titleCache.set(key, { mtimeMs: st.mtimeMs, title });
    return title;
  }

  /** 扫文件尾部，返回最后一条 ai-title 的 aiTitle。首行可能被截断→JSON 解析失败跳过，无碍。 */
  private async scanLatestTitle(filePath: string, tailBytes: number): Promise<string> {
    let fh;
    try {
      fh = await open(filePath, 'r');
      const { size } = await fh.stat();
      const len = Math.min(size, tailBytes);
      const start = Math.max(0, size - tailBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      let last = '';
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        try {
          const raw = JSON.parse(line) as { type?: string; aiTitle?: string };
          if (raw.type === 'ai-title' && raw.aiTitle) last = raw.aiTitle;
        } catch {
          /* 跳过无法解析的行（含被尾部截断的首行） */
        }
      }
      return last;
    } catch {
      return '';
    } finally {
      await fh?.close();
    }
  }

  /** 该 session 的权威工作目录（从消息里的 `cwd` 字段读），用于续接时的子进程 cwd。 */
  async getSessionCwd(dirName: string, sessionId: string): Promise<string | undefined> {
    const msgs = await this.readSessionMessages(dirName, sessionId).catch(() => []);
    return msgs.find((m) => m.cwd)?.cwd;
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