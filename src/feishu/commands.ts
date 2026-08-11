import type { ClaudeFileReader } from '../claude/FileReader.js';
import type { SessionState, CurrentSession } from './SessionState.js';
import type { FeishuCard } from './types.js';
import { matchProvider } from '../config.js';
import { runningPidsFor } from '../claude/runningSessions.js';

export interface CommandContext {
  reader: ClaudeFileReader;
  state: SessionState;
  /** 当前被锁占用的 sessionId 集合（忙闲标记用）。 */
  busySessionIds: () => Set<string>;
  /** 可选 provider 列表（/provider 无参时展示）。 */
  providers?: Array<{ id: string; name?: string }>;
  /** 当前 provider id（/provider 标记当前用）。 */
  currentProviderId?: string;
  /** 名称/id 匹配；默认用 config.matchProvider（读盘）。测试可注入 fake 避免读盘。 */
  matchProvider?: (query: string) => Promise<string | undefined>;
}

export type CommandResult =
  | { kind: 'reply'; card: FeishuCard }
  | { kind: 'reply-text'; text: string }
  | { kind: 'new-session'; cwd: string; prompt: string }
  | { kind: 'set-provider'; providerId: string | null }
  | { kind: 'stop' }
  | { kind: 'none' };

const PAGE_SIZE = 10;

const HELP_TEXT = [
  '飞书机器人命令：',
  '/sessions [目录关键字|页码] — 列出 session（用序号选择）',
  '/use <序号|sessionId 前缀> — 切换当前 session',
  '/info — 查看当前 session',
  '/new <目录> <指令> — 在指定目录创建新 session',
  '/provider [名称|id|off] — 设置本机器人使用的 provider',
  '/stop — 停止当前任务',
  '/help — 本帮助',
  '',
  '直接发文本（非 / 开头）= 续接当前 session',
].join('\n');

function mdCard(title: string, content: string, template = 'blue'): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [{ tag: 'markdown', content }],
  };
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…(省略 ${s.length - n} 字)` : s;
}

/** message.content（string | block[]）→ 拼接所有 text 块文本。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => (b as { text: string }).text)
    .join('');
}

type MsgLike = { message?: { role?: string; content?: unknown } };

/**
 * 从 session 消息里取「上一轮」：最后一条**人类文本** prompt + 最后一条 **assistant 文本**。
 * role 为 user 但内容是 tool_result（无 text 块）的会被跳过——只认真人输入。
 */
export function extractLastTurn(messages: MsgLike[]): { userText?: string; agentText?: string } {
  let userText: string | undefined;
  let agentText: string | undefined;
  for (const m of messages) {
    const role = m.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const t = contentToText(m.message?.content).trim();
    if (!t) continue;
    if (role === 'user') userText = t;
    else agentText = t;
  }
  return { userText, agentText };
}

/** best-effort 读上一轮（读盘失败/空 session 返回空对象，不阻断 /use）。 */
export async function readLastTurn(
  reader: { readSessionMessages(dirName: string, sessionId: string): Promise<MsgLike[]> },
  dirName: string,
  sessionId: string,
): Promise<{ userText?: string; agentText?: string }> {
  const msgs = await reader.readSessionMessages(dirName, sessionId).catch(() => []);
  return extractLastTurn(msgs);
}

/** /use 切换后的确认卡：sessionId/cwd + 上一轮摘要（用户 prompt + agent 回复）。 */
export function useConfirmCard(
  target: { sessionId: string; cwd: string },
  last: { userText?: string; agentText?: string },
): FeishuCard {
  const lines = [`\`${target.sessionId.slice(0, 8)}\``, '', `📂 ${target.cwd}`];
  if (last.userText || last.agentText) {
    lines.push('', '**上一轮**：');
    if (last.userText) lines.push(`👤 ${trunc(last.userText, 600)}`);
    if (last.agentText) lines.push(`🤖 ${trunc(last.agentText, 1000)}`);
  }
  return mdCard('已切换 session', lines.join('\n'), 'turquoise');
}

