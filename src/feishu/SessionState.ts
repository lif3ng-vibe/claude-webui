/** 当前选中的 Claude Code session（飞书命令切换的目标）。 */
export interface CurrentSession {
  sessionId: string;
  /** ~/.claude/projects 下的编码目录名。 */
  dirName: string;
  /** session 权威工作目录（续接子进程的 cwd）。 */
  cwd: string;
}

/** 序号→session 映射的有效期；超过则 /use <序号> 失效，需重新 /sessions。 */
const INDEX_TTL_MS = 5 * 60 * 1000;

/**
 * 飞书机器人的全局当前 session 状态。
 *
 * 设计（见 spec §3 决策 3）：当前 session 为**全局单一**；用命令切换。
 * /sessions 列出 session 时把序号→session 写入短期缓存，便于 /use 3 这种简写；
 * 缓存带 TTL，过期后强制重新 /sessions（避免列了之后 session 列表变化导致误选）。
 */
export class SessionState {
  private cur: CurrentSession | null = null;
  private index: CurrentSession[] = [];
  private indexAt = 0;
  private readonly now: () => number;

  /** now 可注入固定时钟，便于测试 TTL。 */
  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  current(): CurrentSession | null {
    return this.cur;
  }

  set(s: CurrentSession | null): void {
    this.cur = s;
  }

  /** 写入 /sessions 的序号映射并刷新 TTL。 */
  setIndex(entries: CurrentSession[]): void {
    this.index = entries.slice();
    this.indexAt = this.now();
  }

  /** 序号从 1；越界或缓存过期返回 null。 */
  getByIndex(n: number): CurrentSession | null {
    if (n < 1 || this.expired()) return null;
    return this.index[n - 1] ?? null;
  }

  /** 按 sessionId 前缀匹配（遍历当前缓存 + current，不依赖 TTL）。 */
  findByPrefix(prefix: string): CurrentSession | null {
    if (!prefix) return null;
    const hit = this.index.find((e) => e.sessionId.startsWith(prefix));
    if (hit) return hit;
    if (this.cur && this.cur.sessionId.startsWith(prefix)) return this.cur;
    return null;
  }

  private expired(): boolean {
    return this.now() - this.indexAt > INDEX_TTL_MS;
  }
}
