import { createHighlighter, type Highlighter } from 'shiki';

let hlPromise: Promise<Highlighter> | null = null;

/** 懒加载 Shiki highlighter（代码高亮，下一步接入 markdown-it / 代码块组件）。 */
export function getHighlighter(): Promise<Highlighter> {
  if (!hlPromise) {
    hlPromise = createHighlighter({
      themes: ['github-dark'],
      langs: ['typescript', 'javascript', 'bash', 'json', 'vue', 'markdown', 'python', 'css', 'html', 'shell'],
    });
  }
  return hlPromise;
}