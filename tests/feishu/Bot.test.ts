import { describe, it, expect } from 'vitest';
import { FeishuBot } from '../../src/feishu/Bot.js';
import { SessionRunner } from '../../src/claude/SessionRunner.js';
import { SessionState } from '../../src/feishu/SessionState.js';
import type { ClaudeRunEvent, ClaudeRunRequest } from '../../src/claude/Runner.js';
import type { FeishuSender } from '../../src/feishu/types.js';
import type { FeishuApp } from '../../src/feishu/feishuConfig.js';
import type { ClaudeFileReader } from '../../src/claude/FileReader.js';

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

function makeBot(opts: { events?: ClaudeRunEvent[]; newEvents?: ClaudeRunEvent[]; current?: { sessionId: string; dirName: string; cwd: string }; lock?: Set<string>; allowed?: string[]; boundSession?: { dirName: string; sessionId: string } } = {}) {
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
  const fakeRunner = {
    async *run(_req: ClaudeRunRequest): AsyncGenerator<ClaudeRunEvent> {
      for (const e of events) yield e;
    },
    async *runNew(): AsyncGenerator<ClaudeRunEvent> {
      for (const e of newEvents) yield e;
    },
  };
  const sessionRunner = new SessionRunner(fakeRunner, lock);
  const state = new SessionState(() => 1000);
  if (opts.current) state.set(opts.current);
  const cfg: FeishuApp = { id: 'a1', appId: 'a', appSecret: 's', allowedUserIds: opts.allowed ? [...opts.allowed] : ['ou_me'], domain: 'feishu', enableNotify: true, boundSession: opts.boundSession };
  const onFirstCalls: string[] = [];
  const reader = { listProjects: async () => [], listSessions: async () => [], getSessionCwd: async () => '/p' } as unknown as ClaudeFileReader;
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
  });
  return { bot, calls, state, lock, cfg, onFirstCalls };
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
});
