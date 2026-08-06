<script setup lang="ts">
// 标签组（布局树叶节点）：标签栏（top 横排 / left 纵列可拖宽）+ 当前活动终端槽位。
// 拖拽用 pointer 事件（非 HTML5 DnD——后者在 Tauri WebView2 不可靠）：
//   - pointerdown 起算，移动超阈值进入拖拽；未移动的 pointerup = 点击切标签；
//   - 拖标签 → 命中别组 chip 重排/移动，命中终端区中心移动、边缘分屏；
//   - 拖组手柄 ⠿ → 命中别组即合并整组（需求1）。
import { computed } from 'vue';
import { Splitpanes, Pane } from 'splitpanes';
import type { TabGroupNode, TabDescriptor } from '../../lib/workspace/types';
import { useWorkspaceStore } from '../../stores/workspace';
import { terminalRegistry } from '../../lib/workspace/registry';
import { drag, startTabDrag, startGroupDrag, updateHover, clearDrag } from '../../lib/workspace/pointerDnd';
import Icon from '../Icon.vue';
import TerminalSlot from './TerminalSlot.vue';
import DropZones from './DropZones.vue';

const props = defineProps<{ group: TabGroupNode }>();
const store = useWorkspaceStore();

const activeTab = computed<TabDescriptor>(() => {
  const t = props.group.tabs.find((x) => x.id === props.group.activeTabId);
  return t ?? props.group.tabs[0];
});

function titleOf(tabId: string): string {
  const e = terminalRegistry.get(tabId);
  const live = e?.title.value;
  if (live) return live;
  const tab = props.group.tabs.find((x) => x.id === tabId);
  if (tab?.title) return tab.title;
  if (tab?.kind === 'new') {
    const base = tab.cwd ? tab.cwd.split(/[\\/]/).pop() : '';
    return base ? '新会话 · ' + base : '新会话';
  }
  return tab?.sessionId?.slice(0, 8) ?? tabId.slice(0, 8);
}
function statusOf(tabId: string): string {
  return terminalRegistry.get(tabId)?.status.value ?? 'connecting';
}

function stripResized(payload: { panes: Array<{ size: number }> }): void {
  const first = payload.panes[0]?.size;
  if (first != null) store.setStripSize(props.group.id, first);
}
function toggleStrip(): void {
  store.setStrip(props.group.id, props.group.strip === 'top' ? 'left' : 'top');
}

// —— pointer 拖拽 ——
const THRESHOLD = 4;
const chipMarkIndex = computed(() =>
  drag.active && drag.hoverTab && drag.hoverTab.groupId === props.group.id ? drag.hoverTab.index : -1,
);
const areaZone = computed(() =>
  drag.active && drag.hoverArea && drag.hoverArea.groupId === props.group.id ? drag.hoverArea.zone : null,
);

function onTabPointerDown(e: PointerEvent, tab: TabDescriptor): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  let started = false;
  const move = (ev: PointerEvent): void => {
    if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) > THRESHOLD) {
      started = true;
      startTabDrag(tab.id, props.group.id);
    }
    if (started) updateHover(ev.clientX, ev.clientY);
  };
  const up = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!started) {
      store.setActiveTab(props.group.id, tab.id); // 点击 = 切标签
      return;
    }
    if (drag.hoverTab) store.moveTab(tab.id, drag.hoverTab.groupId, drag.hoverTab.index);
    else if (drag.hoverArea) {
      if (drag.hoverArea.zone === 'center') store.moveTab(tab.id, drag.hoverArea.groupId);
      else store.splitGroup({ targetGroupId: drag.hoverArea.groupId, tabId: tab.id, edge: drag.hoverArea.zone });
    }
    clearDrag();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onGripPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  let started = false;
  const move = (ev: PointerEvent): void => {
    if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) > THRESHOLD) {
      started = true;
      startGroupDrag(props.group.id);
    }
    if (started) updateHover(ev.clientX, ev.clientY);
  };
  const up = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (started) {
      const dst = drag.hoverTab?.groupId ?? drag.hoverArea?.groupId;
      if (dst && dst !== props.group.id) store.mergeGroupsInto(props.group.id, dst);
    }
    clearDrag();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
