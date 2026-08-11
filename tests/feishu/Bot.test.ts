import { describe, it, expect, vi } from 'vitest';
import { FeishuBot } from '../../src/feishu/Bot.js';
import { SessionRunner } from '../../src/claude/SessionRunner.js';
import { SessionState } from '../../src/feishu/SessionState.js';
import type { ClaudeRunEvent, ClaudeRunRequest, ClaudeNewRequest } from '../../src/claude/Runner.js';
import type { FeishuSender } from '../../src/feishu/types.js';
import type { FeishuApp } from '../../src/feishu/feishuConfig.js';
import type { ClaudeFileReader } from '../../src/claude/FileReader.js';
import { runningPidsFor, killPid } from '../../src/claude/runningSessions.js';

vi.mock('../../src/claude/runningSessions.js', () => ({ runningPidsFor: vi.fn(async () => []), killPid: vi.fn(async () => true) }));

function mockSender(): { sender: FeishuSender; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const sender: FeishuSender = {
    sendCard: async (type, id, card) => {
      calls.push({ m: 'sendCard', type, id, card });
      return `msg_${calls.length}`;
    },
    patchCard: async (id, card) => {
      calls.push({ m: 'patchCard', id, card });
    },
    sendText: async (type, id, text) => {
      calls.push({ m: 'sendText', type, id, text });
    },
  };
  return { sender, calls };
}

function makeBot(opts: { events?: ClaudeRunEvent[]; newEvents?: ClaudeRunEvent[]; current?: { sessionId: string; dirName: string; cwd: string }; lock?: Set<string>; allowed?: string[]; boundSession?: { dirName: string; sessionId: string }; providerId?: string; onSetProvider?: (id: string | null) => Promise<void>; messages?: any[] } = {}) {
  const { sender, calls } = mockSender();
  const lock = opts.lock ?? new Set<string>();
  const events =
    opts.events ??
    [
      { type: 'stream-json', data: { type: 'assistant', message: { uuid: 'u1', content: [{ type: 'text', text: 'done' }] } } },
      { type: 'exit', code: 0 },
    ];
  const newEvents =
    opts.newEvents ??
    [
      { type: 'stream-json', data: { type: 'system', session_id: 'new-sess' } },
      { type: 'exit', code: 0 },
    ];
  const capturedNew: ClaudeNewRequest[] = [];
  const capturedRun: ClaudeRunRequest[] = [];
  const fakeRunner = {
    async *run(rq: ClaudeRunRequest): AsyncGenerator<ClaudeRunEvent> { capturedRun.push(rq); for (const e of events) yield e; },
    async *runNew(rq: ClaudeNewRequest): AsyncGenerator<ClaudeRunEvent> { capturedNew.push(rq); for (const e of newEvents) yield e; },
  };
  const sessionRunner = new SessionRunner(fakeRunner, lock);
  const state = new SessionState(() => 1000);
  if (opts.current) state.set(opts.current);
  const cfg: FeishuApp = { id: 'a1', appId: 'a', appSecret: 's', allowedUserIds: opts.allowed ? [...opts.allowed] : ['ou_me'], domain: 'feishu', enableNotify: true, boundSession: opts.boundSession, providerId: opts.providerId };
  const onFirstCalls: string[] = [];
  const reader = { listProjects: async () => [], listSessions: async () => [], getSessionCwd: async () => '/p', readSessionMessages: async () => opts.messages ?? [] } as unknown as ClaudeFileReader;
  const bot = new FeishuBot({
    reader,
    sessionRunner,
    state,
    config: cfg,
    sender,
    runner: fakeRunner,
    busySessionIds: () => new Set(lock),
    startListener: async () => {},
    now: () => 1000,
    onFirstUser: async (id: string) => {
      onFirstCalls.push(id);
    },
    providers: async () => [],
    onSetProvider: opts.onSetProvider,
  });
  return { bot, calls, state, lock, cfg, onFirstCalls, capturedNew, capturedRun };
}

