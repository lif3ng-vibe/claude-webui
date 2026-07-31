<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { refDebounced } from '@vueuse/core';
import { NInput, NSpin, NEmpty, NSelect, NPopover, NCheckbox, useMessage } from 'naive-ui';
import { useSessionStore } from '../stores/session';
import { useDisplayStore } from '../stores/display';
import { api, type ProjectEntry, type SessionEntry } from '../api';
import { renderContent, renderTool, renderMd, hl, fmtBytes, fmtTime, esc } from '../lib/render';
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

// 运行中的会话状态（每 3s 轮询），用于在列表标记“进行中”
const runningQuery = useQuery({ queryKey: ['running'], queryFn: api.running, refetchInterval: 3000 });
const runningMap = computed(() => new Map((runningQuery.data.value ?? []).map((r) => [r.sessionId, r.status])));
function runLabel(s?: string): string {
  return s === 'busy' ? '忙' : s === 'idle' ? '闲' : s || '运行中';
}

const msg = useMessage();
function copyResume(cwd: string, sid: string): void {
  if (runningMap.value.has(sid) && !confirm('该 session 正在另一个终端运行，在另一终端 resume 可能导致分叉。仍要复制命令吗？')) return;
  navigator.clipboard
    .writeText(`cd "${cwd}" && claude --resume ${sid}`)
    .then(() => msg.success('已复制：cd 到目录并 resume'))
    .catch(() => msg.error('复制失败'));
}

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

// 显示/排序偏好
const display = useDisplayStore();
const dirSortOptions = [
  { label: '最近更新', value: 'updated' },
  { label: '字母顺序', value: 'name' },
];
const sessionSortOptions = [
  { label: '更新时间', value: 'updated' },
  { label: '名称', value: 'name' },
  { label: '大小', value: 'size' },
];
// 按更新排序目录：latestMtimeMs 由后端 /api/projects 直接返回，无需预加载

// 显隐复选：Ctrl/Cmd 点击 = 只选当前这一项（同组其余置 false）
type BoolKey = 'showToolUse' | 'showToolResult' | 'showThinking' | 'showCountBadge' | 'showSessionSub' | 'showDirTime' | 'showCheckbox';
const timelineGroup: BoolKey[] = ['showToolUse', 'showToolResult', 'showThinking', 'showCheckbox'];
const sidebarGroup: BoolKey[] = ['showCountBadge', 'showSessionSub', 'showDirTime'];
function onCheck(e: MouseEvent, key: BoolKey, group: BoolKey[]): void {
  const d = display as unknown as Record<string, boolean>;
  if (e.ctrlKey || e.metaKey) {
    for (const k of group) d[k] = k === key;
  } else {
    d[key] = !d[key];
  }
}

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
  const nodes = projects.value.map((p) => {
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
  // 目录排序
  if (display.dirSort === 'updated') nodes.sort((a, b) => b.p.latestMtimeMs - a.p.latestMtimeMs);
  else nodes.sort((a, b) => a.p.cwd.localeCompare(b.p.cwd));
  // 各目录内 session 排序
  for (const n of nodes) {
    n.sessions.sort((a, b) => {
      if (display.sessionSort === 'name') return (a.preview || '').localeCompare(b.preview || '');
      if (display.sessionSort === 'size') return b.size - a.size;
      return b.mtimeMs - a.mtimeMs; // updated
    });
  }
  return nodes;
});

function selectSession(dir: string, s: SessionEntry): void {
  live.value = [];
  studyBlocks.value = [];
  clearSelection();
  store.select(dir, s.sessionId, s.preview || s.sessionId.slice(0, 8));
}

function sessionSub(s: SessionEntry): string {
  return `${new Date(s.mtimeMs).toLocaleString()} · ${fmtBytes(s.size)} · ${s.sessionId.slice(0, 8)}`;
}

function refresh(): void {
  live.value = [];
  studyBlocks.value = [];
  clearSelection();
  void messagesQuery.refetch();
}

// —— 续接 session（CLI 包裹，SSE 流式 live 块）——
const promptInput = ref('');
const running = ref(false);
const abortCtrl = ref<AbortController | null>(null);
const live = ref<Array<{ id: number; html: string }>>([]);
const timelineRef = ref<HTMLElement | null>(null);
let liveId = 0;
const scrollTick = ref(0);

