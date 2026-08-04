import { defineStore } from 'pinia';
import { useStorage } from '@vueuse/core';

/** 显示/排序偏好，持久化到 localStorage。 */
export const useDisplayStore = defineStore('display', () => {
  const dirSort = useStorage<'name' | 'updated'>('cwu-dirSort', 'updated');
  const sessionSort = useStorage<'updated' | 'name' | 'size'>('cwu-sessionSort', 'updated');
  const showToolUse = useStorage('cwu-showToolUse', true);
  const showToolResult = useStorage('cwu-showToolResult', true);
  const showThinking = useStorage('cwu-showThinking', true);
  const showCountBadge = useStorage('cwu-showCountBadge', true);
  const showSessionSub = useStorage('cwu-showSessionSub', true);
  const showDirTime = useStorage('cwu-showDirTime', true);
  const showCheckbox = useStorage('cwu-showCheckbox', true);
  // 页面缩放倍数（Ctrl/Cmd +/- 调整，0 复位）；持久化。标题栏/导航不缩放。
  const zoom = useStorage('cwu-zoom', 1);
  // 交互浮层开关：开启后所有会话窗口显示"选项/是·否/继续"快捷应答（localStorage 跨窗口同步）。
  const quickReply = useStorage('cwu-quickReply', false);
  return { dirSort, sessionSort, showToolUse, showToolResult, showThinking, showCountBadge, showSessionSub, showDirTime, showCheckbox, zoom, quickReply };
});