/** /use 到正在运行的 session：警告并发分叉 + 「结束它并由飞书接管」kill 按钮。 */
export function useBusyCard(target: { sessionId: string; dirName: string; cwd: string }, pids: number[]): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Session 正在运行' }, template: 'orange' },
    elements: [
      {
        tag: 'markdown',
        content: `⚠️ 该 session 正在另一个 claude 进程运行（PID ${pids.join(', ')}），并发续接会**分叉** transcript。\n\n\`${target.sessionId.slice(0, 8)}\` · 📂 ${target.cwd}`,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '结束它并由飞书接管' },
            type: 'danger',
            value: { action: 'kill', sessionId: target.sessionId, dirName: target.dirName, cwd: target.cwd },
          },
        ],
      },
      { tag: 'markdown', content: '点按钮 kill 那个进程后，飞书成为唯一写入者，即可单线续接。' },
    ],
  };
}

/** 解析并执行飞书命令；非 / 开头返回 { kind:'none' }（由调用方当作续接 prompt）。 */
export async function handleCommand(text: string, ctx: CommandContext): Promise<CommandResult> {
  const m = text.trim().match(/^\/(\S+)\s*(.*)$/);
  if (!m) return { kind: 'none' };
  const cmd = m[1].toLowerCase();
  const arg = m[2].trim();

  switch (cmd) {
    case 'sessions':
    case 'ls':
      return await cmdSessions(arg, ctx);
    case 'use':
    case 'u':
      return cmdUse(arg, ctx);
    case 'info':
    case 'pwd':
      return cmdInfo(ctx);
    case 'new':
    case 'n':
      return cmdNew(arg);
    case 'provider':
    case 'model':
      return await cmdProvider(arg, ctx);
    case 'stop':
      return { kind: 'stop' };
    case 'help':
    case '?':
      return { kind: 'reply-text', text: HELP_TEXT };
    default:
      return { kind: 'reply-text', text: `未知命令 /${cmd}。\n\n${HELP_TEXT}` };
  }
}

/**
 * 构造 /sessions 某一页的卡片：**全局按最后更新时间(mtime)降序**，每条带「进入会话」按钮；
 * 多页时附「上一页/下一页」按钮（value 带 page+dirFilter，点击由 handleCardAction 重渲该页）。
 * 导出供按钮翻页复用。
 */
export async function buildSessionsPage(
  deps: { reader: ClaudeFileReader; state: SessionState; busySessionIds: () => Set<string> },
  page: number,
  dirFilter: string,
): Promise<CommandResult> {
  const projects = await deps.reader.listProjects();
  type Item = { e: CurrentSession; preview: string; mtimeMs: number };
  const items: Item[] = [];
  for (const p of projects) {
    if (dirFilter && !`${p.dirName} ${p.cwd}`.toLowerCase().includes(dirFilter)) continue;
    const sessions = await deps.reader.listSessions(p.dirName);
    for (const s of sessions) {
      items.push({ e: { sessionId: s.sessionId, dirName: p.dirName, cwd: p.cwd }, preview: s.preview, mtimeMs: s.mtimeMs });
    }
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs); // 全局按最后更新时间降序
  deps.state.setIndex(items.map((x) => x.e));
  const busy = deps.busySessionIds();
  const total = items.length;
  if (!total) {
    return { kind: 'reply-text', text: dirFilter ? `没有匹配「${dirFilter}」的 session` : '没有可用的 session' };
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const curPage = Math.min(Math.max(1, page), totalPages);
  const start = (curPage - 1) * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  const elements: unknown[] = [
    { tag: 'markdown', content: `共 ${total} 个 session · 第 ${curPage}/${totalPages} 页` },
    { tag: 'hr' },
  ];
  slice.forEach((x, i) => {
    const n = start + i + 1;
    const preview = (x.preview || '(无预览)').slice(0, 40);
    const flag = busy.has(x.e.sessionId) ? ' 🟢忙' : '';
    elements.push({
      tag: 'markdown',
      content: `${n}. ${preview}${flag}\n   \`${x.e.sessionId.slice(0, 8)}\` · ${x.e.cwd}`,
    });
    // 「进入会话」按钮：value 带完整 {sessionId,dirName,cwd}，点击等价 /use（不依赖序号，避免翻页错位）。
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '进入会话' },
          type: 'primary',
          value: { action: 'use', sessionId: x.e.sessionId, dirName: x.e.dirName, cwd: x.e.cwd },
        },
      ],
    });
  });
  // 翻页按钮（首页无「上一页」，末页无「下一页」）；dirFilter 回带以保留过滤。
  const nav: unknown[] = [];
  if (curPage > 1) nav.push({ tag: 'button', text: { tag: 'plain_text', content: '上一页' }, type: 'default', value: { action: 'page', page: curPage - 1, dirFilter } });
  if (curPage < totalPages) nav.push({ tag: 'button', text: { tag: 'plain_text', content: '下一页' }, type: 'primary', value: { action: 'page', page: curPage + 1, dirFilter } });
  if (nav.length) elements.push({ tag: 'hr' }, { tag: 'action', actions: nav });
  return {
    kind: 'reply',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Sessions' }, template: 'blue' },
      elements,
    },
  };
}

