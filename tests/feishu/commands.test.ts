import { describe, it, expect, vi } from 'vitest';
import { handleCommand, extractLastTurn, buildSessionsPage } from '../../src/feishu/commands.js';
import { runningPidsFor } from '../../src/claude/runningSessions.js';

vi.mock('../../src/claude/runningSessions.js', () => ({ runningPidsFor: vi.fn(async () => []), killPid: vi.fn() }));
import { SessionState } from '../../src/feishu/SessionState.js';
import type { ClaudeFileReader } from '../../src/claude/FileReader.js';
import type { CommandContext } from '../../src/feishu/commands.js';

function mockReader(projects: any[], sessions: Record<string, any[]>, msgs: any[] = []): ClaudeFileReader {
  return {
    listProjects: async () => projects,
    listSessions: async (dir: string) => sessions[dir] ?? [],
    readSessionMessages: async () => msgs,
  } as unknown as ClaudeFileReader;
}

function ctx(
  reader: ClaudeFileReader,
  state = new SessionState(),
  busy: string[] = [],
  providers: Array<{ id: string; name?: string }> = [],
  currentProviderId?: string,
  matchProvider?: (q: string) => Promise<string | undefined>,
): CommandContext {
  return { reader, state, busySessionIds: () => new Set(busy), providers, currentProviderId, matchProvider };
}