</script>

<template>
  <div class="ws-group">
    <!-- 纵向标签栏：左列（可拖宽）+ 终端 -->
    <Splitpanes v-if="group.strip === 'left'" class="ws-strip-split" @resized="stripResized">
      <Pane :size="group.stripSize ?? 22" :min-size="10" :max-size="50">
        <div class="ws-strip ws-strip-left">
          <div class="ws-grip" title="拖此手柄到别组 = 合并整组" @pointerdown="onGripPointerDown($event)">
            <Icon name="grip" :size="14" /><span class="ws-grip-n">{{ group.tabs.length }}</span>
          </div>
          <button
            v-for="(tab, i) in group.tabs"
            :key="tab.id"
            class="ws-tab"
            :class="{ active: tab.id === group.activeTabId, dragging: drag.active && drag.tabId === tab.id, ['st-' + statusOf(tab.id)]: true }"
            :data-ws-tab="`${group.id}:${tab.id}:${i}`"
            :title="titleOf(tab.id)"
            @pointerdown="onTabPointerDown($event, tab)"
          >
            <span class="ws-tab-title">{{ titleOf(tab.id) }}</span>
            <span class="ws-tab-close" @click.stop="store.removeTab(tab.id)" @pointerdown.stop><Icon name="x" :size="12" /></span>
          </button>
          <div class="ws-strip-actions">
            <button class="ws-act" title="加终端" @click="store.openAdd(group.id)"><Icon name="plus" :size="14" /></button>
            <button class="ws-act" title="标签栏转顶部" @click="toggleStrip"><Icon name="panel-top" :size="14" /></button>
            <button v-if="!store.poppedMode" class="ws-act" title="弹出到独立窗口" @click="store.popOutGroup(group.id)"><Icon name="arrow-up-right" :size="14" /></button>
          </div>
        </div>
      </Pane>
      <Pane>
        <div :data-ws-area="group.id" class="ws-term-wrap">
          <TerminalSlot :key="activeTab.id" :tab-id="activeTab.id" :descriptor="activeTab" />
          <DropZones :zone="areaZone" />
          <div v-if="chipMarkIndex >= 0 && chipMarkIndex === group.tabs.length" class="ws-drop-mark-v" />
          <div v-if="statusOf(activeTab.id) !== 'live' && statusOf(activeTab.id) !== 'connecting'" class="ws-status">
            <span>{{ terminalRegistry.get(activeTab.id)?.statusMsg.value }}</span>
            <button class="ws-act" @click="terminalRegistry.reconnect(activeTab.id)">重连</button>
          </div>
        </div>
      </Pane>
    </Splitpanes>

    <!-- 横向标签栏：顶部一排 + 终端 -->
    <template v-else>
      <div class="ws-strip ws-strip-top">
        <div class="ws-grip" title="拖此手柄到别组 = 合并整组" @pointerdown="onGripPointerDown($event)">
          <Icon name="grip" :size="14" /><span class="ws-grip-n">{{ group.tabs.length }}</span>
        </div>
        <template v-for="(tab, i) in group.tabs" :key="tab.id">
          <span v-if="chipMarkIndex === i" class="ws-drop-mark-top" />
          <button
            class="ws-tab"
            :class="{ active: tab.id === group.activeTabId, dragging: drag.active && drag.tabId === tab.id, ['st-' + statusOf(tab.id)]: true }"
            :data-ws-tab="`${group.id}:${tab.id}:${i}`"
            :title="titleOf(tab.id)"
            @pointerdown="onTabPointerDown($event, tab)"
          >
            <span class="ws-tab-title">{{ titleOf(tab.id) }}</span>
            <span class="ws-tab-close" @click.stop="store.removeTab(tab.id)" @pointerdown.stop><Icon name="x" :size="12" /></span>
          </button>
        </template>
        <span v-if="chipMarkIndex === group.tabs.length" class="ws-drop-mark-top" />
        <button class="ws-act" title="加终端" @click="store.openAdd(group.id)"><Icon name="plus" :size="14" /></button>
        <button class="ws-act" title="标签栏转左侧" @click="toggleStrip"><Icon name="panel-left" :size="14" /></button>
        <button v-if="!store.poppedMode" class="ws-act" title="弹出到独立窗口" @click="store.popOutGroup(group.id)"><Icon name="arrow-up-right" :size="14" /></button>
      </div>
      <div :data-ws-area="group.id" class="ws-term-wrap flex-1 min-h-0">
        <TerminalSlot :key="activeTab.id" :tab-id="activeTab.id" :descriptor="activeTab" />
        <DropZones :zone="areaZone" />
        <div v-if="statusOf(activeTab.id) !== 'live' && statusOf(activeTab.id) !== 'connecting'" class="ws-status">
          <span>{{ terminalRegistry.get(activeTab.id)?.statusMsg.value }}</span>
          <button class="ws-act" @click="terminalRegistry.reconnect(activeTab.id)">重连</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ws-group {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #1a1a1a;
}
.ws-strip-split { height: 100%; }
.ws-strip {
  display: flex;
  background: #161616;
  border-bottom: 1px solid #2a2a2a;
}
.ws-strip-top { flex-direction: row; align-items: stretch; height: 32px; flex-shrink: 0; padding: 0 4px; gap: 2px; }
.ws-strip-left { flex-direction: column; height: 100%; overflow-y: auto; padding: 4px; gap: 2px; border-bottom: none; border-right: 1px solid #2a2a2a; }
.ws-grip {
  display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: #8ab4f8;
  background: #2a2a2a; border: 1px solid #3a3a3a; border-radius: 4px; cursor: grab; padding: 3px 6px;
  flex-shrink: 0; user-select: none; touch-action: none;
}
.ws-grip:hover { background: #333; border-color: #8ab4f8; }
.ws-grip:active { cursor: grabbing; }
.ws-grip-n { font-weight: 600; }
.ws-strip-top .ws-grip { align-self: center; height: 22px; }
.ws-tab {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: transparent; border: none;
  color: #aaa; cursor: grab; border-radius: 4px; font-size: 12px; white-space: nowrap; flex-shrink: 0;
  position: relative; user-select: none; touch-action: none;
}
.ws-tab:active { cursor: grabbing; }
.ws-strip-left .ws-tab { width: 100%; justify-content: space-between; }
.ws-tab:hover { background: #ffffff14; }
.ws-tab.active { background: #2a2a2a; color: #ddd; }
.ws-tab.dragging { opacity: 0.4; }
.ws-tab-title { overflow: hidden; text-overflow: ellipsis; }
.ws-strip-left .ws-tab-title { white-space: normal; word-break: break-all; }
.ws-tab-close { display: flex; align-items: center; border-radius: 3px; padding: 1px; color: #888; opacity: 0; cursor: pointer; }
.ws-tab:hover .ws-tab-close, .ws-tab.active .ws-tab-close { opacity: 1; }
.ws-tab-close:hover { background: #ffffff22; color: #ddd; }
.ws-tab.st-live { border-left: 2px solid #4ade80; }
.ws-tab.st-connecting { border-left: 2px solid #facc15; }
.ws-tab.st-exited { border-left: 2px solid #6b7280; }
.ws-tab.st-locked, .ws-tab.st-error { border-left: 2px solid #f87171; }
.ws-strip-actions { margin-top: auto; display: flex; gap: 2px; }
.ws-act {
  display: inline-flex; align-items: center; background: transparent; border: none; color: #888;
  cursor: pointer; border-radius: 4px; padding: 4px;
}
.ws-act:hover { background: #ffffff14; color: #ddd; }
.ws-term-wrap { position: relative; height: 100%; }
.ws-status {
  position: absolute; left: 8px; bottom: 8px; display: flex; align-items: center; gap: 8px;
  padding: 4px 10px; font-size: 12px; color: #f87171; background: #1d1d1dcc; border: 1px solid #333; border-radius: 4px;
}
.ws-drop-mark-top { width: 2px; align-self: stretch; background: #8ab4f8; margin: 4px 0; flex-shrink: 0; }
.ws-drop-mark-v { height: 2px; background: #8ab4f8; margin: 1px 0; }
</style>