async function cmdSessions(arg: string, ctx: CommandContext): Promise<CommandResult> {
  let page = 1;
  let dirFilter = '';
  if (/^\d+$/.test(arg)) page = Math.max(1, Number(arg));
  else dirFilter = arg.toLowerCase();
  return buildSessionsPage(ctx, page, dirFilter);
}

async function cmdUse(arg: string, ctx: CommandContext): Promise<CommandResult> {
  if (!arg) return { kind: 'reply-text', text: '用法：/use <序号|sessionId 前缀>' };
  let target: CurrentSession | null = /^\d+$/.test(arg) ? ctx.state.getByIndex(Number(arg)) : null;
  if (!target) target = ctx.state.findByPrefix(arg);
  if (!target) {
    return { kind: 'reply-text', text: '未找到该 session。序号可能已过期，请重新 /sessions；或用 sessionId 前缀。' };
  }
  ctx.state.set(target);
  const pids = await runningPidsFor(ctx.reader, target.sessionId);
  if (pids.length) return { kind: 'reply', card: useBusyCard(target, pids) };
  const last = await readLastTurn(ctx.reader, target.dirName, target.sessionId);
  return { kind: 'reply', card: useConfirmCard(target, last) };
}

function cmdNew(arg: string): CommandResult {
  const parts = arg.trim().split(/\s+/);
  const cwd = parts[0] || '';
  const prompt = parts.slice(1).join(' ').trim();
  if (!cwd) {
    return { kind: 'reply-text', text: '用法：/new <目录> <首条指令>\n例：/new D:\\code\\demo 帮我初始化一个 node 项目' };
  }
  if (!prompt) return { kind: 'reply-text', text: '请提供首条指令：/new <目录> <指令>' };
  return { kind: 'new-session', cwd, prompt };
}

/** /provider：无参列出；off/default 清除；<名称|id> 匹配后返回 set-provider。 */
async function cmdProvider(arg: string, ctx: CommandContext): Promise<CommandResult> {
  const provs = ctx.providers ?? [];
  const cur = ctx.currentProviderId;
  if (!arg.trim()) {
    if (!provs.length) return { kind: 'reply-text', text: '未配置任何 provider，当前用 env 默认。' };
    const lines = provs.map((p) => {
      const mark = p.id === cur ? ' ✅当前' : '';
      return `- ${p.name ?? p.id} (\`${p.id}\`)${mark}`;
    });
    return { kind: 'reply', card: mdCard('Provider', `当前：${cur ? `\`${cur}\`` : 'env 默认'}\n\n${lines.join('\n')}\n\n用 /provider <名称|id> 切换，/provider off 清除`, 'deep_blue') };
  }
  if (arg === 'off' || arg === 'default') return { kind: 'set-provider', providerId: null };
  const id = await (ctx.matchProvider ?? matchProvider)(arg);
  if (!id) return { kind: 'reply-text', text: `未找到匹配「${arg}」的 provider。` };
  return { kind: 'set-provider', providerId: id };
}

function cmdInfo(ctx: CommandContext): CommandResult {
  const cur = ctx.state.current();
  if (!cur) {
    return { kind: 'reply-text', text: '未选择 session。用 /sessions 查看，/use <序号> 切换。' };
  }
  const busy = ctx.busySessionIds().has(cur.sessionId) ? ' 🟢忙' : ' 闲';
  return { kind: 'reply', card: mdCard('当前 session', `\`${cur.sessionId.slice(0, 8)}\`${busy}\n\n📂 ${cur.cwd}`) };
}
