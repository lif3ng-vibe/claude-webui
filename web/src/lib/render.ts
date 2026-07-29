import MarkdownIt from 'markdown-it';
import { shikiReady, codeToHtml } from './shiki';

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  highlight(code, lang) {
    void shikiReady.value; // 触发响应式依赖，Shiki 就绪后重渲染高亮
    return codeToHtml(code, lang) ?? `<pre><code>${esc(code)}</code></pre>`;
  },
});

export function renderMd(text: unknown): string {
  return md.render(String(text ?? ''));
}

export function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

/** 转义并用 <mark> 高亮命中子串（大小写不敏感）。 */
export function hl(text: string, q: string): string {
  if (!q) return esc(text);
  const low = text.toLowerCase();
  const ql = q.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const idx = low.indexOf(ql, i);
    if (idx === -1) {
      out += esc(text.slice(i));
      break;
    }
    out += esc(text.slice(i, idx));
    out += `<mark>${esc(text.slice(idx, idx + ql.length))}</mark>`;
    i = idx + ql.length;
  }
  return out;
}

export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** 相对时间，超过 7 天回退为日期。 */
export function fmtTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

/** 在已渲染的 HTML 里高亮命中（只在标签之间的文本片段插入 <mark>，不破坏标签）。 */
export function highlightInHtml(html: string, term: string): string {
  if (!term) return html;
  const ql = term.toLowerCase();
  return html.replace(/>([^<]+)</g, (full: string, text: string) => {
    const low = text.toLowerCase();
    let out = '';
    let i = 0;
    for (;;) {
      const idx = low.indexOf(ql, i);
      if (idx === -1) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, idx);
      out += `<mark>${text.slice(idx, idx + ql.length)}</mark>`;
      i = idx + ql.length;
    }
    return `>${out}<`;
  });
}

export interface RenderOpts {
  toolUse?: boolean;
  toolResult?: boolean;
  thinking?: boolean;
}

function contentBlocksHtml(content: unknown, opts: RenderOpts = {}): string {
  if (typeof content === 'string') return renderMd(content);
  if (!Array.isArray(content)) return esc(JSON.stringify(content));
  return content
    .map((b) => {
      if (b.type === 'text') return renderMd(b.text);
      if (b.type === 'thinking')
        return opts.thinking === false ? '' : `<details class="thinking-details"><summary>💭 思考</summary><div class="thinking">${esc(b.thinking ?? b.text ?? '')}</div></details>`;
      if (b.type === 'tool_use')
        return opts.toolUse === false ? '' : `<details><summary class="tool-call">🔧 ${esc(b.name)}</summary><pre>${esc(JSON.stringify(b.input ?? {}, null, 2))}</pre></details>`;
      if (b.type === 'tool_result')
        return opts.toolResult === false ? '' : `<details><summary class="tool-result">↳ result</summary><pre>${esc(String(b.content ?? '').slice(0, 2000))}</pre></details>`;
      return esc(JSON.stringify(b));
    })
    .join('\n');
}

/** 渲染 session 消息内容块（可选高亮命中 term、显隐控制）。 */
export function renderContent(content: unknown, term = '', opts: RenderOpts = {}): string {
  const html = contentBlocksHtml(content, opts);
  return term ? highlightInHtml(html, term) : html;
}

/** 渲染 tool 消息（可选高亮）。 */
export function renderTool(toolUseResult: unknown, raw: unknown, term = ''): string {
  const json = JSON.stringify(toolUseResult ?? raw, null, 2).slice(0, 2000);
  const html = `<details><summary class="tool-result">↳ result</summary><pre>${esc(json)}</pre></details>`;
  return term ? highlightInHtml(html, term) : html;
}