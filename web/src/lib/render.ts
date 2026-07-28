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

/** 渲染 session 消息内容块：text 走 markdown，tool_use/tool_result 用 <details> 折叠。 */
export function renderContent(content: unknown): string {
  if (typeof content === 'string') return renderMd(content);
  if (!Array.isArray(content)) return esc(JSON.stringify(content));
  return content
    .map((b) => {
      if (b.type === 'text') return renderMd(b.text);
      if (b.type === 'tool_use')
        return `<details><summary class="tool-call">🔧 ${esc(b.name)}</summary><pre>${esc(JSON.stringify(b.input ?? {}, null, 2))}</pre></details>`;
      if (b.type === 'tool_result')
        return `<details><summary class="tool-result">↳ result</summary><pre>${esc(String(b.content ?? '').slice(0, 2000))}</pre></details>`;
      return esc(JSON.stringify(b));
    })
    .join('\n');
}