import type { ClaudeRunEvent, ClaudeRunRequest } from './Runner.js';

/** 续接任务的来源——通知模块据此判断是否推送（飞书来源不重复推）。 */
export type RunSource = 'web' | 'terminal' | 'feishu';

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  error?: string;
  /** true=因 session 已被占用而未运行（不跑 runner）。 */
  busy?: boolean;
  /** true=被 AbortSignal 终止（如 /stop 或客户端断开）；通知应跳过。 */
  aborted?: boolean;
}

export interface RunLifecycle {
  source: RunSource;
  /** 每个事件（stream-json/stderr/exit）回调。 */
  onEvent?: (e: ClaudeRunEvent) => void;
  /** 任务结束回调（含 busy 与 aborted 情形）。 */
  onDone?: (info: RunResult) => void;
}

/** runner 的最小依赖（结构类型），便于测试注入 fake，不强耦合 ClaudeRunner。 */
export interface RunnerLike {
  run(req: ClaudeRunRequest): AsyncGenerator<ClaudeRunEvent>;
}

/**
 * 共享锁驱动器：把「按 sessionId 加锁 → 跑 runner → 逐事件回调 → 释放锁 → lifecycle/done」
 * 封装起来。web SSE、飞书卡片、本地通知都经此，避免三处各写一遍锁与生命周期逻辑。
 *
 * 锁语义：非阻塞——session 已占用即返回 { ok:false, busy:true }，不排队（与现有 handleRun 409 一致）。
 * 完成钩子 onFinished 每次结束都触发；通知模块用它推送**非飞书来源**的任务完成/出错。
 */
export class SessionRunner {
  private readonly runner: RunnerLike;
  private readonly lockSet: Set<string>;
  /** 全局完成钩子（通知订阅）。 */
  onFinished?: (info: RunResult, source: RunSource, req: ClaudeRunRequest) => void;

  constructor(runner: RunnerLike, lockSet: Set<string>) {
    this.runner = runner;
    this.lockSet = lockSet;
  }

  /** 该 session 是否正被占用（飞书 /use 前的忙闲判断也用它）。 */
  isBusy(sessionId: string): boolean {
    return this.lockSet.has(sessionId);
  }

  async runLocked(req: ClaudeRunRequest, lc: RunLifecycle): Promise<RunResult> {
    if (this.lockSet.has(req.sessionId)) {
      const busy: RunResult = { ok: false, exitCode: null, busy: true, error: '该 session 正忙' };
      lc.onDone?.(busy);
      this.onFinished?.(busy, lc.source, req);
      return busy;
    }
    this.lockSet.add(req.sessionId);
    let result: RunResult = { ok: true, exitCode: null };
    try {
      for await (const ev of this.runner.run(req)) {
        lc.onEvent?.(ev);
        if (ev.type === 'exit') {
          result = { ok: ev.code === 0, exitCode: ev.code, error: ev.code !== 0 ? `exit ${ev.code}` : undefined };
        }
      }
    } catch (e) {
      result = { ok: false, exitCode: null, error: String(e) };
    } finally {
      this.lockSet.delete(req.sessionId);
    }
    // runner 正常结束但无 exit 事件，或被 abort（exit code=null）：按 signal 判定 aborted。
    if (req.signal?.aborted) {
      result = { ...result, aborted: true };
    }
    lc.onDone?.(result);
    this.onFinished?.(result, lc.source, req);
    return result;
  }
}
