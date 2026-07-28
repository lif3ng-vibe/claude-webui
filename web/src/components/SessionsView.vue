<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { refDebounced } from '@vueuse/core';
import { NInput, NSpin, NEmpty } from 'naive-ui';
import { useSessionStore } from '../stores/session';
import { api, type ProjectEntry, type SessionEntry } from '../api';
import { renderContent, hl, fmtBytes, esc } from '../lib/render';
import { readSSE, type SSEEvent } from '../lib/sse';

const store = useSessionStore();
const search = ref('');
const q = refDebounced(search, 200);
const expanded = ref<Set<string>>(new Set());
const sessionsCache = ref<Record<string, SessionEntry[]>>({});
const allLoaded = ref(false);

const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects });
const projects = computed(() => projectsQuery.data.value ?? []);

const messagesQuery = useQuery({
  queryKey: computed(() => ['messages', store.dirName, store.sessionId]),
  queryFn: () => api.messages(store.dirName, store.sessionId),
  enabled: computed(() => !!store.sessionId),
});
const messages = computed(() => messagesQuery.data.value ?? []);

async function loadSessions(dir: string): Promise<void> {
  if (!sessionsCache.value[dir]) sessionsCache.value[dir] = await api.sessions(dir);
}
async function loadAllSessions(): Promise<void> {
  await Promise.all(projects.value.map((p) => loadSessions(p.dirName)));
}

// 搜索非空时预加载所有 session，以支持按 session 名称过滤
watch(q, async (val) => {
  if (val && !allLoaded.value) {
    await loadAllSessions();
    allLoaded.value = true;
  }
});

function toggle(p: ProjectEntry): void {
  const s = new Set(expanded.value);
  if (s.has(p.dirName)) s.delete(p.dirName);
  else {
    s.add(p.dirName);
    void loadSessions(p.dirName);
  }
  expanded.value = s;
}

interface TreeNode {
  p: ProjectEntry;
  show: boolean;
  open: boolean;
  sessions: SessionEntry[];
}

const tree = computed<TreeNode[]>(() => {
  const term = q.value.trim().toLowerCase();
  return projects.value.map((p) => {
    if (!term) {
      return { p, show: true, open: expanded.value.has(p.dirName), sessions: (sessionsCache.value[p.dirName] || []).slice() };
    }
    const dirMatch = p.cwd.toLowerCase().includes(term);
    const sm = (s: SessionEntry) => (s.preview || '').toLowerCase().includes(term) || s.sessionId.toLowerCase().includes(term);
    const matching = (sessionsCache.value[p.dirName] || []).filter(sm);
    const show = dirMatch || matching.length > 0;
    const open = matching.length > 0; // 有 session 命中才展开；目录命中但无 session 命中不展开
    const sessions = dirMatch ? (sessionsCache.value[p.dirName] || []).slice() : matching;
    return { p, show, open, sessions };
  });
});

function selectSession(dir: string, s: SessionEntry): void {
  live.value = [];
  store.select(dir, s.sessionId, s.preview || s.sessionId.slice(0, 8));
}

function sessionSub(s: SessionEntry): string {
  return `${new Date(s.mtimeMs).toLocaleString()} · ${fmtBytes(s.size)} · ${s.sessionId.slice(0, 8)}`;
}

function refresh(): void {
  live.value = [];
  void messagesQuery.refetch();
}

// —— 续接 session（CLI 包裹，SSE 流式 live 块）——
const promptInput = ref('');
const running = ref(false);
const abortCtrl = ref<AbortController | null>(null);
const live = ref<Array<{ id: number; html: string }>>([]);
const timelineRef = ref<HTMLElement | null>(null);
let liveId = 0;

function appendStreamEvent(ev: SSEEvent): void {
  let html = '';
  if (ev.event === 'stream-json') {
    const d = ev.data;
    if (d?.type === 'assistant' && d.message?.content)
      html = `<div class="msg assistant live"><div class="role">assistant · live</div><div class="body">${renderContent(d.message.content)}</div></div>`;
    else if (d?.type === 'user' && d.message?.content)
      html = `<div class="msg user live"><div class="role">tool · live</div><div class="body">${renderContent(d.message.content)}</div></div>`;
    else if (d?.type === 'result')
      html = `<div class="msg live"><div class="role">result · live</div><div class="body">${esc(typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? ''))}</div></div>`;
    else if (d?.type !== 'system')
      html = `<div class="msg live"><div class="role">${esc(d?.type ?? 'event')} · live</div></div>`;
  } else if (ev.event === 'stderr') {
    html = `<div class="msg tool live"><div class="role">stderr · live</div><div class="body tool-result">${esc(ev.data?.text ?? '')}</div></div>`;
  } else if (ev.event === 'exit') {
    html = `<div class="msg live"><div class="role">exit · live · code=${ev.data?.code}</div></div>`;
  } else if (ev.event === 'error') {
    html = `<div class="msg tool live"><div class="role">error · live</div><div class="body tool-result">${esc(ev.data?.error ?? '')}</div></div>`;
  }
  if (html) live.value.push({ id: liveId++, html });
}

