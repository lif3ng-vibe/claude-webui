import { spawn, type ChildProcess } from 'node:child_process';

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

/** 从恢复的 session 流式返回的事件。 */
export type ClaudeRunEvent =
  | { type: 'stream-json'; data: unknown }   // stdout 的一行 stream-json 解析对象
  | { type: 'stderr'; text: string }          // 一行 stderr
  | { type: 'exit'; code: number | null };    // 进程退出

/**
 * 把 `claude --resume <sessionId> -p "<prompt>"` 包裹为**每条指令一次性**子进程，
 * 流式输出 `stream-json`。
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
    const args = ['--resume', req.sessionId, '-p', req.prompt, '--output-format', 'stream-json', '--verbose'];
    if (!req.allowedTools?.length) {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--allowed-tools', req.allowedTools.join(' '));
      if (req.disallowedTools?.length) args.push('--disallowed-tools', req.disallowedTools.join(' '));
    }
    if (req.model) args.push('--model', req.model);

    const child = spawn(this.claudeBin, args, { cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    yield* this.pump(child, req.signal);
  }

  /**
   * 对 stdout 按行缓冲（stream-json 每行一个 JSON 对象），逐行解析，
   * 并转发 stderr 与 exit。实现待补。
   */
  private async *pump(_child: ChildProcess, _signal?: AbortSignal): AsyncGenerator<ClaudeRunEvent> {
    throw new Error('ClaudeRunner.pump: 未实现（v1 骨架）');
  }
}