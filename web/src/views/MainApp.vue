<script setup lang="ts">
import { ref, computed } from 'vue';
import { NModal } from 'naive-ui';
import { useUiStore } from '../stores/ui';
import { useConfig } from '../composables/useConfig';
import SessionsView from '../components/SessionsView.vue';
import ChatView from '../components/ChatView.vue';
import ProviderSettings from '../components/ProviderSettings.vue';

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
  <div class="h-screen flex flex-col">
    <div class="topnav">
      <button :class="{ active: ui.view === 'sessions' }" @click="ui.setView('sessions')">Sessions</button>
      <button :class="{ active: ui.view === 'chat' }" @click="ui.setView('chat')">Chat</button>
      <span class="model-info">{{ modelInfo }}</span>
      <button class="settings-btn" title="Provider 设置" @click="settingsOpen = true">⚙</button>
    </div>
    <div class="flex-1 min-h-0">
      <SessionsView v-show="ui.view === 'sessions'" />
      <ChatView v-show="ui.view === 'chat'" />
    </div>
  </div>
  <NModal v-model:show="settingsOpen" :mask-closable="true">
    <ProviderSettings @close="settingsOpen = false" />
  </NModal>
</template>