<script setup lang="ts">
import { computed } from 'vue';
import { NConfigProvider, NMessageProvider, darkTheme } from 'naive-ui';
import { useUiStore } from './stores/ui';
import { useConfig } from './composables/useConfig';
import SessionsView from './components/SessionsView.vue';
import ChatView from './components/ChatView.vue';

const ui = useUiStore();
const config = useConfig();
const modelInfo = computed(() => {
  const c = config.data.value;
  return c?.hasAuth ? `${c.model} · ${c.baseURL}` : '未配置 API';
});
</script>

<template>
  <NConfigProvider :theme="darkTheme">
    <NMessageProvider>
      <div class="h-screen flex flex-col">
        <div class="topnav">
          <button :class="{ active: ui.view === 'sessions' }" @click="ui.setView('sessions')">Sessions</button>
          <button :class="{ active: ui.view === 'chat' }" @click="ui.setView('chat')">Chat</button>
          <span class="model-info">{{ modelInfo }}</span>
        </div>
        <div class="flex-1 min-h-0">
          <SessionsView v-show="ui.view === 'sessions'" />
          <ChatView v-show="ui.view === 'chat'" />
        </div>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>