interface StudyBlock {
  id: number;
  question: string;
  thinking: string;
  tools: { id: number; html: string }[];
  bodyText: string;
  bodyHtml: string;
  requests: string[];
}
const studyBlocks = ref<StudyBlock[]>([]);
let studyId = 0;
let toolId = 0;

function appendStreamEvent(ev: SSEEvent): void {
  let html = '';
  if (ev.event === 'stream-json') {
    const d = ev.data;
    if (d?.type === 'assistant' && d.message?.content)
      html = `<div class="msg assistant live"><div class="role">assistant · live</div><div class="body">${renderContent(d.message.content, '', renderOpts.value)}</div></div>`;
    else if (d?.type === 'user' && d.message?.content)
      html = `<div class="msg user live"><div class="role">tool · live</div><div class="body">${renderContent(d.message.content, '', renderOpts.value)}</div></div>`;
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
  if (html) {
    live.value.push({ id: liveId++, html });
    scrollTick.value++;
  }
}

async function sendPrompt(): Promise<void> {
  if (!store.dirName || !store.sessionId) return;
  if (runningMap.value.has(store.sessionId) && !confirm('该 session 正在另一个终端运行，继续可能导致分叉。仍要继续吗？')) return;
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

// —— 深问：就某一步向 LLM 提问 + 只读磁盘工具查证 ——
function stepPayload(m: (typeof messages.value)[number]): unknown {
  const { raw: _raw, ...rest } = m;
  return rest;
}

function askStep(m: (typeof messages.value)[number]): void {
  if (!store.dirName || !store.sessionId) {
    alert('请先选择一个 session');
    return;
  }
  const question = prompt('向 LLM 提问这一步：');
  if (!question) return;
  void studyStream(store.dirName, store.sessionId, [stepPayload(m)], question);
}

// 多选若干步一起向 LLM 提问；Shift+点击范围选中（仅当上次变化是“选中”时生效）
const selectedMsgs = ref<Set<(typeof messages.value)[number]>>(new Set());
const anchorIdx = ref<number | null>(null);
const anchorSelected = ref(false);
function clearSelection(): void {
  selectedMsgs.value = new Set();
  anchorIdx.value = null;
  anchorSelected.value = false;
}
function onSelectClick(e: MouseEvent, i: number): void {
  const list = visibleMessages.value;
  const m = list[i];
  if (e.shiftKey && anchorSelected.value && anchorIdx.value != null) {
    const from = Math.min(anchorIdx.value, i);
    const to = Math.max(anchorIdx.value, i);
    const s = new Set(selectedMsgs.value);
    for (let k = from; k <= to; k++) s.add(list[k]);
    selectedMsgs.value = s;
    return;
  }
  const s = new Set(selectedMsgs.value);
  if (s.has(m)) {
    s.delete(m);
    anchorSelected.value = false;
  } else {
    s.add(m);
    anchorSelected.value = true;
  }
  selectedMsgs.value = s;
  anchorIdx.value = i;
}

// 鼠标拖动矩形框选
const dragRect = ref<{ x: number; y: number; w: number; h: number } | null>(null);
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
function rectsIntersect(a: { x: number; y: number; w: number; h: number }, b: DOMRect): boolean {
  return a.x < b.right && a.x + a.w > b.left && a.y < b.bottom && a.y + a.h > b.top;
}
function onTimelineMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  const t = e.target as Element;
  if (t.closest('input,button,a,summary,pre,textarea,details')) return; // 不劫持交互元素
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragRect.value = { x: dragStartX, y: dragStartY, w: 0, h: 0 };
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragUp);
  e.preventDefault();
}
function onDragMove(e: MouseEvent): void {
  if (!dragging || !dragRect.value || !timelineRef.value) return;
  const x = Math.min(dragStartX, e.clientX);
  const y = Math.min(dragStartY, e.clientY);
  const w = Math.abs(e.clientX - dragStartX);
  const h = Math.abs(e.clientY - dragStartY);
  dragRect.value = { x, y, w, h };
  if (w < 4 && h < 4) return;
  const s = new Set<(typeof messages.value)[number]>();
  timelineRef.value.querySelectorAll<HTMLElement>('.msg').forEach((el) => {
    if (rectsIntersect(dragRect.value!, el.getBoundingClientRect())) {
      const idx = Number(el.dataset.idx);
      if (!Number.isNaN(idx)) s.add(visibleMessages.value[idx]);
    }
  });
  selectedMsgs.value = s;
  anchorIdx.value = null;
  anchorSelected.value = false;
}
function onDragUp(): void {
  dragging = false;
  dragRect.value = null;
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragUp);
}

