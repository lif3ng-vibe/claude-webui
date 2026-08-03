import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** 用一条指令续接一个 Claude Code session 的请求。 */
export interface ClaudeRunRequest {
  /** 要恢复的 session。 */
  sessionId: string;
  /** session 的工作目录——作为子进程 cwd，并用于定位 jsonl。 */
  cwd: string;
  /** 要发送的指令。 */
  prompt: string;
  /** 允许的工具。为空（默认）=> `--dangerously-skip-permissions`。 */
  allowedTools?: string[];
  /** 禁止的工具（仅当 allowedTools 非空时才有意义）。 */
  disallowedTools?: string[];
  /** 覆盖模型。 */
  model?: string;
  /** 中断底层进程。 */
  signal?: AbortSignal;
}

/** 创建新 session 的请求（不续接，在指定 cwd 启动新 Claude Code session）。 */
export interface ClaudeNewRequest {
  cwd: string;
  prompt: string;
  model?: string;
  signal?: AbortSignal;
}

/** 从恢复的 session 流式返回的事件。 */
export type ClaudeRunEvent =
  | { type: 'stream-json'; data: unknown }   // stdout 的一行 stream-json 解析对象
  | { type: 'stderr'; text: string }          // 一行 stderr
  | { type: 'exit'; code: number | null };    // 进程退出

/** 把一行 stream-json 文本解析为对象；空行或无法解析返回 { ok: false }。 */
export function parseStreamJsonLine(line: string): { ok: true; data: unknown } | { ok: false } {
  if (!line.trim()) return { ok: false };
  try {
    return { ok: true, data: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

/**
 * 把任意子进程的事件流式产出：stdout 按行解析为 `stream-json`（解析失败则跳过），
 * stderr 按行转发，最后产出 `exit`。与具体命令无关，便于用任意子进程测试。
 */
export async function* streamChildEvents(
  child: ChildProcess,
  signal?: AbortSignal,
): AsyncGenerator<ClaudeRunEvent> {
  const q = new AsyncQueue<ClaudeRunEvent>();

  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', (line: string) => {
      const parsed = parseStreamJsonLine(line);
      if (parsed.ok) q.push({ type: 'stream-json', data: parsed.data });
    });
  }
  if (child.stderr) {
    createInterface({ input: child.stderr }).on('line', (line: string) => {
      if (line.trim()) q.push({ type: 'stderr', text: line });
    });
  }

  let exitCode: number | null = null;
  let closed = false;
  const finish = (code: number | null, err?: string) => {
    if (closed) return;
    closed = true;
    if (err) q.push({ type: 'stderr', text: err });
    q.push({ type: 'exit', code });
    q.close();
  };
  child.on('exit', (code) => { exitCode = code; });
  child.on('close', () => finish(exitCode));
  child.on('error', (err) => finish(null, String(err)));

  const onAbort = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  };
  signal?.addEventListener('abort', onAbort);

  try {
    yield* q;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      child.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 把 `claude --resume <sessionId> -p` 包裹为**每条指令一次性**子进程，
 * 流式输出 `stream-json`；prompt 经 stdin 传入。
 *
 * 设计要点（见 docs/design.md）：
 *  - `--resume` 默认沿用同一 sessionId（不 fork）；`--fork-session` 才新建。
 *  - 没有 allowedTools 时传 `--dangerously-skip-permissions`，让 session 无人值守
 *    运行（`-p` 模式下没有人去确认权限弹窗）。
 *  - 调用方须按 sessionId 加锁，避免两个写入者并发追加同一 session
 *    （那才是真正导致分叉的原因）。
 */
export class ClaudeRunner {
  constructor(private readonly claudeBin = 'claude') {}

  async *run(req: ClaudeRunRequest): AsyncGenerator<ClaudeRunEvent> {
    const args = ['--resume', req.sessionId, '-p', '--output-format', 'stream-json', '--verbose'];
    if (!req.allowedTools?.length) {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--allowed-tools', req.allowedTools.join(' '));
      if (req.disallowedTools?.length) args.push('--disallowed-tools', req.disallowedTools.join(' '));
    }
    if (req.model) args.push('--model', req.model);

    // Windows 上 claude 是 claude.cmd 垫片，spawn 需要 shell:true 才能解析。
    // prompt 走 stdin 而非参数，避免 shell 注入（参数只剩 sessionId 与安全 flag）。
    // 已知限制：shell:true 下 child.kill 不一定杀掉 cmd 包裹的 node 进程，
    // 因此 Windows 上"停止"可能要等当前轮结束后才真正退出。
    const child = spawn(this.claudeBin, args, {
      cwd: req.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' },
    });
    if (child.stdin) {
      child.stdin.write(req.prompt);
      child.stdin.end();
    }
    yield* streamChildEvents(child, req.signal);
  }

  /**
   * 在指定 cwd 启动**新** session（不带 --resume），prompt 经 stdin。
   * 与 run() 的区别仅是不传 --resume/sessionId；新 session 的 id 从 stream-json 事件里提取。
   */
  async *runNew(req: ClaudeNewRequest): AsyncGenerator<ClaudeRunEvent> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (req.model) args.push('--model', req.model);
    const child = spawn(this.claudeBin, args, {
      cwd: req.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' },
    });
    if (child.stdin) {
      child.stdin.write(req.prompt);
      child.stdin.end();
    }
    yield* streamChildEvents(child, req.signal);
  }
}

/** 单消费者异步队列：把多个事件源（stdout/stderr/exit）汇成一条有序流。 */
class AsyncQueue<T> {
  private buf: T[] = [];
  private waiters: Array<(v: { done: false; value: T } | { done: true; value: undefined }) => void> = [];
  private closed = false;

  push(value: T): void {
    const w = this.waiters.shift();
    if (w) w({ done: false, value });
    else this.buf.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ done: true, value: undefined });
  }

  private next(): Promise<{ done: false; value: T } | { done: true; value: undefined }> {
    if (this.buf.length) return Promise.resolve({ done: false, value: this.buf.shift()! });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const r = await this.next();
      if (r.done) return;
      yield r.value;
    }
  }
}