describe('FeishuBot handleMessage', () => {
  it('非白名单 → 无权限文本', async () => {
    const { bot, calls } = makeBot();
    await bot.handleMessage({ openId: 'ou_other', text: 'hi', isMention: false });
    expect(calls[0]).toMatchObject({ m: 'sendText', id: 'ou_other' });
    expect(String(calls[0].text)).toContain('无权限');
  });

  it('/help → 帮助文本', async () => {
    const { bot, calls } = makeBot();
    await bot.handleMessage({ openId: 'ou_me', text: '/help', isMention: false });
    expect(calls[0].m).toBe('sendText');
    expect(String(calls[0].text)).toContain('/sessions');
  });

  it('续接 happy path：sendCard + patchCard 定稿', async () => {
    const { bot, calls } = makeBot({ current: { sessionId: 'abc-12345', dirName: 'd', cwd: '/p' } });
    await bot.handleMessage({ openId: 'ou_me', text: '请修复', isMention: false });
    expect(calls.some((c) => c.m === 'sendCard' && c.id === 'ou_me')).toBe(true);
    expect(calls.some((c) => c.m === 'patchCard')).toBe(true);
    const s = JSON.stringify(calls);
    expect(s).toContain('✅ 完成');
  });

  it('续接：未选 session 提示', async () => {
    const { bot, calls } = makeBot();
    await bot.handleMessage({ openId: 'ou_me', text: 'hi', isMention: false });
    expect(calls[0].m).toBe('sendText');
    expect(String(calls[0].text)).toContain('未选择');
  });

  it('续接：session 正忙 → busy 文本，不跑 runner', async () => {
    const lock = new Set(['abc-12345']);
    const { bot, calls } = makeBot({ current: { sessionId: 'abc-12345', dirName: 'd', cwd: '/p' }, lock });
    await bot.handleMessage({ openId: 'ou_me', text: 'hi', isMention: false });
    expect(calls.some((c) => c.m === 'sendText' && String(c.text).includes('正忙'))).toBe(true);
    expect(calls.some((c) => c.m === 'sendCard')).toBe(false);
  });

  it('续接：目标在别处运行（外部 claude）→ 拦截不 spawn', async () => {
    vi.mocked(runningPidsFor).mockResolvedValueOnce([1234]);
    const { bot, calls } = makeBot({ current: { sessionId: 'abc-12345', dirName: 'd', cwd: '/p' } });
    await bot.handleMessage({ openId: 'ou_me', text: 'hi', isMention: false });
    expect(calls.some((c) => c.m === 'sendText' && String(c.text).includes('另一个 claude 进程'))).toBe(true);
    expect(calls.some((c) => c.m === 'sendCard')).toBe(false);
  });

  it('/stop → 停止提示', async () => {
    const { bot, calls } = makeBot();
    await bot.handleMessage({ openId: 'ou_me', text: '/stop', isMention: false });
    expect(calls.some((c) => c.m === 'sendText' && String(c.text).includes('停止'))).toBe(true);
  });

  it('@ 占位被去除', async () => {
    const { bot, calls } = makeBot();
    await bot.handleMessage({ openId: 'ou_me', text: '@_user_1 /help', isMention: true });
    expect(calls[0].m).toBe('sendText');
    expect(String(calls[0].text)).toContain('/sessions');
  });

  it('status 默认 offline，start 后 online', async () => {
    const { bot } = makeBot();
    expect(bot.status()).toBe('offline');
    await bot.start();
    expect(bot.status()).toBe('online');
  });

  it('白名单空 → 首个发消息者被认作创建人', async () => {
    const { bot, cfg, onFirstCalls, calls } = makeBot({ allowed: [] });
    await bot.handleMessage({ openId: 'ou_first', text: '/help', isMention: false });
    expect(cfg.allowedUserIds).toContain('ou_first');
    expect(onFirstCalls).toEqual(['ou_first']);
    expect(calls.some((c) => c.m === 'sendText' && String(c.text).includes('创建人'))).toBe(true);
  });

  it('start 后给 owner 发上线消息', async () => {
    const { bot, calls } = makeBot();
    await bot.start();
    expect(calls.some((c) => c.m === 'sendText' && c.id === 'ou_me' && String(c.text).includes('已上线'))).toBe(true);
  });

  it('boundSession 启动时初始化 currentSession', async () => {
    const { bot, state } = makeBot({ boundSession: { dirName: 'd1', sessionId: 'abc-123' } });
    await bot.start();
    expect(state.current()).toEqual({ sessionId: 'abc-123', dirName: 'd1', cwd: '/p' });
  });

  it('/new <目录> <指令> 创建新 session 并设为当前', async () => {
    const { bot, state, calls } = makeBot({
      newEvents: [
        { type: 'stream-json', data: { type: 'system', session_id: 'new-xyz' } },
        { type: 'exit', code: 0 },
      ],
    });
    await bot.handleMessage({ openId: 'ou_me', text: '/new D:\\proj 跑测试', isMention: false });
    expect(state.current()?.sessionId).toBe('new-xyz');
    expect(state.current()?.cwd).toBe('D:\\proj');
    expect(calls.some((c) => c.m === 'sendCard')).toBe(true);
  });

  it('runNew 注入 app.providerId 的 env', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://env';
    const { bot, capturedNew } = makeBot({ providerId: 'p1' });
    await bot.handleMessage({ openId: 'ou_me', text: '/new D:\\proj hi', isMention: false });
    expect(capturedNew[0]?.env).toBeTruthy();
    expect(capturedNew[0]?.env?.ANTHROPIC_BASE_URL).toBe('http://env');
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('续接注入 app.providerId 的 env', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://env';
    const { bot, capturedRun } = makeBot({ providerId: 'p1', current: { sessionId: 'abc-12345', dirName: 'd', cwd: '/p' } });
    await bot.handleMessage({ openId: 'ou_me', text: '请修复', isMention: false });
    expect(capturedRun[0]?.env?.ANTHROPIC_BASE_URL).toBe('http://env');
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('/provider off 触发 onSetProvider(null)', async () => {
    const onSet: Array<string | null> = [];
    const { bot } = makeBot({ onSetProvider: async (id) => { onSet.push(id); } });
    await bot.handleMessage({ openId: 'ou_me', text: '/provider off', isMention: false });
    expect(onSet).toEqual([null]);
  });
});

describe('FeishuBot handleCardAction', () => {
  it('action=use → 切 session + 回确认卡', async () => {
    const { bot, state, calls } = makeBot();
    await bot.handleCardAction({
      value: { action: 'use', sessionId: 'sess-xyz', dirName: 'd', cwd: '/work' },
      openId: 'ou_me',
    });
    expect(state.current()).toEqual({ sessionId: 'sess-xyz', dirName: 'd', cwd: '/work' });
    expect(calls.some((c) => c.m === 'sendCard' && c.id === 'ou_me')).toBe(true);
    expect(JSON.stringify(calls)).toContain('已切换 session');
  });

  it('按钮切换回显上一轮（用户+agent 文本）', async () => {
    const { bot, calls } = makeBot({
      messages: [
        { type: 'user', message: { role: 'user', content: '老 prompt' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '老回复' }] } },
      ],
    });
    await bot.handleCardAction({
      value: { action: 'use', sessionId: 'sess-xyz', dirName: 'd', cwd: '/work' },
      openId: 'ou_me',
    });
    const card = calls.find((c) => c.m === 'sendCard')?.card;
    expect(JSON.stringify(card)).toContain('老 prompt');
    expect(JSON.stringify(card)).toContain('老回复');
  });

  it('非白名单 openId → 忽略（不切、不发卡）', async () => {
    const { bot, state, calls } = makeBot({ current: { sessionId: 'orig', dirName: 'd', cwd: '/p' } });
    await bot.handleCardAction({
      value: { action: 'use', sessionId: 'sess-xyz', dirName: 'd', cwd: '/work' },
      openId: 'ou_other',
    });
    expect(state.current()?.sessionId).toBe('orig');
    expect(calls.some((c) => c.m === 'sendCard')).toBe(false);
  });

  it('未知 action → 忽略', async () => {
    const { bot, state, calls } = makeBot();
    await bot.handleCardAction({ value: { action: 'nope' }, openId: 'ou_me' });
    expect(state.current()).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('action=page → 派发分页（空表回「没有可用」文本）', async () => {
    const { bot, calls } = makeBot();
    await bot.handleCardAction({ value: { action: 'page', page: 1 }, openId: 'ou_me' });
    expect(calls.some((c) => c.m === 'sendText' && String(c.text).includes('没有可用'))).toBe(true);
  });

  it('action=kill → killPid + set state + 回成功', async () => {
    vi.mocked(runningPidsFor).mockResolvedValueOnce([1234]);
    const { bot, state, calls } = makeBot();
    await bot.handleCardAction({ value: { action: 'kill', sessionId: 'sess-9', dirName: 'd', cwd: '/w' }, openId: 'ou_me' });
    expect(killPid).toHaveBeenCalledWith(1234);
    expect(state.current()?.sessionId).toBe('sess-9');
    expect(calls.some((c) => c.m === 'sendText' && String(c.text).includes('已结束'))).toBe(true);
  });

  it('use 到运行中 session → 回警告卡（不回确认卡）', async () => {
    vi.mocked(runningPidsFor).mockResolvedValueOnce([1234]);
    const { bot, calls } = makeBot();
    await bot.handleCardAction({ value: { action: 'use', sessionId: 's', dirName: 'd', cwd: '/w' }, openId: 'ou_me' });
    const card = calls.find((c) => c.m === 'sendCard')?.card;
    expect(JSON.stringify(card)).toContain('正在运行');
    expect(JSON.stringify(card)).not.toContain('已切换 session');
  });
});
