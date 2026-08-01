<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { refDebounced } from '@vueuse/core';
import { NInput, NSpin, NCheckbox, NPopover, NSelect, useMessage } from 'naive-ui';
import { api, type SessionMessage } from '../api';
import { useDisplayStore } from '../stores/display';
import { renderContent, renderTool, renderMd, esc } from '../lib/render';
import { readSSE, type SSEEvent } from '../lib/sse';
import { setTitle } from '../lib/head';
import { broadcastInvalidate } from '../lib/broadcast';
import { openWindow } from '../lib/openWindow';

const route = useRoute();
const router = useRouter();
const dir = computed(() => String(route.params.dir));
const sid = computed(() => String(route.params.sid));
const msg = useMessage();
const display = useDisplayStore();
// 时间线显隐设置（与主页一致的 popover）
type BoolKey = 'showToolUse' | 'showToolResult' | 'showThinking' | 'showCheckbox';
const timelineGroup: BoolKey[] = ['showToolUse', 'showToolResult', 'showThinking', 'showCheckbox'];
function onCheck(e: MouseEvent, key: BoolKey): void {
  const d = display as unknown as Record<string, boolean>;
  if (e.ctrlKey || e.metaKey) {
    for (const k of timelineGroup) d[k] = k === key;
  } else {
    d[key] = !d[key];
  }
}

const messagesQuery = useQuery({
  queryKey: computed(() => ['messages', dir.value, sid.value]),
  queryFn: () => api.messages(dir.value, sid.value),
});
const messages = computed(() => messagesQuery.data.value ?? []);

// 标题：首条人类消息预览
watch(
  () => messages.value,
  (ms) => {
    const first = ms.find((m) => m.type === 'user');
    let t = '';
    const c = first?.message?.content;
    if (typeof c === 'string') t = c;
    else if (Array.isArray(c)) {
      const block = (c as Array<{ type?: string; text?: string }>).find((b) => b.type === 'text');
      t = block?.text ?? '';
    }
    setTitle((t || sid.value.slice(0, 8)).slice(0, 40) + ' · Session');
  },
);

// 运行状态
const runningQuery = useQuery({ queryKey: ['running'], queryFn: api.running, refetchInterval: 3000 });
const runningMap = computed(() => new Map((runningQuery.data.value ?? []).map((r) => [r.sessionId, r.status])));

function copyResume(): void {
  if (runningMap.value.has(sid.value) && !confirm('该 session 正在另一个终端运行，在另一终端 resume 可能导致分叉。仍要复制命令吗？')) return;
  // cwd 未知时退化为占位；用户在 resume 命令里自行替换
  navigator.clipboard.writeText(`claude --resume ${sid.value}`).then(() => msg.success('已复制 resume 命令')).catch(() => msg.error('复制失败'));
}

