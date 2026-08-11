import type { ClaudeRunEvent } from '../claude/Runner.js';
import type { FeishuCard } from './types.js';

/** 正文 markdown 单元素的最大字符数（超长截断 + 省略提示）。 */
const MAX_BODY_CHARS = 28000;
/** 单个工具调用/结果代码块的最大字符数。 */
const MAX_TOOL_CHARS = 1500;

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  thinking?: string;
};

/** 从 message.content（string | block[]）提取所有 text 块文本拼接。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => isBlock(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => (b as ContentBlock).text as string)
    .join('');
}

function extractToolUse(content: unknown): Array<{ name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => isBlock(b) && b.type === 'tool_use')
    .map((b) => ({ name: String((b as ContentBlock).name ?? 'tool'), input: (b as ContentBlock).input ?? {} }));
}

function extractToolResult(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => isBlock(b) && b.type === 'tool_result')
    .map((b) => {
      const c = (b as ContentBlock).content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => (isBlock(x) ? String(x.text ?? '') : '')).join('');
      return JSON.stringify(c ?? '');
    });
}

function isBlock(b: unknown): b is ContentBlock {
  return !!b && typeof b === 'object';
}

interface Turn {
  uuid: string;
  role: 'assistant' | 'user';
  content: unknown;
}

/**
 * 累加器：把 stream-json 事件累计成中间态。
 * 同一 message uuid 的 content 在流式中累积增长，故**覆盖式**保留最新 content（去重）。
 */
export class CardAccumulator {
  private order: string[] = [];
  private turns = new Map<string, Turn>();
  private stderr: string[] = [];
  resultText: string | null = null;
  exited: { code: number | null } | null = null;
  /** 最近一次 extended-thinking 的累计 token 估计（system/thinking_tokens），用于运行中进度指示。 */
  thinkingTokens = 0;

  accumulate(ev: ClaudeRunEvent): void {
    if (ev.type === 'stream-json') {
      const d = ev.data as Record<string, unknown> | undefined;
      if (!d || typeof d !== 'object') return;
      const type = d.type;
      if (type === 'assistant' || type === 'user') {
        const msg = (d.message as Record<string, unknown> | undefined) ?? {};
        const uuid = String(msg.uuid ?? d.uuid ?? '');
        const key = uuid || `auto-${this.order.length}`;
        if (!this.turns.has(key)) this.order.push(key);
        this.turns.set(key, { uuid: key, role: type, content: msg.content ?? [] });
      } else if (type === 'result') {
        const r = (d as { result?: unknown }).result;
        this.resultText = typeof r === 'string' ? r : JSON.stringify(r ?? '');
      } else if (type === 'system' && d.subtype === 'thinking_tokens') {
        // extended-thinking 的 token 计数是续接流里唯一「活」的进度信号（答案正文只走快照）。
        const n = Number((d as { estimated_tokens?: unknown }).estimated_tokens);
        if (Number.isFinite(n) && n > this.thinkingTokens) this.thinkingTokens = n;
      }
      // 其它 system 事件忽略
    } else if (ev.type === 'stderr') {
      this.stderr.push(ev.text);
    } else if (ev.type === 'exit') {
      this.exited = { code: ev.code };
    }
  }

  turnsOrdered(): Turn[] {
    return this.order.map((k) => this.turns.get(k)!).filter(Boolean);
  }

  stderrText(): string {
    return this.stderr.join('\n');
  }
}

export function createAccumulator(): CardAccumulator {
  return new CardAccumulator();
}

function md(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…(省略 ${s.length - n} 字)` : s;
}

export interface ToCardOpts {
  title: string;
  status: 'running' | 'done' | 'error';
  cwd: string;
  elapsedMs?: number;
}

/** 把累加器渲染成飞书交互卡片 JSON（正文 markdown 元素 + 工具调用/结果 + 状态 note）。 */
export function toCard(acc: CardAccumulator, opts: ToCardOpts): FeishuCard {
  const tools: unknown[] = [];
  let bodyText = '';
  for (const t of acc.turnsOrdered()) {
    if (t.role === 'assistant') {
      bodyText += extractText(t.content);
      for (const tu of extractToolUse(t.content)) {
        tools.push(md(`**🔧 ${tu.name}**\n\`\`\`json\n${trunc(JSON.stringify(tu.input ?? {}, null, 2), MAX_TOOL_CHARS)}\n\`\`\``));
      }
    } else {
      for (const r of extractToolResult(t.content)) {
        tools.push(md(`**↳ result**\n\`\`\`\n${trunc(String(r), MAX_TOOL_CHARS)}\n\`\`\``));
      }
    }
  }

  const out: unknown[] = [];
  // 思考进度指示：仅在运行中、尚未产出正文时显示（答案一到就让位给正文）。
  if (opts.status === 'running' && acc.thinkingTokens > 0 && !bodyText.trim()) {
    out.push(md(`💭 思考中… ~${acc.thinkingTokens} tokens`));
  }
  const body = bodyText.trim() || (acc.resultText ?? '').trim();
  if (body) out.push(md(trunc(body, MAX_BODY_CHARS)));
  out.push(...tools);
  const stderr = acc.stderrText().trim();
  if (stderr) out.push(md(`**stderr**\n\`\`\`\n${trunc(stderr, MAX_TOOL_CHARS)}\n\`\`\``));
  out.push({ tag: 'hr' });
  out.push({ tag: 'note', elements: [{ tag: 'plain_text', content: statusNote(opts, acc) }] });

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: opts.title }, template: colorOf(opts.status) },
    elements: out,
  };
}

function statusNote(opts: ToCardOpts, acc: CardAccumulator): string {
  const parts: string[] = [];
  if (opts.status === 'running') parts.push('🔄 运行中…');
  else if (opts.status === 'done') parts.push('✅ 完成');
  else parts.push(`❌ 失败${acc.exited ? ` (exit ${acc.exited.code})` : ''}`);
  if (opts.elapsedMs != null) parts.push(`${(opts.elapsedMs / 1000).toFixed(1)}s`);
  parts.push(`📂 ${opts.cwd}`);
  return parts.join(' · ');
}

function colorOf(status: ToCardOpts['status']): string {
  return status === 'done' ? 'green' : status === 'error' ? 'red' : 'blue';
}

/** 节流：控制飞书卡片 patch 频率，避免触发消息更新限流。 */
export class Throttle {
  private last: number | null = null;
  constructor(private readonly minIntervalMs: number) {}
  /** 从未执行，或距上次执行已过最小间隔。now 由调用方传入（便于测试）。 */
  shouldRun(now: number): boolean {
    if (this.last === null) return true;
    return now - this.last >= this.minIntervalMs;
  }
  mark(now: number): void {
    this.last = now;
  }
}
