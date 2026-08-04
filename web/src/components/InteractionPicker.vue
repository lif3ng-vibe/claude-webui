<script setup lang="ts">
// 可拖动浮层：把从 assistant 文本里抽出的"可点选交互"渲染成大按钮。
// actions 由调用方（SessionsView.extractInteractions）从 Claude 回复里启发式抽取：
// 选项列表 / 是·否 / 继续。点按钮 → emit('select', payload)，调用方直接发送。
import { ref, onUnmounted } from 'vue';
import Icon from './Icon.vue';

defineProps<{ actions: { label: string; payload: string; hint?: string }[]; title?: string }>();
const emit = defineEmits<{ select: [payload: string]; close: [] }>();

// 拖动：按住标题栏移动整个浮层（position: fixed）。
const pos = ref({ x: Math.max(12, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 340), y: 88 });
let dragging = false;
let ox = 0;
let oy = 0;
function onDown(e: MouseEvent): void {
  dragging = true;
  ox = e.clientX - pos.value.x;
  oy = e.clientY - pos.value.y;
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
function onMove(e: MouseEvent): void {
  if (dragging) pos.value = { x: e.clientX - ox, y: e.clientY - oy };
}
function onUp(): void {
  dragging = false;
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
}
onUnmounted(() => {
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
});
</script>

<template>
  <div class="ix-picker" :style="{ left: pos.x + 'px', top: pos.y + 'px' }">
    <div class="ix-head" @mousedown="onDown">
      <span>{{ title ?? '快速操作' }}</span>
      <button class="ix-close" title="关闭" @click="emit('close')"><Icon name="x" :size="14" /></button>
    </div>
    <div class="ix-list">
      <button
        v-for="(a, i) in actions"
        :key="i"
        class="ix-btn"
        :title="`发送：${a.payload}`"
        @click="emit('select', a.payload)"
      >
        <span class="ix-txt">{{ a.label }}</span>
        <span v-if="a.hint" class="ix-hint">{{ a.hint }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ix-picker {
  position: fixed;
  z-index: 50;
  width: 320px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: #1d1d1d;
  border: 1px solid #444;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.ix-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: #2a2a2a;
  cursor: move;
  font-size: 12px;
  color: #b388ff;
  user-select: none;
}
.ix-close { display: inline-flex; align-items: center; background: none; border: none; color: #888; cursor: pointer; padding: 2px; }
.ix-close:hover { color: #e88; }
.ix-list { overflow: auto; padding: 6px; display: flex; flex-direction: column; gap: 6px; }
.ix-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: #2a2a2a;
  color: #ddd;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 10px 12px;
  cursor: pointer;
  font: inherit;
}
.ix-btn:hover { background: #2d3a5a; border-color: #8ab4f8; }
.ix-txt { flex: 1; white-space: pre-wrap; word-break: break-word; }
.ix-hint { flex-shrink: 0; font-size: 10px; color: #666; text-transform: uppercase; }
</style>
