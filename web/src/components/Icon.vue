<script setup lang="ts">
// 统一图标组件：从 lib/icons 取路径，渲染与全局 SVG 同风格（stroke / currentColor）。
// 根元素是 inline-flex 的 span，便于在按钮/文字中垂直居中。
import { computed } from 'vue';
import { iconSvg } from '../lib/icons';

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 });
const html = computed(() => iconSvg(props.name, props.size));
</script>

<template>
  <span class="icon" v-html="html" />
</template>

<style scoped>
.icon {
  display: inline-flex;
  vertical-align: middle;
}
.icon :deep(svg) {
  display: block;
}
</style>
