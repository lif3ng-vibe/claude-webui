<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { NConfigProvider, NMessageProvider, darkTheme } from 'naive-ui';
import TitleBar from './components/TitleBar.vue';
import { useDisplayStore } from './stores/display';
import { desktop, isDesktop } from './lib/desktop';

const display = useDisplayStore();

// 页面缩放：范围 0.5–2.0，步长 0.1；标题栏与主导航固定（见 styles.css 的反向 zoom）。
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const clampZoom = (z: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;

function applyZoom(): void {
  const z = display.zoom || 1;
  const root = document.documentElement.style;
  root.setProperty('--zoom', String(z));
  root.setProperty('--zoom-inv', String(1 / z));
}

function onKey(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  // 缩放：Ctrl/Cmd + +/-/0
  if (mod && (e.key === '+' || e.key === '=')) {
    e.preventDefault();
    display.zoom = clampZoom((display.zoom || 1) + ZOOM_STEP);
    return;
  }
  if (mod && (e.key === '-' || e.key === '_')) {
    e.preventDefault();
    display.zoom = clampZoom((display.zoom || 1) - ZOOM_STEP);
    return;
  }
  if (mod && e.key === '0') {
    e.preventDefault();
    display.zoom = 1;
    return;
  }
  // DevTools：F12 或 Ctrl/Cmd+Shift+I（仅桌面壳；web 不拦截，让浏览器原生打开）
  if (isDesktop && (e.key === 'F12' || (mod && e.shiftKey && (e.key === 'I' || e.key === 'i')))) {
    e.preventDefault();
    desktop?.openDevTools();
  }
}

onMounted(() => {
  applyZoom();
  window.addEventListener('keydown', onKey, true);
});
onUnmounted(() => window.removeEventListener('keydown', onKey, true));
watch(() => display.zoom, applyZoom);
</script>

<template>
  <NConfigProvider :theme="darkTheme">
    <NMessageProvider>
      <div class="flex flex-col h-full">
        <TitleBar />
        <div class="flex-1 min-h-0">
          <router-view />
        </div>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>
