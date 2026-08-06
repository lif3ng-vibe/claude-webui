<script setup lang="ts">
// 终端工作区主页：载入持久化布局，递归渲染 split 树；空态引导加终端。
// 弹出窗模式（?pop=<id>）：只渲染被弹出的子树、不持久化；关闭/收回时广播回主窗口。
// 终端实例在 registry（模块单例），离开本页不销毁、返回原样接回。
import { onMounted, onUnmounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useWorkspaceStore } from '../stores/workspace';
import { terminalRegistry } from '../lib/workspace/registry';
import { readPop, clearPop, broadcastDock, onDocked } from '../lib/workspace/popout';
import { closeWindow, isDesktop } from '../lib/desktop';
import SplitLayout from '../components/workspace/SplitLayout.vue';
import AddTerminalDialog from '../components/workspace/AddTerminalDialog.vue';
import Icon from '../components/Icon.vue';
import { setTitle } from '../lib/head';
import { useWorkspaceSync } from '../composables/useWorkspaceSync';

const store = useWorkspaceStore();
const route = useRoute();
/** 根分屏（存在=有多个分区，显示"翻转排列方向"钮）。 */
const rootSplit = computed(() => (store.root && store.root.type === 'split' ? store.root : null));
useWorkspaceSync();
let unsubDock: (() => void) | null = null;
let beforeUnload: (() => void) | null = null;

onMounted(() => {
  const popId = typeof route.query.pop === 'string' ? route.query.pop : '';
  if (popId) {
    // 弹出窗模式：渲染传入子树
    const subtree = readPop(popId);
    clearPop(popId);
    if (subtree) store.loadPopped(subtree);
    setTitle('终端（弹出）· claude-webui');
    // 关闭即收回：广播子树 + 释放本窗终端（让主窗口重连）
    beforeUnload = () => sendDock();
    window.addEventListener('beforeunload', beforeUnload);
  } else {
    // 主窗口：载入持久化布局 + 监听收回
    setTitle('终端工作区 · claude-webui');
    if (!store.loaded) void store.load();
    unsubDock = onDocked((subtree) => store.dock(subtree));
  }
});

onUnmounted(() => {
  unsubDock?.();
  if (beforeUnload) window.removeEventListener('beforeunload', beforeUnload);
});

/** 弹出窗"收回"：广播子树回主窗口后关闭。防重复广播（按钮 + beforeunload 都可能触发）。 */
let dockSent = false;
function sendDock(): void {
  if (dockSent || !store.root) return;
  dockSent = true;
  broadcastDock(store.root);
  terminalRegistry.releaseAll();
}
/** 弹出窗"收回"：广播 + 关窗（桌面端走 bridge close；web 走 window.close）。 */
function dockBack(): void {
  sendDock();
  if (isDesktop) closeWindow();
  else window.close();
}
</script>

<template>
  <div class="ws-page">
    <div class="ws-topbar">
      <Icon name="terminal" :size="15" />
      <span class="ws-title">{{ store.poppedMode ? '终端（弹出）' : '终端工作区' }}</span>
      <span v-if="!store.poppedMode" class="ws-hint">💡 拖标签＝重排/移动 · 拖手柄⠿＝合并整组 · 拖标签到终端边缘＝分屏 · ↗＝弹出窗口</span>
      <button v-if="!store.poppedMode && rootSplit" class="ws-add" :title="rootSplit.orientation === 'horizontal' ? '当前左右排列，点击转上下' : '当前上下排列，点击转左右'" @click="store.flipSplit(rootSplit.id)"><Icon :name="rootSplit.orientation === 'horizontal' ? 'layout-horizontal' : 'layout-vertical'" :size="14" /> 排列</button>
      <button v-if="store.poppedMode" class="ws-add" title="收回进主工作区" @click="dockBack"><Icon name="arrow-left" :size="14" /> 收回</button>
      <button v-else class="ws-add" @click="store.openAdd()"><Icon name="plus" :size="14" /> 加终端</button>
    </div>
    <div class="ws-body">
      <div v-if="!store.loaded" class="ws-empty">加载中…</div>
      <div v-else-if="!store.root" class="ws-empty">
        <Icon name="terminal" :size="40" />
        <p>还没有终端</p>
        <button class="ws-add" @click="store.openAdd()"><Icon name="plus" :size="14" /> 加终端</button>
      </div>
      <SplitLayout v-else :node="store.root" />
    </div>
    <AddTerminalDialog />
  </div>
</template>

<style scoped>
.ws-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #1a1a1a;
}
.ws-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid #2a2a2a;
  background: #161616;
  color: #ddd;
  flex-shrink: 0;
}
.ws-title {
  font-size: 13px;
  font-weight: 600;
}
.ws-hint {
  font-size: 11px;
  color: #777;
  margin-left: 4px;
}
.ws-add {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #ddd;
  background: #2a2a2a;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
}
.ws-add:hover {
  background: #333;
}
.ws-body {
  flex: 1;
  min-height: 0;
}
.ws-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #666;
  font-size: 14px;
}
</style>
