import type { ClaudeFileReader } from '../claude/FileReader.js';
import type { SessionState, CurrentSession } from './SessionState.js';
import type { FeishuCard } from './types.js';
import { matchProvider } from '../config.js';

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

async function cmdSessions(arg: string, ctx: CommandContext): Promise<CommandResult> {
  let page = 1;
  let dirFilter = '';
  if (/^\d+$/.test(arg)) page = Math.max(1, Number(arg));
  else dirFilter = arg.toLowerCase();

  const projects = await ctx.reader.listProjects();
  type Item = { e: CurrentSession; preview: string };
  const items: Item[] = [];
  for (const p of projects) {
    if (dirFilter && !`${p.dirName} ${p.cwd}`.toLowerCase().includes(dirFilter)) continue;
    const sessions = await ctx.reader.listSessions(p.dirName);
    for (const s of sessions) {
      items.push({ e: { sessionId: s.sessionId, dirName: p.dirName, cwd: p.cwd }, preview: s.preview });
    }
  }
  ctx.state.setIndex(items.map((x) => x.e));
  const busy = ctx.busySessionIds();
  const total = items.length;
  if (!total) {
    return { kind: 'reply-text', text: dirFilter ? `没有匹配「${arg}」的 session` : '没有可用的 session' };
  }
  const start = (page - 1) * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  const lines = slice.map((x, i) => {
    const n = start + i + 1;
    const preview = (x.preview || '(无预览)').slice(0, 40);
    const flag = busy.has(x.e.sessionId) ? ' 🟢忙' : '';
    return `${n}. ${preview}${flag}\n   \`${x.e.sessionId.slice(0, 8)}\` · ${x.e.cwd}`;
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const header = `共 ${total} 个 session（第 ${page}/${totalPages} 页，/sessions <页码> 翻页）`;
  return { kind: 'reply', card: mdCard('Sessions', `${header}\n\n${lines.join('\n\n')}`) };
}

function cmdUse(arg: string, ctx: CommandContext): CommandResult {
  if (!arg) return { kind: 'reply-text', text: '用法：/use <序号|sessionId 前缀>' };
  let target: CurrentSession | null = /^\d+$/.test(arg) ? ctx.state.getByIndex(Number(arg)) : null;
  if (!target) target = ctx.state.findByPrefix(arg);
  if (!target) {
    return { kind: 'reply-text', text: '未找到该 session。序号可能已过期，请重新 /sessions；或用 sessionId 前缀。' };
  }
  ctx.state.set(target);
  return {
    kind: 'reply',
    card: mdCard('已切换 session', `\`${target.sessionId.slice(0, 8)}\`\n\n📂 ${target.cwd}`, 'turquoise'),
  };
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
