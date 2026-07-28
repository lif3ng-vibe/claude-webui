import { ref } from 'vue';
import { createHighlighter, type Highlighter } from 'shiki';

/** Shiki 是否就绪（响应式，ready 后触发依赖它的渲染重跑）。 */
export const shikiReady = ref(false);
let hl: Highlighter | null = null;
let initPromise: Promise<void> | null = null;

/** 懒加载 Shiki highlighter（失败降级为无高亮）。 */
export function initShiki(): Promise<void> {
  if (!initPromise) {
    initPromise = createHighlighter({
      themes: ['github-dark'],
      langs: ['typescript', 'javascript', 'bash', 'json', 'vue', 'markdown', 'python', 'css', 'html', 'shell', 'yaml', 'diff'],
    })
      .then((h) => {
        hl = h;
        shikiReady.value = true;
      })
      .catch(() => {
        /* 高亮可选，失败降级 */
      });
  }
  return initPromise;
}

/** 同步高亮（highlighter 未就绪返回 null）。 */
export function codeToHtml(code: string, lang: string): string | null {
  if (!hl) return null;
  try {
    const loaded = hl.getLoadedLanguages();
    const l = lang && loaded.includes(lang) ? lang : 'text';
    return hl.codeToHtml(code, { lang: l, theme: 'github-dark' });
  } catch {
    return null;
  }
}