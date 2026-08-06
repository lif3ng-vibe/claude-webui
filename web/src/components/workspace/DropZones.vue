<script setup lang="ts">
// 分屏落点覆盖层：dragover 时高亮当前半区（left/right/top/bottom/center），纯视觉、不接事件。
import type { Zone } from '../../lib/workspace/dnd';
defineProps<{ zone: Zone | null }>();
const zones: Array<{ id: Zone; cls: string }> = [
  { id: 'left', cls: 'z-left' },
  { id: 'right', cls: 'z-right' },
  { id: 'top', cls: 'z-top' },
  { id: 'bottom', cls: 'z-bottom' },
  { id: 'center', cls: 'z-center' },
];
</script>

<template>
  <div v-if="zone" class="ws-zones">
    <div v-for="z in zones" :key="z.id" class="ws-zone" :class="[z.cls, { active: zone === z.id }]" />
  </div>
</template>

<style scoped>
.ws-zones {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 5;
}
.ws-zone {
  position: absolute;
  background: #8ab4f81a;
  border: 2px dashed transparent;
}
.ws-zone.z-left { top: 0; left: 0; width: 50%; height: 100%; }
.ws-zone.z-right { top: 0; right: 0; width: 50%; height: 100%; }
.ws-zone.z-top { top: 0; left: 0; width: 100%; height: 50%; }
.ws-zone.z-bottom { bottom: 0; left: 0; width: 100%; height: 50%; }
.ws-zone.z-center { inset: 0; }
.ws-zone.active {
  background: #8ab4f833;
  border-color: #8ab4f8;
}
</style>
