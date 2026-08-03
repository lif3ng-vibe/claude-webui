<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { refDebounced } from '@vueuse/core';
import { NInput, NSpin, NEmpty, NSelect, NPopover, NCheckbox, useMessage } from 'naive-ui';
import { api, type SessionEntry } from '../api';
import { useDisplayStore } from '../stores/display';
import { hl, fmtBytes, fmtTime } from '../lib/render';
import Icon from '../components/Icon.vue';
import { setTitle } from '../lib/head';
import { openWindow } from '../lib/openWindow';

const route = useRoute();
const router = useRouter();
const dir = computed(() => String(route.params.dir));

const display = useDisplayStore();
const msg = useMessage();
const sessionSortOptions = [
  { label: '更新时间', value: 'updated' },
  { label: '名称', value: 'name' },
  { label: '大小', value: 'size' },
];

// 侧栏显隐设置（Ctrl/Cmd 点击 = 只选当前这一项）
type BoolKey = 'showSessionSub' | 'showCountBadge';
const sidebarGroup: BoolKey[] = ['showSessionSub', 'showCountBadge'];
function onCheck(e: MouseEvent, key: BoolKey): void {
  const d = display as unknown as Record<string, boolean>;
  if (e.ctrlKey || e.metaKey) {
    for (const k of sidebarGroup) d[k] = k === key;
  } else {
    d[key] = !d[key];
  }
}

const sessionsQuery = useQuery({
  queryKey: computed(() => ['sessions', dir.value]),
  queryFn: () => api.sessions(dir.value),
});
const sessions = computed(() => sessionsQuery.data.value ?? []);

// 取工作目录真实 cwd 用于标题
const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects });
watchEffect(() => {
  const p = (projectsQuery.data.value ?? []).find((x) => x.dirName === dir.value);
  setTitle(p ? `${p.cwd} · Sessions` : 'Sessions · claude-webui');
});

// 运行中会话状态（3s 轮询）
const runningQuery = useQuery({ queryKey: ['running'], queryFn: api.running, refetchInterval: 3000 });
const runningMap = computed(() => new Map((runningQuery.data.value ?? []).map((r) => [r.sessionId, r.status])));
function runLabel(s?: string): string {
  return s === 'busy' ? '忙' : s === 'idle' ? '闲' : s || '运行中';
}

const search = ref('');
const q = refDebounced(search, 200);

const filtered = computed<SessionEntry[]>(() => {
  const term = q.value.trim().toLowerCase();
  const list = sessions.value.slice();
  if (term) {
    const sm = (s: SessionEntry) => (s.preview || '').toLowerCase().includes(term) || s.sessionId.toLowerCase().includes(term);
    return list.filter(sm);
  }
  list.sort((a, b) => {
    if (display.sessionSort === 'name') return (a.preview || '').localeCompare(b.preview || '');
    if (display.sessionSort === 'size') return b.size - a.size;
    return b.mtimeMs - a.mtimeMs;
  });
  return list;
});

function sessionSub(s: SessionEntry): string {
  return `${new Date(s.mtimeMs).toLocaleString()} · ${fmtBytes(s.size)} · ${s.sessionId.slice(0, 8)}`;
}

// 下钻到单 session（同窗口，触发 ItemLayout 的"返回"）
function openSession(s: SessionEntry): void {
  void router.push({ name: 'session', params: { dir: dir.value, sid: s.sessionId } });
}

// 在新窗口打开单 session
function popSession(s: SessionEntry): void {
  openWindow(`/projects/${encodeURIComponent(dir.value)}/sessions/${encodeURIComponent(s.sessionId)}`);
}

// 复制 resume 命令（cwd 取自 /api/projects 真实值）
function copyResume(s: SessionEntry): void {
  if (runningMap.value.has(s.sessionId) && !confirm('该 session 正在另一个终端运行，在另一终端 resume 可能导致分叉。仍要复制命令吗？')) return;
  const p = (projectsQuery.data.value ?? []).find((x) => x.dirName === dir.value);
  const cwd = p?.cwd ?? '';
  navigator.clipboard.writeText(`cd "${cwd}" && claude --resume ${s.sessionId}`).then(() => msg.success('已复制：cd 到目录并 resume')).catch(() => msg.error('复制失败'));
}
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="dir-header">
      <NPopover trigger="click" placement="bottom-end" :width="240">
        <template #trigger>
          <button class="icon-btn" title="显示与排序设置">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
          </button>
        </template>
        <div class="ds">
          <div class="ds-row"><span class="ds-lbl">session 排序</span><NSelect v-model:value="display.sessionSort" :options="sessionSortOptions" size="small" class="flex-1" /></div>
          <div class="ds-divider">侧栏显隐</div>
          <div class="ds-checks">
            <NCheckbox :checked="display.showSessionSub" @click="onCheck($event, 'showSessionSub')">session 子标题</NCheckbox>
            <NCheckbox :checked="display.showCountBadge" @click="onCheck($event, 'showCountBadge')">计数徽章</NCheckbox>
          </div>
        </div>
      </NPopover>
      <NInput v-model:value="search" placeholder="搜索本目录 session…" size="small" clearable class="dir-search" />
    </div>
    <div class="dir-list">
      <div v-if="sessionsQuery.isLoading.value" class="empty"><NSpin size="small" /></div>
      <NEmpty v-else-if="!filtered.length" description="没有 session" />
      <div v-for="s in filtered" :key="s.sessionId" class="item session" @click="openSession(s)">
        <div class="sess-head">
          <div class="title" :title="s.preview || s.sessionId.slice(0, 8)" v-html="hl(s.preview || s.sessionId.slice(0, 8), q)" />
          <button class="icon-btn-sm" title="复制 resume 命令" @click.stop="copyResume(s)"><Icon name="copy" :size="14" /></button>
          <button class="icon-btn-sm popout" title="新窗口打开该 session" @click.stop="popSession(s)"><Icon name="arrow-up-right" :size="14" /></button>
        </div>
        <div v-if="runningMap.has(s.sessionId)" class="run-badge" :class="runningMap.get(s.sessionId)"><span class="run-dot"></span>{{ runLabel(runningMap.get(s.sessionId)) }}</div>
        <div v-if="display.showSessionSub" class="sub" :title="sessionSub(s)">{{ sessionSub(s) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dir-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #333;
  background: #1a1a1a;
}
.dir-search {
  flex: 1;
}
.dir-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #888;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}
.icon-btn:hover {
  background: #ffffff14;
  color: #c8c8c8;
}
</style>