function askSelected(): void {
  if (!store.dirName || !store.sessionId) {
    alert('请先选择一个 session');
    return;
  }
  const steps = Array.from(selectedMsgs.value).map(stepPayload);
  if (!steps.length) return;
  const question = prompt(`向 LLM 提问选中的 ${steps.length} 步：`);
  if (!question) return;
  void studyStream(store.dirName, store.sessionId, steps, question);
  clearSelection();
}

async function studyStream(dir: string, sid: string, steps: unknown[], question: string): Promise<void> {
  studyBlocks.value.push({ id: studyId, question, thinking: '', tools: [], bodyText: '', bodyHtml: '', requests: [] });
  const b = studyBlocks.value[studyBlocks.value.length - 1];
  studyId++;
  scrollTick.value++;
  try {
    const resp = await fetch('/api/study', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dirName: dir, sessionId: sid, steps, question }),
    });
    if (!resp.ok || !resp.body) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
    await readSSE(resp, (ev) => {
      if (ev.event === 'request') b.requests.push(JSON.stringify(ev.data?.request, null, 2));
      else if (ev.event === 'thinking') b.thinking += ev.data?.text ?? '';
      else if (ev.event === 'tool_use' && display.showToolUse)
        b.tools.push({ id: toolId++, html: `<div class="tool-call">🔧 ${esc(ev.data?.toolCall?.name)}(${esc(JSON.stringify(ev.data?.toolCall?.input ?? '')).slice(1, 120)})</div>` });
      else if (ev.event === 'tool_result' && display.showToolResult)
        b.tools.push({ id: toolId++, html: `<div class="tool-result">↳ ${esc(ev.data?.name)}: ${esc(String(ev.data?.result ?? '')).slice(0, 300)}</div>` });
      else if (ev.event === 'text') b.bodyText += ev.data?.text ?? '';
      else if (ev.event === 'error') b.bodyText += `\n[error] ${ev.data?.error ?? ''}`;
      scrollTick.value++;
    });
    if (b.bodyText) b.bodyHtml = renderMd(b.bodyText);
  } catch (e) {
    b.bodyText += `\n[error] ${String(e)}`;
  }
}

watch(
  scrollTick,
  async () => {
    await nextTick();
    if (timelineRef.value) timelineRef.value.scrollTop = timelineRef.value.scrollHeight;
  },
);

