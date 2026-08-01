import { describe, it, expect } from 'vitest';
import { FeishuBot } from '../../src/feishu/Bot.js';
import { SessionRunner } from '../../src/claude/SessionRunner.js';
import { SessionState } from '../../src/feishu/SessionState.js';
import { Notifier } from '../../src/feishu/Notifier.js';
import type { ClaudeRunEvent, ClaudeRunRequest } from '../../src/claude/Runner.js';
import type { FeishuSender } from '../../src/feishu/types.js';
import type { FeishuConfig } from '../../src/feishu/feishuConfig.js';
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

const config: FeishuConfig = { appId: 'a', appSecret: 's', allowedUserIds: ['ou_me'], domain: 'feishu', enableNotify: true };

function makeBot(opts: { events?: ClaudeRunEvent[]; current?: { sessionId: string; dirName: string; cwd: string }; lock?: Set<string> } = {}) {
  const { sender, calls } = mockSender();
  const lock = opts.lock ?? new Set<string>();
  const events =
    opts.events ??
    [
      { type: 'stream-json', data: { type: 'assistant', message: { uuid: 'u1', content: [{ type: 'text', text: 'done' }] } } },
      { type: 'exit', code: 0 },
    ];
  const fakeRunner = {
    async *run(_req: ClaudeRunRequest): AsyncGenerator<ClaudeRunEvent> {
      for (const e of events) yield e;
    },
  };
  const sessionRunner = new SessionRunner(fakeRunner, lock);
  const state = new SessionState(() => 1000);
  if (opts.current) state.set(opts.current);
  const notifier = new Notifier(sender, {});
  const reader = { listProjects: async () => [], listSessions: async () => [] } as unknown as ClaudeFileReader;
  const bot = new FeishuBot({
    reader,
    sessionRunner,
    state,
    notifier,
    config,
    sender,
    busySessionIds: () => new Set(lock),
    startListener: async () => {},
    now: () => 1000,
  });
  return { bot, calls, state, lock };
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
});