function popCurrent(): void {
  openWindow(`/projects/${encodeURIComponent(dir.value)}/sessions/${encodeURIComponent(sid.value)}`);
}
function popTerminal(): void {
  openWindow(`/terminal/${encodeURIComponent(dir.value)}/${encodeURIComponent(sid.value)}`);
}

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
  convId: string | null;
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
  if (runningMap.value.has(sid.value) && !confirm('该 session 正在另一个终端运行，继续可能导致分叉。仍要继续吗？')) return;
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  if (!confirm('将运行 claude --resume（--dangerously-skip-permissions），会真实修改该 session 及其工作目录。确认？')) return;
  promptInput.value = '';
  running.value = true;
  abortCtrl.value = new AbortController();
  try {
    const resp = await fetch(`/api/projects/${dir.value}/sessions/${sid.value}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: abortCtrl.value.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
    await readSSE(resp, appendStreamEvent);
    broadcastInvalidate([['messages', dir.value, sid.value]]);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') appendStreamEvent({ event: 'error', data: { error: String(e) } });
  } finally {
    running.value = false;
    abortCtrl.value = null;
  }
}

// —— 深问 ——
function stepPayload(m: SessionMessage): unknown {
  const { raw: _raw, ...rest } = m;
  return rest;
}

function askStep(m: SessionMessage): void {
  const question = prompt('向 LLM 提问这一步：');
  if (!question) return;
  void studyStream([stepPayload(m)], question);
}

const selectedMsgs = ref<Set<SessionMessage>>(new Set());
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
  if (t.closest('input,button,a,summary,pre,textarea,details')) return;
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
  const s = new Set<SessionMessage>();
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
  const steps = Array.from(selectedMsgs.value).map(stepPayload);
  if (!steps.length) return;
  const question = prompt(`向 LLM 提问选中的 ${steps.length} 步：`);
  if (!question) return;
  void studyStream(steps, question);
  clearSelection();
}

async function studyStream(steps: unknown[], question: string): Promise<void> {
  studyBlocks.value.push({ id: studyId, question, thinking: '', tools: [], bodyText: '', bodyHtml: '', requests: [], convId: null });
  const b = studyBlocks.value[studyBlocks.value.length - 1];
  studyId++;
  scrollTick.value++;
  try {
    const resp = await fetch('/api/study', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dirName: dir.value, sessionId: sid.value, steps, question }),
    });
    if (!resp.ok || !resp.body) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
    await readSSE(resp, (ev) => {
      if (ev.event === 'conversation') b.convId = ev.data?.id ?? null;
      else if (ev.event === 'request') b.requests.push(JSON.stringify(ev.data?.request, null, 2));
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
    broadcastInvalidate([['conversations']]);
    // 深问落库 → 同窗口钻取到对话页
    if (b.convId) {
      await nextTick();
      void router.push({ name: 'conversation', params: { id: b.convId } });
    }
  } catch (e) {
    b.bodyText += `\n[error] ${String(e)}`;
  }
}

watch(scrollTick, async () => {
  await nextTick();
  if (timelineRef.value) timelineRef.value.scrollTop = timelineRef.value.scrollHeight;
});

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
    if (timelineRef.value) timelineRef.value.scrollTop = timelineRef.value.scrollHeight;
  },
);

function msgRole(m: SessionMessage): string {
  return (m.message?.role as string) || m.type;
}
function msgClass(m: SessionMessage): string {
  if (m.type === 'tool_result' || m.toolUseResult) return 'tool';
  return (m.message?.role as string) || m.type;
}

const msgSearch = ref('');
const msgQ = refDebounced(msgSearch, 200);

function messageText(m: SessionMessage): string {
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

function refresh(): void {
  live.value = [];
  studyBlocks.value = [];
  clearSelection();
  void messagesQuery.refetch();
}
</script>

<template>
  <div class="relative h-full flex flex-col overflow-hidden">
    <div class="px-4 pt-3 pb-2 flex items-center gap-2">
      <div class="text-[12px] text-[#888] flex-1 truncate">{{ sid.slice(0, 8) }}</div>
      <NPopover trigger="click" placement="bottom-end" :width="240">
        <template #trigger>
          <button class="ask" title="时间线显隐设置">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
          </button>
        </template>
        <div class="ds">
          <div class="ds-divider">时间线显隐</div>
          <div class="ds-checks">
            <NCheckbox :checked="display.showToolUse" @click="onCheck($event, 'showToolUse')">工具调用</NCheckbox>
            <NCheckbox :checked="display.showToolResult" @click="onCheck($event, 'showToolResult')">工具结果</NCheckbox>
            <NCheckbox :checked="display.showThinking" @click="onCheck($event, 'showThinking')">思考</NCheckbox>
            <NCheckbox :checked="display.showCheckbox" @click="onCheck($event, 'showCheckbox')">复选框</NCheckbox>
          </div>
        </div>
      </NPopover>
      <button class="ask" title="复制 resume 命令" @click="copyResume">📋</button>
      <button class="ask" title="在终端中打开（交互式 resume）" @click="popTerminal">🖥</button>
      <button class="ask popout" title="新窗口打开该 session" @click="popCurrent">↗</button>
      <button v-if="selectedMsgs.size" class="ask" @click="askSelected()">提问选中({{ selectedMsgs.size }})</button>
      <button v-if="selectedMsgs.size" class="ask" @click="clearSelection()">取消选中</button>
      <button class="ask" @click="refresh()">刷新</button>
    </div>
    <div class="px-4 pb-2 flex items-center gap-2">
      <NInput v-model:value="msgSearch" size="small" placeholder="搜索本 session 消息内容…" clearable class="flex-1" />
      <span v-if="msgSearch.trim()" class="text-[11px] text-[#666] whitespace-nowrap">{{ visibleMessages.length }}/{{ totalMessages }}</span>
    </div>
    <div ref="timelineRef" class="flex-1 min-h-0 overflow-auto px-4 pb-3" @scroll="onTimelineScroll" @mousedown="onTimelineMouseDown">
      <div v-if="messagesQuery.isLoading.value" class="empty"><NSpin size="small" /></div>
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
    <div class="composer">
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
    <div
      v-if="dragRect"
      class="drag-rect"
      :style="{ left: dragRect.x + 'px', top: dragRect.y + 'px', width: dragRect.w + 'px', height: dragRect.h + 'px' }"
    ></div>
  </div>
</template>