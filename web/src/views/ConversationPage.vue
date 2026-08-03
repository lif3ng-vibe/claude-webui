<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { NSelect, NSpin, useMessage } from 'naive-ui';
import { api, saveConversation, deleteConversation, type ConvMessage, type Conversation } from '../api';
import { renderContent } from '../lib/render';
import Icon from '../components/Icon.vue';
import { readSSE } from '../lib/sse';
import { useConfig } from '../composables/useConfig';
import { setTitle, setFavicon, FAVICON } from '../lib/head';
import { broadcastInvalidate } from '../lib/broadcast';
import { openWindow } from '../lib/openWindow';

const route = useRoute();
const id = computed(() => String(route.params.id));
const qc = useQueryClient();

const convQuery = useQuery({
  queryKey: computed(() => ['conversation', id.value]),
  queryFn: () => api.conversation(id.value),
});
const conv = computed(() => convQuery.data.value);

const config = useConfig();
const msg = useMessage();
const providerOptions = computed(() =>
  (config.data.value?.providers ?? []).map((p) => ({ label: `${p.name}${p.isEnv ? ' (env)' : ''}`, value: p.id })),
);
const selectedProviderId = ref<string>('');

// 预置提示词库
const promptsQuery = useQuery({ queryKey: ['prompts'], queryFn: api.prompts });
const prompts = computed(() => promptsQuery.data.value ?? []);
const presetOptions = computed(() => prompts.value.map((p) => ({ label: p.title, value: p.id })));
const selectedPreset = ref<string | null>(null);
function onPresetChange(v: string | null): void {
  selectedPreset.value = v;
  const p = prompts.value.find((x) => x.id === v);
  systemPrompt.value = p ? p.text : '';
}

const systemPrompt = ref('');

// 加载后：title/favicon 按 kind，回填 provider/systemPrompt
watch(
  () => conv.value,
  (c) => {
    if (!c) return;
    setTitle(`${c.title} · ${c.kind === 'study' ? 'Study' : 'Chat'}`);
    setFavicon(c.kind === 'study' ? FAVICON.study : FAVICON.chat);
    systemPrompt.value = c.systemPrompt || '';
    if (c.providerId) selectedProviderId.value = c.providerId;
  },
);
watch(
  () => config.data.value,
  (c) => {
    if (c && !selectedProviderId.value) selectedProviderId.value = c.activeProviderId;
  },
  { immediate: true },
);

interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  bodyText: string;
  thinking: string;
  bodyHtml: string;
  requests: string[];
}
const chatMsgs = ref<ChatMsg[]>([]);
let chatId = 0;
watch(
  () => conv.value,
  (c) => {
    if (!c) return;
    chatMsgs.value = c.messages.map((m: ConvMessage) => ({
      id: chatId++,
      role: m.role,
      content: m.role === 'user' ? String(m.content ?? '') : '',
      bodyText: m.role === 'assistant' ? String(m.content ?? '') : '',
      thinking: '',
      bodyHtml: m.role === 'assistant' ? renderContent(m.content) : '',
      requests: [],
    }));
  },
);

const chatInput = ref('');
const sending = ref(false);
const chatAbort = ref<AbortController | null>(null);
const timelineRef = ref<HTMLElement | null>(null);
const scrollTick = ref(0);

function popCurrent(): void {
  if (conv.value) openWindow(`/conversations/${encodeURIComponent(conv.value.id)}`);
}

async function deleteCurrent(): Promise<void> {
  const c = conv.value;
  if (!c) return;
  if (!confirm(`删除对话「${c.title}」？`)) return;
  await deleteConversation(c.id);
  void qc.invalidateQueries({ queryKey: ['conversations'] });
  broadcastInvalidate([['conversations'], ['conversation', c.id]]);
  msg.success('已删除');
  // 删除后回到上一页（若从父项钻取来则有返回，否则回主页）
  if ((window.history.state?.position ?? 0) > 0) history.back();
  else window.location.href = '/';
}

watch(scrollTick, async () => {
  await nextTick();
  if (timelineRef.value) timelineRef.value.scrollTop = timelineRef.value.scrollHeight;
});

