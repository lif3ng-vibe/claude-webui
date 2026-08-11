import type { ClaudeFileReader } from '../claude/FileReader.js';
import type { ClaudeRunEvent, ClaudeNewRequest } from '../claude/Runner.js';
import { extractSessionId } from '../claude/Runner.js';
import { encodeCwd } from '../claude/pathEncoding.js';
import { SessionRunner } from '../claude/SessionRunner.js';
import { providerEnv } from '../config.js';
import { handleCommand, readLastTurn, useConfirmCard, useBusyCard, buildSessionsPage } from './commands.js';
import { runningPidsFor, killPid } from '../claude/runningSessions.js';
import { createAccumulator, toCard, Throttle } from './formatter.js';
import { SessionState } from './SessionState.js';
import type { FeishuApp } from './feishuConfig.js';
import type { FeishuSender } from './types.js';

/** 已解析的飞书消息事件（由 server 把 lark 原始事件转成这个）。 */
export interface BotMessageEvent {
  openId: string;
  chatId?: string;
  text: string;
  isMention: boolean;
}

/** 飞书卡片按钮点击事件（由 larkAdapter 把 card.action.trigger 转成这个）。 */
export interface CardActionEvent {
  /** 按钮的 value 载荷（如 { action:'use', sessionId, dirName, cwd }）。 */
  value: unknown;
  /** 点击者 open_id。 */
  openId: string;
  chatId?: string;
}

