<script setup lang="ts">
// 递归渲染布局树：split 节点 → splitpanes（按 orientation 横/纵，sizes 双向回写）；
// group 节点 → TabGroup。Vue :key 用节点 id，拖拽重组时身份稳定。
import { Splitpanes, Pane } from 'splitpanes';
import 'splitpanes/dist/splitpanes.css';
import type { LayoutNode, SplitNode } from '../../lib/workspace/types';
import { useWorkspaceStore } from '../../stores/workspace';
import TabGroup from './TabGroup.vue';

defineProps<{ node: LayoutNode }>();
const store = useWorkspaceStore();

function onResized(node: LayoutNode, payload: { panes: Array<{ size: number }> }): void {
  if (node.type === 'split') store.setSizes((node as SplitNode).id, payload.panes.map((p) => p.size));
}
</script>

<template>
  <Splitpanes
    v-if="node.type === 'split'"
    class="ws-split"
    :horizontal="node.orientation === 'vertical'"
    @resized="onResized(node, $event)"
  >
    <Pane v-for="(c, i) in node.children" :key="c.id" :size="node.sizes[i]">
      <SplitLayout :node="c" />
    </Pane>
  </Splitpanes>
  <TabGroup v-else :group="node" />
</template>

<style scoped>
.ws-split {
  height: 100%;
}
</style>
