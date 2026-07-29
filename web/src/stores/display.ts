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
  return { dirSort, sessionSort, showToolUse, showToolResult, showThinking, showCountBadge, showSessionSub, showDirTime };
});