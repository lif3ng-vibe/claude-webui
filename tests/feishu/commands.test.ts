import { describe, it, expect } from 'vitest';
import { handleCommand } from '../../src/feishu/commands.js';
import { SessionState } from '../../src/feishu/SessionState.js';
import type { ClaudeFileReader } from '../../src/claude/FileReader.js';
import type { CommandContext } from '../../src/feishu/commands.js';

function mockReader(projects: any[], sessions: Record<string, any[]>): ClaudeFileReader {
  return {
    listProjects: async () => projects,
    listSessions: async (dir: string) => sessions[dir] ?? [],
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