export interface BotDeps {
  reader: ClaudeFileReader;
  sessionRunner: SessionRunner;
  state: SessionState;
  config: FeishuApp;
  sender: FeishuSender;
  /** 用于 /new 创建新 session（不经 SessionRunner 锁，Bot 内 newLock 防并发）。 */
  runner: { runNew(req: ClaudeNewRequest): AsyncGenerator<ClaudeRunEvent> };
  busySessionIds: () => Set<string>;
  /** 白名单为空时，首个发消息者被认作创建人；此回调持久化其 open_id。 */
  onFirstUser?: (openId: string) => Promise<void>;
  /** /provider 命令改 provider 后持久化（server 注入 saveFeishuApps 封装）。 */
  onSetProvider?: (providerId: string | null) => Promise<void>;
  /** provider 列表（/provider 无参展示用）；server 注入 publicConfig.providers。 */
  providers?: () => Promise<Array<{ id: string; name?: string }>>;
  /** 启动事件监听（生产用 lark.ws.Client；测试注入 mock）。onMessage 收消息，onCardAction 收卡片按钮点击。 */
  startListener: (
    onMessage: (ev: BotMessageEvent) => void,
    onCardAction: (ev: CardActionEvent) => void,
  ) => Promise<void>;
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
    // 绑定 session 初始化当前 session（解析权威 cwd）；未绑定则留空，靠命令 /use 切换。
    const b = this.deps.config.boundSession;
    if (b && !this.deps.state.current()) {
      const cwd = await this.deps.reader.getSessionCwd(b.dirName, b.sessionId).catch(() => undefined);
      if (cwd) this.deps.state.set({ sessionId: b.sessionId, dirName: b.dirName, cwd });
    }
    await this.deps.startListener(
      (ev) => {
        void this.handleMessage(ev);
      },
      (ev) => {
        void this.handleCardAction(ev);
      },
    );
    this.online = true;
    // 上线后给创建人（白名单首位）私聊一条，确认连接成功。
    const owner = this.deps.config.allowedUserIds[0];
    if (owner) {
      await this.deps.sender
        .sendText('open_id', owner, '🤖 飞书机器人已上线。发送 /help 查看命令，或直接发文本续接当前 session。')
        .catch(() => {});
    }
  }

  async stop(): Promise<void> {
    await this.deps.stopListener?.();
    this.online = false;
  }

  async handleMessage(ev: BotMessageEvent): Promise<void> {
    const openId = ev.openId;
    const allowed = this.deps.config.allowedUserIds;
    if (allowed.length === 0) {
      // 白名单空：首个发消息者认作创建人（owner），入白名单 + 持久化，然后继续处理本条消息。
      allowed.push(openId);
      try {
        await this.deps.onFirstUser?.(openId);
      } catch {
        /* 持久化失败不阻断当次回复 */
      }
      await this.deps.sender.sendText('open_id', openId, '已将你认作创建人并加入白名单。发送 /help 查看命令。').catch(() => {});
    } else if (!allowed.includes(openId)) {
      await this.deps.sender.sendText('open_id', openId, '无权限：你不在白名单内。').catch(() => {});
      return;
    }
    const clean = stripMention(ev.text).trim();
    if (!clean) return;

    if (clean.startsWith('/')) {
      const providers = await this.deps.providers?.().catch(() => []) ?? [];
      const result = await handleCommand(clean, {
        reader: this.deps.reader,
        state: this.deps.state,
        busySessionIds: this.deps.busySessionIds,
        providers,
        currentProviderId: this.deps.config.providerId,
      });
      if (result.kind === 'stop') {
        this.currentAbort?.abort();
        await this.deps.sender.sendText('open_id', openId, '已请求停止当前任务。').catch(() => {});
        return;
      }
      if (result.kind === 'new-session') {
        await this.runNew(openId, result.cwd, result.prompt);
        return;
      }
      if (result.kind === 'set-provider') {
        this.deps.config.providerId = result.providerId ?? undefined;
        try { await this.deps.onSetProvider?.(result.providerId); } catch { /* 持久化失败不阻断回复 */ }
        await this.deps.sender
          .sendText('open_id', openId, result.providerId ? `已切换 provider：${result.providerId}` : '已清除 provider，用 env 默认')
          .catch(() => {});
        return;
      }
      if (result.kind === 'reply') await this.deps.sender.sendCard('open_id', openId, result.card).catch(() => {});
      else if (result.kind === 'reply-text') await this.deps.sender.sendText('open_id', openId, result.text).catch(() => {});
      return;
    }
    await this.runContinue(openId, clean);
  }

  /**
   * 卡片按钮点击：action==='use' 等价 /use——切当前 session 并回确认卡。
   * 权限：白名单非空时点击者须在名单内；名单空（尚未认主）放行。
   */
  async handleCardAction(ev: CardActionEvent): Promise<void> {
    const openId = ev.openId;
    const allowed = this.deps.config.allowedUserIds;
    if (allowed.length > 0 && !allowed.includes(openId)) return;
    const v = ev.value as { action?: string; sessionId?: string; dirName?: string; cwd?: string; page?: unknown; dirFilter?: unknown } | undefined;
    if (!v?.action) return;
    if (v.action === 'use') {
      if (typeof v.sessionId !== 'string') return;
      const target = { sessionId: v.sessionId, dirName: v.dirName ?? '', cwd: v.cwd ?? '' };
      this.deps.state.set(target);
      const pids = await runningPidsFor(this.deps.reader, target.sessionId);
      if (pids.length) {
        await this.deps.sender.sendCard('open_id', openId, useBusyCard(target, pids)).catch(() => {});
        return;
      }
      const last = await readLastTurn(this.deps.reader, target.dirName, target.sessionId);
      await this.deps.sender.sendCard('open_id', openId, useConfirmCard(target, last)).catch(() => {});
      return;
    }
    if (v.action === 'page') {
      // 翻页：重渲指定页（顺带刷新整表 mtime 排序 + 序号索引）。
      const page = Number(v.page) || 1;
      const dirFilter = typeof v.dirFilter === 'string' ? v.dirFilter : '';
      const result = await buildSessionsPage(
        { reader: this.deps.reader, state: this.deps.state, busySessionIds: this.deps.busySessionIds },
        page,
        dirFilter,
      );
      if (result.kind === 'reply') await this.deps.sender.sendCard('open_id', openId, result.card).catch(() => {});
      else if (result.kind === 'reply-text') await this.deps.sender.sendText('open_id', openId, result.text).catch(() => {});
      return;
    }
    if (v.action === 'kill') {
      // 接管：kill 该 session 的其它运行 pid，使飞书成为唯一写入者（防分叉）。
      if (typeof v.sessionId !== 'string') return;
      const target = { sessionId: v.sessionId, dirName: v.dirName ?? '', cwd: v.cwd ?? '' };
      const pids = await runningPidsFor(this.deps.reader, target.sessionId);
      const killed: number[] = [];
      for (const pid of pids) if (await killPid(pid)) killed.push(pid);
      this.deps.state.set(target);
      console.error(`[feishu-card] card action kill -> ${target.sessionId.slice(0, 8)} pids=[${pids.join(',')}] killed=[${killed.join(',')}] by ${openId}`);
      const text = killed.length
        ? `✅ 已结束 PID ${killed.join(', ')}。现在由飞书独占，发消息即可续接。`
        : '该 session 当前没在运行（或已退出），可直接发消息续接。';
      await this.deps.sender.sendText('open_id', openId, text).catch(() => {});
    }
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
    // 防分叉：目标 session 未被本应用占用、却在别处（外部 claude）跑着 → 不 spawn，提示先 kill 接管。
    // （被本应用占用时交给下面 runLocked 的 busy 分支处理，避免误拦自己的并发。）
    if (!this.deps.busySessionIds().has(cur.sessionId)) {
      const extPids = await runningPidsFor(this.deps.reader, cur.sessionId);
      if (extPids.length) {
        await sender
          .sendText('open_id', openId, `该 session 正在另一个 claude 进程运行（PID ${extPids.join(', ')}），并发续接会分叉。先用 /use 查看、点「结束它并由飞书接管」再发。`)
          .catch(() => {});
        return;
      }
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

    const env = await providerEnv(this.deps.config.providerId);
    const result = await this.deps.sessionRunner.runLocked(
      { sessionId: cur.sessionId, cwd: cur.cwd, prompt, env, signal: ac.signal },
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

  private newLock = new Set<string>();

  /** /new：在指定 cwd 创建新 session，跑首条指令，结束后把新 session 设为当前。 */
  private async runNew(openId: string, cwd: string, prompt: string): Promise<void> {
    const sender = this.deps.sender;
    if (this.newLock.has(cwd)) {
      await sender.sendText('open_id', openId, '该目录正在创建新 session，请稍候。').catch(() => {});
      return;
    }
    this.newLock.add(cwd);
    const ac = new AbortController();
    this.currentAbort = ac;
    const acc = createAccumulator();
    const throttle = new Throttle(PATCH_INTERVAL_MS);
    const startedAt = this.now();
    let messageId: string | null = null;
    let newSessionId: string | null = null;
    const title = `new · ${prompt.slice(0, 30)}`;

    const sendPatch = async (status: 'running' | 'done' | 'error'): Promise<void> => {
      const card = toCard(acc, { title, status, cwd, elapsedMs: this.now() - startedAt });
      if (!messageId) messageId = await sender.sendCard('open_id', openId, card);
      else await sender.patchCard(messageId, card);
    };

    try {
      const env = await providerEnv(this.deps.config.providerId);
      for await (const ev of this.deps.runner.runNew({ cwd, prompt, env, signal: ac.signal })) {
        acc.accumulate(ev);
        if (!newSessionId && ev.type === 'stream-json') newSessionId = extractSessionId(ev.data);
        const t = this.now();
        if (throttle.shouldRun(t)) {
          throttle.mark(t);
          void this.serial(() => sendPatch('running'));
        }
      }
      if (newSessionId) this.deps.state.set({ sessionId: newSessionId, dirName: encodeCwd(cwd), cwd });
      await this.serial(() => sendPatch(newSessionId ? 'done' : 'error'));
    } catch {
      await this.serial(() => sendPatch('error')).catch(() => {});
    } finally {
      this.newLock.delete(cwd);
      this.currentAbort = null;
    }
  }
}
