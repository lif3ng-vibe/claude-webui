import type { ClaudeFileReader } from '../claude/FileReader.js';
import type { ClaudeRunEvent } from '../claude/Runner.js';
import { SessionRunner } from '../claude/SessionRunner.js';
import { handleCommand } from './commands.js';
import { createAccumulator, toCard, Throttle } from './formatter.js';
import { SessionState } from './SessionState.js';
import type { FeishuConfig } from './feishuConfig.js';
import type { FeishuSender } from './types.js';

/** 已解析的飞书消息事件（由 server 把 lark 原始事件转成这个）。 */
export interface BotMessageEvent {
  openId: string;
  chatId?: string;
  text: string;
  isMention: boolean;
}

export interface BotDeps {
  reader: ClaudeFileReader;
  sessionRunner: SessionRunner;
  state: SessionState;
  config: FeishuConfig;
  sender: FeishuSender;
  busySessionIds: () => Set<string>;
  /** 启动事件监听（生产用 lark.ws.Client；测试注入 mock）。handler 收已解析事件。 */
  startListener: (handler: (ev: BotMessageEvent) => void) => Promise<void>;
  stopListener?: () => Promise<void>;
  now?: () => number;
}

/** 流式 patch 最小间隔（避开飞书消息更新限流）。 */
const PATCH_INTERVAL_MS = 1200;

/** 去掉飞书 @ 占位（@_user_N）。 */
function stripMention(text: string): string {
  return text.replace(/@_user_\d+/g, '').trim();
}

/**
 * 飞书机器人。长连接由 deps.startListener 提供（生产=飞书 ws.Client），
 * 本类只负责：白名单校验 → 命令分流 / 续接流式卡片。纯逻辑，便于单测。
 */
export class FeishuBot {
  private online = false;
  private currentAbort: AbortController | null = null;
  private patchQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: BotDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  status(): 'online' | 'offline' {
    return this.online ? 'online' : 'offline';
  }

  async start(): Promise<void> {
    await this.deps.startListener((ev) => {
      void this.handleMessage(ev);
    });
    this.online = true;
  }

  async stop(): Promise<void> {
    await this.deps.stopListener?.();
    this.online = false;
  }

  async handleMessage(ev: BotMessageEvent): Promise<void> {
    const openId = ev.openId;
    if (!this.deps.config.allowedUserIds.includes(openId)) {
      await this.deps.sender.sendText('open_id', openId, '无权限：你不在白名单内。').catch(() => {});
      return;
    }
    const clean = stripMention(ev.text).trim();
    if (!clean) return;

    if (clean.startsWith('/')) {
      const result = await handleCommand(clean, {
        reader: this.deps.reader,
        state: this.deps.state,
        busySessionIds: this.deps.busySessionIds,
      });
      if (result.kind === 'stop') {
        this.currentAbort?.abort();
        await this.deps.sender.sendText('open_id', openId, '已请求停止当前任务。').catch(() => {});
        return;
      }
      if (result.kind === 'reply') await this.deps.sender.sendCard('open_id', openId, result.card).catch(() => {});
      else if (result.kind === 'reply-text') await this.deps.sender.sendText('open_id', openId, result.text).catch(() => {});
      return;
    }
    await this.runContinue(openId, clean);
  }

  /** 串行化 patch，避免并发 sendCard/patchCard 竞态（messageId 首次设置）。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.patchQueue.then(fn, fn) as Promise<T>;
    this.patchQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async runContinue(openId: string, prompt: string): Promise<void> {
    const cur = this.deps.state.current();
    const sender = this.deps.sender;
    if (!cur) {
      await sender.sendText('open_id', openId, '未选择 session。用 /sessions 查看，/use <序号> 切换。').catch(() => {});
      return;
    }
    const ac = new AbortController();
    this.currentAbort = ac;
    const acc = createAccumulator();
    const throttle = new Throttle(PATCH_INTERVAL_MS);
    const startedAt = this.now();
    let messageId: string | null = null;
    const title = `${cur.sessionId.slice(0, 8)} · ${prompt.slice(0, 30)}`;

    const sendPatch = async (status: 'running' | 'done' | 'error'): Promise<void> => {
      const card = toCard(acc, { title, status, cwd: cur.cwd, elapsedMs: this.now() - startedAt });
      if (!messageId) messageId = await sender.sendCard('open_id', openId, card);
      else await sender.patchCard(messageId, card);
    };

    const result = await this.deps.sessionRunner.runLocked(
      { sessionId: cur.sessionId, cwd: cur.cwd, prompt, signal: ac.signal },
      {
        source: 'feishu',
        onEvent: (e: ClaudeRunEvent) => {
          acc.accumulate(e);
          const t = this.now();
          if (throttle.shouldRun(t)) {
            throttle.mark(t);
            void this.serial(() => sendPatch('running'));
          }
        },
      },
    );
    this.currentAbort = null;

    if (result.busy) {
      await sender.sendText('open_id', openId, '该 session 正忙（被 web/终端占用），请先在那边结束。').catch(() => {});
      return;
    }
    // 收尾定稿（排在流式 patch 之后）
    await this.serial(() => sendPatch(result.ok ? 'done' : 'error')).catch(() => {});
  }
}
