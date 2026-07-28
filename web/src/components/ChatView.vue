<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { NSelect } from 'naive-ui';
import { api } from '../api';
import { renderMd } from '../lib/render';
import { readSSE } from '../lib/sse';
import { useConfig } from '../composables/useConfig';

const promptsQuery = useQuery({ queryKey: ['prompts'], queryFn: api.prompts });
const prompts = computed(() => promptsQuery.data.value ?? []);
const presetOptions = computed(() => prompts.value.map((p) => ({ label: p.title, value: p.id })));
const selectedPreset = ref<string | null>(null);
const systemPrompt = ref('');

const config = useConfig();
const providerOptions = computed(() =>
  (config.data.value?.providers ?? []).map((p) => ({ label: `${p.name}${p.isEnv ? ' (env)' : ''}`, value: p.id })),
);
const selectedProviderId = ref<string>('');
watch(
  () => config.data.value,
  (c) => {
    if (c && !selectedProviderId.value) selectedProviderId.value = c.activeProviderId;
  },
  { immediate: true },
);

const chatInput = ref('');
const sending = ref(false);
const chatAbort = ref<AbortController | null>(null);
const chatTimelineRef = ref<HTMLElement | null>(null);
const chatScrollTick = ref(0);

interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  content: string; // user 文本
  bodyText: string; // assistant 累积文本
  thinking: string;
  bodyHtml: string;
}
const chatMsgs = ref<ChatMsg[]>([]);
let chatId = 0;

watch(
  chatScrollTick,
  async () => {
    await nextTick();
    if (chatTimelineRef.value) chatTimelineRef.value.scrollTop = chatTimelineRef.value.scrollHeight;
  },
);

function onPresetChange(v: string | null): void {
  selectedPreset.value = v;
  const p = prompts.value.find((x) => x.id === v);
  systemPrompt.value = p ? p.text : '';
}

async function sendChat(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  sending.value = true;
  chatAbort.value = new AbortController();
  chatMsgs.value.push({ id: chatId++, role: 'user', content: text, bodyText: '', thinking: '', bodyHtml: '' });
  chatMsgs.value.push({ id: chatId++, role: 'assistant', content: '', bodyText: '', thinking: '', bodyHtml: '' });
  const a = chatMsgs.value[chatMsgs.value.length - 1];
  chatScrollTick.value++;
  try {
    const messages = chatMsgs.value
      .filter((m) => m.id !== a.id)
      .map((m) => ({ role: m.role, content: m.role === 'user' ? m.content : m.bodyText }));
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, systemPrompt: systemPrompt.value.trim() || undefined, providerId: selectedProviderId.value }),
      signal: chatAbort.value.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
    await readSSE(resp, (ev) => {
      if (ev.event === 'thinking') a.thinking += ev.data?.text ?? '';
      else if (ev.event === 'text') a.bodyText += ev.data?.text ?? '';
      else if (ev.event === 'error') a.bodyText += `\n[error] ${ev.data?.error ?? ''}`;
      chatScrollTick.value++;
    });
    if (a.bodyText) a.bodyHtml = renderMd(a.bodyText);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') a.bodyText += `\n[error] ${String(e)}`;
    if (a.bodyText) a.bodyHtml = renderMd(a.bodyText);
  } finally {
    sending.value = false;
    chatAbort.value = null;
  }
}
</script>

<template>
  <div class="h-full grid grid-cols-[300px_1fr]">
    <aside class="min-h-0 overflow-auto border-r border-[#333] p-2.5">
      <div class="text-[12px] text-[#888]">Provider</div>
      <NSelect v-model:value="selectedProviderId" :options="providerOptions" size="small" class="mb-2.5" placeholder="选择 provider" />
      <div class="text-[12px] text-[#888]">系统提示词</div>
      <NSelect
        :value="selectedPreset"
        :options="presetOptions"
        size="small"
        placeholder="（不选预设）"
        clearable
        class="mt-1.5"
        @update:value="onPresetChange"
      />
      <textarea v-model="systemPrompt" class="sys-prompt" placeholder="选择上方预设或自行编辑系统提示词…"></textarea>
      <div class="preset-hint">预置提示词存于 ~/.claude-webui/prompts.json</div>
    </aside>

    <main class="min-h-0 flex flex-col overflow-hidden">
      <div ref="chatTimelineRef" class="flex-1 min-h-0 overflow-auto px-4 py-3">
        <div v-if="!chatMsgs.length" class="empty">发一条消息开始对话…</div>
        <div v-for="m in chatMsgs" :key="m.id" :class="['msg', m.role]">
          <div class="role">{{ m.role }}</div>
          <div v-if="m.role === 'user'" class="body">{{ m.content }}</div>
          <template v-else>
            <div v-if="m.thinking" class="thinking">{{ m.thinking }}</div>
            <div v-if="m.bodyHtml" class="body" v-html="m.bodyHtml" />
            <div v-else-if="m.bodyText" class="body">{{ m.bodyText }}</div>
          </template>
        </div>
      </div>
      <div class="composer">
        <textarea
          v-model="chatInput"
          :disabled="sending"
          placeholder="发消息…（Ctrl/Cmd+Enter 发送）"
          @keydown.ctrl.enter.prevent="sendChat"
          @keydown.meta.enter.prevent="sendChat"
        ></textarea>
        <button class="send" :disabled="sending || !chatInput.trim()" @click="sendChat">发送</button>
        <button v-if="sending" class="stop" @click="chatAbort?.abort()">停止</button>
      </div>
    </main>
  </div>
</template>