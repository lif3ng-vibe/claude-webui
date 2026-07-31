<script setup lang="ts">
// 无边框窗口自定义标题栏：仅桌面端渲染（v-if isDesktop）。
// 拖拽容器同时挂 -webkit-app-region:drag（Electron）与 data-tauri-drag-region（Tauri），
// 按钮挂 -webkit-app-region:no-drag；Tauri 中交互元素自动不触发拖拽。
// 标题取 document.title（head.ts 已按路由动态设置），监 <title> 元素变化。
import { onMounted, onUnmounted, ref } from 'vue';
import { isDesktop, alwaysOnTop, toggleAlwaysOnTop, initAlwaysOnTop, minimize, toggleMaximize, closeWindow } from '../lib/desktop';

const title = ref(document.title);
let observer: MutationObserver | null = null;

function minimizeBtn() {
  minimize();
}
function toggleMaxBtn() {
  toggleMaximize();
}
function closeBtn() {
  closeWindow();
}

onMounted(async () => {
  await initAlwaysOnTop();
  const titleEl = document.querySelector('title');
  if (titleEl) {
    observer = new MutationObserver(() => {
      title.value = document.title;
    });
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }
});

onUnmounted(() => {
  observer?.disconnect();
});
</script>

<template>
  <div
    v-if="isDesktop"
    class="titlebar"
    style="-webkit-app-region: drag"
    data-tauri-drag-region
  >
    <span class="title" data-tauri-drag-region>{{ title }}</span>
    <div class="controls">
      <button
        class="titlebar-btn"
        :class="{ active: alwaysOnTop }"
        style="-webkit-app-region: no-drag"
        title="钉在最前"
        @click="toggleAlwaysOnTop()"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z" /><line x1="12" y1="15" x2="12" y2="21" />
        </svg>
      </button>
      <button class="titlebar-btn" style="-webkit-app-region: no-drag" title="最小化" @click="minimizeBtn">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
      </button>
      <button class="titlebar-btn" style="-webkit-app-region: no-drag" title="最大化" @click="toggleMaxBtn">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="1" /></svg>
      </button>
      <button class="titlebar-btn close" style="-webkit-app-region: no-drag" title="关闭" @click="closeBtn">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  height: 32px;
  display: flex;
  align-items: center;
  padding: 0 4px 0 10px;
  background: #1d1d1d;
  border-bottom: 1px solid #333;
  user-select: none;
  flex-shrink: 0;
}
.title {
  flex: 1;
  font-size: 12px;
  color: #999;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.controls {
  display: flex;
  align-items: center;
  gap: 2px;
}
.titlebar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  background: none;
  border: none;
  border-radius: 4px;
  color: #888;
  cursor: pointer;
}
.titlebar-btn:hover {
  background: #2a2a2a;
  color: #ccc;
}
.titlebar-btn.active {
  color: #8ab4f8;
}
.titlebar-btn.close:hover {
  background: #e81123;
  color: #fff;
}
</style>