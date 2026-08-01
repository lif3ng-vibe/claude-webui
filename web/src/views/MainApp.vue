<script setup lang="ts">
import { ref, computed } from 'vue';
import { NModal } from 'naive-ui';
import { useUiStore } from '../stores/ui';
import { useConfig } from '../composables/useConfig';
import SessionsView from '../components/SessionsView.vue';
import ChatView from '../components/ChatView.vue';
import ProviderSettings from '../components/ProviderSettings.vue';
import FeishuSettings from '../components/FeishuSettings.vue';
import ServicePage from '../views/ServicePage.vue';
import { isDesktop } from '../lib/desktop';
import { openWindow } from '../lib/openWindow';

const ui = useUiStore();
const config = useConfig();
const settingsOpen = ref(false);

const modelInfo = computed(() => {
  const c = config.data.value;
  if (!c?.providers?.length) return '未配置 API';
  const p = c.providers.find((x) => x.id === c.activeProviderId) ?? c.providers[0];
  return p ? `${p.model} · ${p.baseURL}` : '未配置 API';
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="topnav">
      <button :class="{ active: ui.view === 'sessions' }" @click="ui.setView('sessions')">Sessions</button>
      <button :class="{ active: ui.view === 'chat' }" @click="ui.setView('chat')">Chat</button>
      <button v-if="isDesktop" :class="{ active: ui.view === 'service' }" @click="ui.setView('service')">服务</button>
      <span class="model-info">{{ modelInfo }}</span>
      <button v-if="isDesktop && ui.view === 'service'" class="icon-btn-sm" title="新窗口打开" @click="openWindow('/service')">↗</button>
      <button class="settings-btn" title="Provider 设置" @click="settingsOpen = true">⚙</button>
    </div>
    <div class="flex-1 min-h-0">
      <SessionsView v-show="ui.view === 'sessions'" />
      <ChatView v-show="ui.view === 'chat'" />
      <ServicePage v-show="ui.view === 'service'" />
    </div>
  </div>
  <NModal v-model:show="settingsOpen" :mask-closable="true">
    <div class="flex flex-col gap-2">
      <ProviderSettings @close="settingsOpen = false" />
      <FeishuSettings @close="settingsOpen = false" />
    </div>
  </NModal>
</template>