// 加载/刷新后默认滚到底
function scrollToBottom(): void {
  if (timelineRef.value) timelineRef.value.scrollTop = timelineRef.value.scrollHeight;
}
function scrollToTop(): void {
  timelineRef.value?.scrollTo({ top: 0, behavior: 'smooth' });
}
const showTopBtn = ref(false);
function onTimelineScroll(): void {
  const el = timelineRef.value;
  showTopBtn.value = !!el && el.scrollTop > 200;
}
watch(
  () => messagesQuery.data.value,
  async () => {
    if (!messagesQuery.data.value) return;
    await nextTick();
    scrollToBottom();
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
const msgSearch = ref('');
const msgQ = refDebounced(msgSearch, 200);

function messageText(m: (typeof messages.value)[number]): string {
  let s = '';
  const c = m.message?.content;
  if (typeof c === 'string') s += c;
  else if (Array.isArray(c))
    for (const b of c as Array<{ type: string; text?: string; input?: unknown; content?: unknown }>) {
      if (b.type === 'text') s += b.text ?? '';
      else if (b.type === 'tool_use') s += JSON.stringify(b.input ?? {});
      else if (b.type === 'tool_result') s += JSON.stringify(b.content ?? '');
    }
  if (m.toolUseResult) s += JSON.stringify(m.toolUseResult);
  return s.toLowerCase();
}

const baseMessages = computed(() =>
  messages.value.filter((m) => {
    if (m.type === 'user' || m.type === 'assistant') return m.message?.content != null && m.message.content !== '';
    if ((m.type === 'tool_result' || m.toolUseResult) && display.showToolResult) return true;
    return false;
  }),
);
const visibleMessages = computed(() => {
  const term = msgQ.value.trim().toLowerCase();
  if (!term) return baseMessages.value;
  return baseMessages.value.filter((m) => messageText(m).includes(term));
});
const totalMessages = computed(() => baseMessages.value.length);

const renderOpts = computed(() => ({ toolUse: display.showToolUse, toolResult: display.showToolResult, thinking: display.showThinking }));
</script>

<template>
  <div class="h-full grid grid-cols-[340px_1fr]">
    <aside class="min-h-0 overflow-auto border-r border-[#333]">
      <div class="sticky top-0 bg-[#1a1a1a] p-2 border-b border-[#333] z-[1]">
        <div class="flex items-center mb-2">
          <div class="text-[#8ab4f8] text-[15px] flex-1">Claude sessions</div>
          <NPopover trigger="click" placement="bottom-end" :width="280">
            <template #trigger>
              <button class="icon-btn" title="显示与排序设置">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
              </button>
            </template>
            <div class="ds">
              <div class="ds-row"><span class="ds-lbl">目录排序</span><NSelect v-model:value="display.dirSort" :options="dirSortOptions" size="small" class="flex-1" /></div>
              <div class="ds-row"><span class="ds-lbl">session 排序</span><NSelect v-model:value="display.sessionSort" :options="sessionSortOptions" size="small" class="flex-1" /></div>
              <div class="ds-divider">时间线显隐</div>
              <div class="ds-checks">
                <NCheckbox :checked="display.showToolUse" @click="onCheck($event, 'showToolUse', timelineGroup)">工具调用</NCheckbox>
                <NCheckbox :checked="display.showToolResult" @click="onCheck($event, 'showToolResult', timelineGroup)">工具结果</NCheckbox>
                <NCheckbox :checked="display.showThinking" @click="onCheck($event, 'showThinking', timelineGroup)">思考</NCheckbox>
                <NCheckbox :checked="display.showCheckbox" @click="onCheck($event, 'showCheckbox', timelineGroup)">复选框</NCheckbox>
              </div>
              <div class="ds-divider">侧栏显隐</div>
              <div class="ds-checks">
                <NCheckbox :checked="display.showCountBadge" @click="onCheck($event, 'showCountBadge', sidebarGroup)">计数徽章</NCheckbox>
                <NCheckbox :checked="display.showSessionSub" @click="onCheck($event, 'showSessionSub', sidebarGroup)">session 子标题</NCheckbox>
                <NCheckbox :checked="display.showDirTime" @click="onCheck($event, 'showDirTime', sidebarGroup)">目录更新时间</NCheckbox>
              </div>
            </div>
          </NPopover>
          <button v-if="expanded.size" class="icon-btn" title="全部收起" @click="expanded = new Set()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11l5-5 5 5M7 17l5-5 5 5" /></svg>
          </button>
        </div>
        <NInput v-model:value="search" placeholder="搜索目录或 session…" size="small" clearable />
      </div>
      <div class="p-2">
        <div v-if="projectsQuery.isLoading.value" class="empty"><NSpin size="small" /></div>
        <NEmpty v-else-if="!projects.length" description="没有 session" />
        <template v-else>
          <template v-for="node in tree" :key="node.p.dirName">
            <div v-if="node.show" class="item project" @click="toggle(node.p)">
              <svg class="caret" :class="{ open: node.open }" width="10" height="10" viewBox="0 0 10 10"><path d="M2 1 L8 5 L2 9 Z" fill="currentColor" /></svg>
              <span class="title" :title="node.p.cwd" v-html="hl(node.p.cwd, q)" />
              <span v-if="display.showDirTime" class="dir-time">{{ fmtTime(node.p.latestMtimeMs) }}</span>
              <span v-if="display.showCountBadge" class="count-badge">{{ node.p.sessionCount }}</span>
            </div>
            <div v-if="node.show && node.open" class="sub-tree">
              <div
                v-for="s in node.sessions"
                :key="s.sessionId"
                class="item session"
                :class="{ active: store.sessionId === s.sessionId }"
                @click.stop="selectSession(node.p.dirName, s)"
              >
                <div class="sess-head">
                  <div class="title" :title="s.preview || s.sessionId.slice(0, 8)" v-html="hl(s.preview || s.sessionId.slice(0, 8), q)" />
                  <button class="icon-btn-sm" title="复制 resume 命令" @click.stop="copyResume(node.p.cwd, s.sessionId)">📋</button>
                </div>
                <div v-if="runningMap.has(s.sessionId)" class="run-badge" :class="runningMap.get(s.sessionId)"><span class="run-dot"></span>{{ runLabel(runningMap.get(s.sessionId)) }}</div>
                <div v-if="display.showSessionSub" class="sub" :title="sessionSub(s)">{{ sessionSub(s) }}</div>
              </div>
            </div>
          </template>
        </template>
      </div>
    </aside>

    <main class="relative min-h-0 flex flex-col overflow-hidden">
      <div class="px-4 pt-3 pb-2 flex items-center gap-2">
        <div class="text-[12px] text-[#888] flex-1 truncate">{{ store.title || '选择左侧的工作目录' }}</div>
        <button v-if="selectedMsgs.size" class="ask" @click="askSelected()">提问选中({{ selectedMsgs.size }})</button>
        <button v-if="selectedMsgs.size" class="ask" @click="clearSelection()">取消选中</button>
        <button v-if="store.sessionId" class="ask" @click="refresh()">刷新</button>
      </div>
      <div v-if="store.sessionId" class="px-4 pb-2 flex items-center gap-2">
        <NInput v-model:value="msgSearch" size="small" placeholder="搜索本 session 消息内容…" clearable class="flex-1" />
        <span v-if="msgSearch.trim()" class="text-[11px] text-[#666] whitespace-nowrap">{{ visibleMessages.length }}/{{ totalMessages }}</span>
      </div>
      <div ref="timelineRef" class="flex-1 min-h-0 overflow-auto px-4 pb-3" @scroll="onTimelineScroll" @mousedown="onTimelineMouseDown">
        <div v-if="!store.sessionId" class="empty">选择一个 session 查看消息</div>
        <div v-else-if="messagesQuery.isLoading.value" class="empty"><NSpin size="small" /></div>
        <template v-else>
          <div
            v-for="(m, i) in visibleMessages"
            :key="m.uuid || i"
            :data-idx="i"
            :class="['msg', msgClass(m), { selected: selectedMsgs.has(m) }]"
          >
            <template v-if="m.type === 'user' || m.type === 'assistant'">
              <div class="role-row">
                <input v-if="display.showCheckbox" type="checkbox" class="sel-cb" :checked="selectedMsgs.has(m)" @click.stop="onSelectClick($event, i)" />
                <span class="role">{{ msgRole(m) }}</span>
                <span class="time">{{ m.timestamp ? new Date(m.timestamp).toLocaleString() : '' }}</span>
                <button class="ask" @click="askStep(m)">🔍问</button>
              </div>
              <div class="body" v-html="renderContent(m.message?.content, msgQ, renderOpts)" />
            </template>
            <template v-else-if="m.type === 'tool_result' || m.toolUseResult">
              <div class="role"><input v-if="display.showCheckbox" type="checkbox" class="sel-cb" :checked="selectedMsgs.has(m)" @click.stop="onSelectClick($event, i)" />tool<button class="ask" @click="askStep(m)">🔍问</button></div>
              <div class="body" v-html="renderTool(m.toolUseResult, m.raw, msgQ)" />
            </template>
          </div>
        </template>
        <div v-for="l in live" :key="l.id" v-html="l.html"></div>
        <div v-for="b in studyBlocks" :key="'s' + b.id" class="msg study live">
          <div class="role">🔍 深问</div>
          <div class="study-q">{{ b.question }}</div>
          <div v-if="b.thinking && display.showThinking" class="thinking">{{ b.thinking }}</div>
          <template v-for="t in b.tools" :key="t.id"><div v-html="t.html"></div></template>
          <div v-if="b.bodyHtml" class="body" v-html="b.bodyHtml" />
          <div v-else-if="b.bodyText" class="body">{{ b.bodyText }}</div>
          <details v-for="(r, i) in b.requests" :key="'sreq' + i" class="req-details">
            <summary>请求 #{{ i + 1 }}</summary>
            <pre>{{ r }}</pre>
          </details>
        </div>
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
      <button v-if="showTopBtn" class="back-top" title="回到顶部" @click="scrollToTop()">↑</button>
    </main>
    <div
      v-if="dragRect"
      class="drag-rect"
      :style="{ left: dragRect.x + 'px', top: dragRect.y + 'px', width: dragRect.w + 'px', height: dragRect.h + 'px' }"
    ></div>
  </div>
</template>