describe('commands handleCommand', () => {
  it('/help 回复帮助', async () => {
    const r = await handleCommand('/help', ctx(mockReader([], {})));
    expect(r.kind).toBe('reply-text');
    expect((r as { text: string }).text).toContain('/sessions');
  });

  it('/sessions 列出并写序号索引', async () => {
    const state = new SessionState();
    const reader = mockReader(
      [{ dirName: 'd1', cwd: '/p1', sessionCount: 2, latestMtimeMs: 0 }],
      {
        d1: [
          { sessionId: 'abc-123', dirName: 'd1', mtimeMs: 0, size: 0, preview: 'fix bug' },
          { sessionId: 'def-456', dirName: 'd1', mtimeMs: 0, size: 0, preview: 'add feat' },
        ],
      },
    );
    const r = await handleCommand('/sessions', ctx(reader, state));
    expect(r.kind).toBe('reply');
    const s = JSON.stringify((r as { card: unknown }).card);
    expect(s).toContain('fix bug');
    expect(s).toContain('共 2 个');
    expect(state.getByIndex(1)?.sessionId).toBe('abc-123');
    expect(state.getByIndex(2)?.sessionId).toBe('def-456');
  });

  it('/sessions 卡片含「进入会话」按钮，value 带 sessionId', async () => {
    const reader = mockReader(
      [{ dirName: 'd1', cwd: '/p1', sessionCount: 1, latestMtimeMs: 0 }],
      { d1: [{ sessionId: 'abc-123', dirName: 'd1', mtimeMs: 0, size: 0, preview: 'fix bug' }] },
    );
    const r = await handleCommand('/sessions', ctx(reader, new SessionState()));
    expect(r.kind).toBe('reply');
    const card = (r as { card: { elements?: Array<Record<string, unknown>> } }).card;
    const actions = (card.elements ?? []).filter((e) => e.tag === 'action');
    expect(actions.length).toBe(1);
    const btn = (actions[0].actions as Array<Record<string, unknown>>)[0];
    expect(btn.tag).toBe('button');
    expect(String((btn.text as { content?: string }).content)).toContain('进入会话');
    expect((btn.value as { action?: string }).action).toBe('use');
    expect((btn.value as { sessionId?: string }).sessionId).toBe('abc-123');
  });

  it('/sessions 全局按最后更新时间(mtime)降序', async () => {
    const reader = mockReader(
      [{ dirName: 'd1', cwd: '/p1', sessionCount: 2, latestMtimeMs: 0 }],
      {
        d1: [
          { sessionId: 'older-1', dirName: 'd1', mtimeMs: 1, size: 0, preview: 'old' },
          { sessionId: 'newer-9', dirName: 'd1', mtimeMs: 9, size: 0, preview: 'new' },
        ],
      },
    );
    const state = new SessionState();
    await handleCommand('/sessions', ctx(reader, state));
    expect(state.getByIndex(1)?.sessionId).toBe('newer-9');
    expect(state.getByIndex(2)?.sessionId).toBe('older-1');
  });

  it('buildSessionsPage：首页有「下一页」无「上一页」，末页反之', async () => {
    const sessions = Array.from({ length: 11 }, (_, i) => ({ sessionId: `s${i}`, dirName: 'd1', mtimeMs: i, size: 0, preview: `p${i}` }));
    const reader = mockReader([{ dirName: 'd1', cwd: '/p', sessionCount: 11, latestMtimeMs: 0 }], { d1: sessions });
    const deps = { reader, state: new SessionState(), busySessionIds: () => new Set<string>() };
    const p1 = await buildSessionsPage(deps, 1, '');
    const c1 = JSON.stringify((p1 as { card: unknown }).card);
    expect(c1).toContain('下一页');
    expect(c1).not.toContain('上一页');
    const p2 = await buildSessionsPage(deps, 2, '');
    const c2 = JSON.stringify((p2 as { card: unknown }).card);
    expect(c2).toContain('上一页');
    expect(c2).not.toContain('下一页');
  });

  it('/sessions 标记忙闲', async () => {
    const reader = mockReader(
      [{ dirName: 'd1', cwd: '/p1', sessionCount: 1, latestMtimeMs: 0 }],
      { d1: [{ sessionId: 'abc-123', dirName: 'd1', mtimeMs: 0, size: 0, preview: 'x' }] },
    );
    const r = await handleCommand('/sessions', ctx(reader, new SessionState(), ['abc-123']));
    expect(JSON.stringify((r as { card: unknown }).card)).toContain('🟢忙');
  });

  it('/use <序号> 切换', async () => {
    const state = new SessionState();
    state.setIndex([{ sessionId: 'abc-123', dirName: 'd1', cwd: '/p1' }]);
    const r = await handleCommand('/use 1', ctx(mockReader([], {}), state));
    expect(r.kind).toBe('reply');
    expect(state.current()?.sessionId).toBe('abc-123');
  });

  it('/use <前缀> 切换', async () => {
    const state = new SessionState();
    state.setIndex([{ sessionId: 'abc-123', dirName: 'd1', cwd: '/p1' }]);
    await handleCommand('/use abc', ctx(mockReader([], {}), state));
    expect(state.current()?.sessionId).toBe('abc-123');
  });

  it('/use 序号未建索引提示重新列出', async () => {
    const r = await handleCommand('/use 1', ctx(mockReader([], {}), new SessionState()));
    expect(r.kind).toBe('reply-text');
    expect((r as { text: string }).text).toContain('重新 /sessions');
  });

  it('/use 切换后确认卡回显上一轮（用户+agent 文本）', async () => {
    const state = new SessionState();
    state.setIndex([{ sessionId: 'abc-123', dirName: 'd1', cwd: '/p1' }]);
    const reader = mockReader([], {}, [
      { type: 'user', message: { role: 'user', content: '帮我修 bug' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已修复' }] } },
    ]);
    const r = await handleCommand('/use 1', ctx(reader, state));
    expect(r.kind).toBe('reply');
    const s = JSON.stringify((r as { card: unknown }).card);
    expect(s).toContain('帮我修 bug');
    expect(s).toContain('已修复');
  });

  it('/use 到运行中的 session → 警告卡含「结束它」kill 按钮', async () => {
    vi.mocked(runningPidsFor).mockResolvedValueOnce([1234]);
    const state = new SessionState();
    state.setIndex([{ sessionId: 'abc-123', dirName: 'd1', cwd: '/p1' }]);
    const r = await handleCommand('/use 1', ctx(mockReader([], {}), state));
    expect(r.kind).toBe('reply');
    const s = JSON.stringify((r as { card: unknown }).card);
    expect(s).toContain('正在运行');
    expect(s).toContain('1234');
    expect(s).toContain('"action":"kill"');
  });

  it('extractLastTurn：取最后人类文本 + 最后 assistant 文本，跳过 tool_result', () => {
    const msgs = [
      { message: { role: 'user', content: 'first' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
      { message: { role: 'user', content: 'second prompt' } },
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'final ans' }] } },
    ];
    expect(extractLastTurn(msgs)).toEqual({ userText: 'second prompt', agentText: 'final ans' });
  });

  it('/info 未选提示', async () => {
    const r = await handleCommand('/info', ctx(mockReader([], {})));
    expect(r.kind).toBe('reply-text');
    expect((r as { text: string }).text).toContain('未选择');
  });

  it('/info 已选显示 cwd', async () => {
    const state = new SessionState();
    state.set({ sessionId: 'abc-123', dirName: 'd1', cwd: '/p1' });
    const r = await handleCommand('/info', ctx(mockReader([], {}), state));
    expect(r.kind).toBe('reply');
    expect(JSON.stringify((r as { card: unknown }).card)).toContain('/p1');
  });

  it('/stop 返回 stop 标记', async () => {
    const r = await handleCommand('/stop', ctx(mockReader([], {})));
    expect(r.kind).toBe('stop');
  });

  it('未知命令', async () => {
    const r = await handleCommand('/xyz', ctx(mockReader([], {})));
    expect(r.kind).toBe('reply-text');
    expect((r as { text: string }).text).toContain('未知命令');
  });

  it('非命令（纯文本）返回 none', async () => {
    const r = await handleCommand('hello world', ctx(mockReader([], {})));
    expect(r.kind).toBe('none');
  });

  it('/new <目录> <指令> 返回 new-session', async () => {
    const r = await handleCommand('/new D:\\proj 跑测试', ctx(mockReader([], {})));
    expect(r).toEqual({ kind: 'new-session', cwd: 'D:\\proj', prompt: '跑测试' });
  });

  it('/new 缺目录/指令提示用法', async () => {
    expect((await handleCommand('/new', ctx(mockReader([], {})))).kind).toBe('reply-text');
    expect((await handleCommand('/new D:\\proj', ctx(mockReader([], {})))).kind).toBe('reply-text');
  });

  it('/provider 无参列出并标记当前', async () => {
    const r = await handleCommand('/provider', ctx(mockReader([], {}), new SessionState(), [], [{ id: 'p1', name: '生产' }, { id: 'p2', name: '测试' }], 'p1'));
    expect(r.kind).toBe('reply');
    expect(JSON.stringify((r as { card: unknown }).card)).toContain('生产');
    expect(JSON.stringify((r as { card: unknown }).card)).toContain('当前');
  });

  it('/provider <名称> 返回 set-provider（注入 matchProvider，不读盘）', async () => {
    const fake = async (q: string) => (q === '测试' ? 'p2' : undefined);
    const r = await handleCommand('/provider 测试', ctx(mockReader([], {}), new SessionState(), [], [], undefined, fake));
    expect(r).toEqual({ kind: 'set-provider', providerId: 'p2' });
  });

  it('/provider off 清除', async () => {
    const r = await handleCommand('/provider off', ctx(mockReader([], {})));
    expect(r).toEqual({ kind: 'set-provider', providerId: null });
  });

  it('/provider 未命中提示', async () => {
    const fake = async () => undefined;
    const r = await handleCommand('/provider nope', ctx(mockReader([], {}), new SessionState(), [], [], undefined, fake));
    expect(r.kind).toBe('reply-text');
  });
});