async function sendPrompt(): Promise<void> {
  if (!store.dirName || !store.sessionId) return;
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  if (!confirm('将运行 claude --resume（--dangerously-skip-permissions），会真实修改该 session 及其工作目录。确认？')) return;
  promptInput.value = '';
  running.value = true;
  abortCtrl.value = new AbortController();
  try {
    const resp = await fetch(`/api/projects/${store.dirName}/sessions/${store.sessionId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: abortCtrl.value.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
    await readSSE(resp, appendStreamEvent);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') appendStreamEvent({ event: 'error', data: { error: String(e) } });
  } finally {
    running.value = false;
    abortCtrl.value = null;
  }
}

watch(
  () => live.value.length,
  async () => {
    await nextTick();
    if (timelineRef.value) timelineRef.value.scrollTop = timelineRef.value.scrollHeight;
  },
);

function msgRole(m: (typeof messages.value)[number]): string {
  return (m.message?.role as string) || m.type;
}

function msgClass(m: (typeof messages.value)[number]): string {
  if (m.type === 'tool_result' || m.toolUseResult) return 'tool';
  return (m.message?.role as string) || m.type;
}

// 只渲染有内容的消息，跳过 mode/permission-mode/file-history-snapshot/ai-title/system 等 meta 行
const visibleMessages = computed(() =>
  messages.value.filter((m) => {
    if (m.type === 'user' || m.type === 'assistant') return m.message?.content != null && m.message.content !== '';
    if (m.type === 'tool_result' || m.toolUseResult) return true;
    return false;
  }),
);
</script>

<template>
  <div class="h-screen grid grid-cols-[340px_1fr]">
    <aside class="min-h-0 overflow-auto border-r border-[#333]">
      <div class="sticky top-0 bg-[#1a1a1a] p-2 border-b border-[#333] z-[1]">
        <div class="text-[#8ab4f8] text-[15px] mb-2">Claude sessions</div>
        <NInput v-model:value="search" placeholder="搜索目录或 session…" size="small" clearable />
        <button v-if="expanded.size" class="collapse-all" @click="expanded = new Set()">全部收起</button>
      </div>
      <div class="p-2">
        <div v-if="projectsQuery.isLoading.value" class="empty"><NSpin size="small" /></div>
        <NEmpty v-else-if="!projects.length" description="没有 session" />
        <template v-else>
          <template v-for="node in tree" :key="node.p.dirName">
            <div v-if="node.show" class="item project" @click="toggle(node.p)">
              <span class="caret">{{ node.open ? '▾' : '▸' }}</span>
              <span class="title" v-html="hl(node.p.cwd, q)" />
              <span class="sub">{{ node.p.sessionCount }}</span>
            </div>
            <div v-if="node.show && node.open" class="sub-tree">
              <div
                v-for="s in node.sessions"
                :key="s.sessionId"
                class="item session"
                :class="{ active: store.sessionId === s.sessionId }"
                @click.stop="selectSession(node.p.dirName, s)"
              >
                <div class="title" v-html="hl(s.preview || s.sessionId.slice(0, 8), q)" />
                <div class="sub">{{ sessionSub(s) }}</div>
              </div>
            </div>
          </template>
        </template>
      </div>
    </aside>

    <main class="min-h-0 flex flex-col overflow-hidden">
      <div class="px-4 pt-3 pb-2 flex items-center gap-2">
        <div class="text-[12px] text-[#888] flex-1 truncate">{{ store.title || '选择左侧的工作目录' }}</div>
        <button v-if="store.sessionId" class="ask" @click="refresh()">刷新</button>
      </div>
      <div ref="timelineRef" class="flex-1 min-h-0 overflow-auto px-4 pb-3">
        <div v-if="!store.sessionId" class="empty">选择一个 session 查看消息</div>
        <div v-else-if="messagesQuery.isLoading.value" class="empty"><NSpin size="small" /></div>
        <template v-else>
          <div
            v-for="(m, i) in visibleMessages"
            :key="m.uuid || i"
            :class="['msg', msgClass(m)]"
          >
            <template v-if="m.type === 'user' || m.type === 'assistant'">
              <div class="role-row">
                <span class="role">{{ msgRole(m) }}</span>
                <span class="time">{{ m.timestamp ? new Date(m.timestamp).toLocaleString() : '' }}</span>
              </div>
              <div class="body" v-html="renderContent(m.message?.content)" />
            </template>
            <template v-else-if="m.type === 'tool_result' || m.toolUseResult">
              <div class="role">tool</div>
              <div class="body">
                <details>
                  <summary class="tool-result">↳ result</summary>
                  <pre>{{ JSON.stringify(m.toolUseResult ?? m.raw, null, 2).slice(0, 2000) }}</pre>
                </details>
              </div>
            </template>
          </div>
        </template>
        <div v-for="l in live" :key="l.id" v-html="l.html"></div>
      </div>
      <div v-if="store.sessionId" class="composer">
        <textarea
          v-model="promptInput"
          :disabled="running"
          placeholder="向该 session 发送指令…（skip-permissions 运行 claude --resume，Ctrl/Cmd+Enter 发送）"
          @keydown.ctrl.enter.prevent="sendPrompt"
          @keydown.meta.enter.prevent="sendPrompt"
        ></textarea>
        <button class="send" :disabled="running || !promptInput.trim()" @click="sendPrompt">发送</button>
        <button v-if="running" class="stop" @click="abortCtrl?.abort()">停止</button>
      </div>
    </main>
  </div>
</template>