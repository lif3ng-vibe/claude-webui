<script setup lang="ts">
// 终端槽位：一个容器 div，把 registry 里该 tab 的 hostEl 挂进来。
// 活动标签切换（同组内）时 watch tabId：摘旧 hostEl、挂新 hostEl。
// 容器尺寸变化（分屏调宽/窗口缩放）→ fitAndResize 通知后端。
// acquire 用 descriptor 建连（幂等：已存在则只刷新 descriptor）。
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import { terminalRegistry } from '../../lib/workspace/registry';
import type { TabDescriptor } from '../../lib/workspace/types';

const props = defineProps<{ tabId: string; descriptor: TabDescriptor }>();
const el = ref<HTMLDivElement | null>(null);

function doAttach(): void {
  if (!el.value) return;
  terminalRegistry.acquire(props.descriptor);
  terminalRegistry.attach(props.tabId, el.value);
}

onMounted(doAttach);
onUnmounted(() => terminalRegistry.detach(props.tabId));
watch(() => props.tabId, (next, prev) => {
  if (prev) terminalRegistry.detach(prev);
  doAttach();
});
useResizeObserver(el, () => terminalRegistry.fitAndResize(props.tabId));
</script>

<template>
  <div ref="el" class="ws-terminal-slot" />
</template>

<style scoped>
.ws-terminal-slot {
  height: 100%;
  min-height: 0;
  padding: 6px 8px;
  background: #1a1a1a;
  overflow: hidden;
}
.ws-terminal-slot :deep(.ws-term-host),
.ws-terminal-slot :deep(.xterm) {
  height: 100%;
}
</style>
