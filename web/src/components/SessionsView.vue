<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { refDebounced } from '@vueuse/core';
import { NInput, NSpin, NEmpty } from 'naive-ui';
import { useSessionStore } from '../stores/session';
import { api, type ProjectEntry, type SessionEntry } from '../api';
import { renderContent, hl, fmtBytes } from '../lib/render';

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
  store.select(dir, s.sessionId, s.preview || s.sessionId.slice(0, 8));
}

function sessionSub(s: SessionEntry): string {
  return `${new Date(s.mtimeMs).toLocaleString()} · ${fmtBytes(s.size)} · ${s.sessionId.slice(0, 8)}`;
}

function msgRole(m: (typeof messages.value)[number]): string {
  return (m.message?.role as string) || m.type;
}
</script>

<template>
  <div class="h-full grid grid-cols-[340px_1fr]">
    <aside class="border-r border-[#333] overflow-auto">
      <div class="sticky top-0 bg-[#1a1a1a] p-2 border-b border-[#333] z-[1]">
        <div class="text-[#8ab4f8] text-[15px] mb-2">Claude sessions</div>
        <NInput v-model:value="search" placeholder="搜索目录或 session…" size="small" clearable />
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

    <main class="flex flex-col overflow-hidden">
      <div class="px-4 pt-3">
        <div class="text-[12px] text-[#888] mb-2">{{ store.title || '选择左侧的工作目录' }}</div>
      </div>
      <div class="flex-1 overflow-auto px-4 pb-3">
        <div v-if="!store.sessionId" class="empty">选择一个 session 查看消息</div>
        <div v-else-if="messagesQuery.isLoading.value" class="empty"><NSpin size="small" /></div>
        <template v-else>
          <div
            v-for="(m, i) in messages"
            :key="m.uuid || i"
            :class="['msg', msgRole(m)]"
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
      </div>
    </main>
  </div>
</template>