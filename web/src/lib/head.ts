// 动态设置页面 title 与 favicon（客户端切换，不依赖服务端注入）。
// 桌面端：title 映射 OS 窗口标题；favicon 在无标签页环境自然降级。

let iconLink: HTMLLinkElement | null = null;

function ensureIconLink(): HTMLLinkElement {
  if (iconLink) return iconLink;
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) {
    iconLink = existing;
    return existing;
  }
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  document.head.appendChild(link);
  iconLink = link;
  return link;
}

/** type 级 favicon（按路由 pattern，无需数据） */
export const FAVICON = {
  home: '/favicon.svg',
  dir: '/favicon-dir.svg',
  session: '/favicon-session.svg',
  chat: '/favicon-chat.svg',
  study: '/favicon-study.svg',
} as const;

export function setFavicon(href: string): void {
  ensureIconLink().href = href;
}

export function setTitle(title: string): void {
  document.title = title;
}

interface HeadInput {
  title: string;
  favicon: string;
}

export function setHead({ title, favicon }: HeadInput): void {
  setTitle(title);
  setFavicon(favicon);
}