async function persist(c: Conversation): Promise<void> {
  const messages = chatMsgs.value.map((m) => ({ role: m.role, content: m.role === 'user' ? m.content : m.bodyText }));
  await saveConversation({
    id: c.id,
    kind: c.kind,
    title: c.title,
    systemPrompt: systemPrompt.value.trim() || undefined,
    providerId: selectedProviderId.value || undefined,
    messages,
  });
  void qc.invalidateQueries({ queryKey: ['conversations'] });
  broadcastInvalidate([['conversations'], ['conversation', c.id]]);
}

async function sendChat(): Promise<void> {
  const c = conv.value;
  if (!c) return;
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  sending.value = true;
  chatAbort.value = new AbortController();
  chatMsgs.value.push({ id: chatId++, role: 'user', content: text, bodyText: '', thinking: '', bodyHtml: '', requests: [] });
  chatMsgs.value.push({ id: chatId++, role: 'assistant', content: '', bodyText: '', thinking: '', bodyHtml: '', requests: [] });
  const a = chatMsgs.value[chatMsgs.value.length - 1];
  scrollTick.value++;
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
      if (ev.event === 'request') a.requests.push(JSON.stringify(ev.data?.request, null, 2));
      else if (ev.event === 'thinking') a.thinking += ev.data?.text ?? '';
      else if (ev.event === 'text') a.bodyText += ev.data?.text ?? '';
      else if (ev.event === 'error') a.bodyText += `\n[error] ${ev.data?.error ?? ''}`;
      scrollTick.value++;
    });
    if (a.bodyText) a.bodyHtml = renderContent(a.bodyText);
    void persist(c);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') a.bodyText += `\n[error] ${String(e)}`;
    if (a.bodyText) a.bodyHtml = renderContent(a.bodyText);
    void persist(c);
  } finally {
    sending.value = false;
    chatAbort.value = null;
  }
}
</script>

<template>
  <div class="relative h-full flex flex-col overflow-hidden">
    <div class="px-4 pt-3 pb-2 flex items-center gap-2">
      <div class="text-[12px] text-[#888] flex-1 truncate">{{ conv?.title || '加载中…' }}</div>
      <span v-if="conv" class="text-[11px] text-[#666]">{{ conv.kind === 'study' ? '深问' : '聊天' }}</span>
      <button v-if="conv" class="ask popout" title="新窗口打开该对话" @click="popCurrent"><Icon name="arrow-up-right" :size="13" /></button>
      <button v-if="conv" class="ask" title="删除对话" @click="deleteCurrent"><Icon name="trash" :size="13" /></button>
    </div>
    <div class="px-4 pb-2 flex items-center gap-2">
      <NSelect v-model:value="selectedProviderId" :options="providerOptions" size="small" placeholder="选择 provider" class="w-56" />
      <NSelect
        :value="selectedPreset"
        :options="presetOptions"
        size="small"
        placeholder="（不选预设）"
        clearable
        class="w-48"
        @update:value="onPresetChange"
      />
    </div>
    <div class="px-4 pb-2">
      <textarea v-model="systemPrompt" class="sys-prompt" placeholder="系统提示词（追问时附带）…"></textarea>
    </div>
    <div ref="timelineRef" class="flex-1 min-h-0 overflow-auto px-4 py-3">
      <div v-if="convQuery.isLoading.value" class="empty"><NSpin size="small" /></div>
      <template v-else>
        <div v-for="m in chatMsgs" :key="m.id" :class="['msg', m.role]">
          <div class="role">{{ m.role }}</div>
          <div v-if="m.role === 'user'" class="body">{{ m.content }}</div>
          <template v-else>
            <div v-if="m.thinking" class="thinking">{{ m.thinking }}</div>
            <div v-if="m.bodyHtml" class="body" v-html="m.bodyHtml" />
            <div v-else-if="m.bodyText" class="body">{{ m.bodyText }}</div>
            <details v-for="(r, i) in m.requests" :key="'req' + i" class="req-details">
              <summary>请求 #{{ i + 1 }}</summary>
              <pre>{{ r }}</pre>
            </details>
          </template>
        </div>
      </template>
    </div>
    <div class="composer">
      <textarea
        v-model="chatInput"
        :disabled="sending"
        placeholder="追问…（Ctrl/Cmd+Enter 发送）"
        @keydown.ctrl.enter.prevent="sendChat"
        @keydown.meta.enter.prevent="sendChat"
      ></textarea>
      <button class="send" :disabled="sending || !chatInput.trim()" @click="sendChat">发送</button>
      <button v-if="sending" class="stop" @click="chatAbort?.abort()">停止</button>
    </div>
  </div>
</template>