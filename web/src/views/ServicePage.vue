<script setup lang="ts">
// 服务管理页：查看后端 sidecar 状态、启停/重启、查看实时+历史日志。
// 全部走 desktop.service bridge 与 shell 通信（不经 /api），后端挂掉仍可操作。
import { onUnmounted, ref, nextTick } from 'vue';
import { useIntervalFn } from '@vueuse/core';
import { isDesktop, desktop, type ServiceStatus, type LogEntry } from '../lib/desktop';

const status = ref<ServiceStatus | null>(null);
const logs = ref<LogEntry[]>([]);
const busy = ref<'start' | 'stop' | 'restart' | null>(null);
const logBox = ref<HTMLDivElement | null>(null);
let unsubLog: (() => void) | null = null;

async function refresh(): Promise<void> {
  if (!desktop) return;
  try {
    status.value = await desktop.service.status();
  } catch {
    status.value = null;
  }
}

function fmtUptime(ms: number): string {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h${m}m${sec}s`;
  if (m) return `${m}m${sec}s`;
  return `${sec}s`;
}

function fmtTime(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString();
}

async function pushLog(e: LogEntry): Promise<void> {
  logs.value.push(e);
  if (logs.value.length > 5000) logs.value.splice(0, logs.value.length - 5000);
  await nextTick();
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
}

async function doStart(): Promise<void> {
  if (!desktop || busy.value) return;
  busy.value = 'start';
  try { await desktop.service.start(); await refresh(); } finally { busy.value = null; }
}
async function doStop(): Promise<void> {
  if (!desktop || busy.value) return;
  busy.value = 'stop';
  try { await desktop.service.stop(); await refresh(); } finally { busy.value = null; }
}
async function doRestart(): Promise<void> {
  if (!desktop || busy.value) return;
  busy.value = 'restart';
  try { await desktop.service.restart(); await refresh(); } finally { busy.value = null; }
}

// 状态 2s 轮询；日志 push。
const { pause } = useIntervalFn(refresh, 2000, { immediate: true });

onUnmounted(() => {
  pause();
  unsubLog?.();
});

if (desktop) {
  desktop.service.getLogs().then((h) => { logs.value = h.slice(-5000); }).then(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
  unsubLog = desktop.service.onLog(pushLog);
}
</script>

<template>
  <div class="service-page">
    <div v-if="!isDesktop" class="empty">服务管理仅在桌面端可用（web 模式下后端由你手动启动）。</div>
    <template v-else>
      <div class="status-card">
        <div class="status-row">
          <span class="badge" :class="status?.running ? 'on' : 'off'">{{ status?.running ? '运行中' : '已停止' }}</span>
          <span class="kv">端口 <b>{{ status?.port ?? '-' }}</b></span>
          <span class="kv">PID <b>{{ status?.pid ?? '-' }}</b></span>
          <span class="kv">启动 <b>{{ fmtTime(status?.startedAt ?? null) }}</b></span>
          <span class="kv">运行时长 <b>{{ fmtUptime(status?.uptimeMs ?? 0) }}</b></span>
        </div>
        <div class="actions">
          <button class="act" :disabled="!!busy || status?.running" @click="doStart">启动</button>
          <button class="act" :disabled="!!busy || !status?.running" @click="doStop">停止</button>
          <button class="act" :disabled="!!busy" @click="doRestart">重启</button>
        </div>
      </div>
      <div class="log-panel">
        <div class="log-title">日志</div>
        <div ref="logBox" class="log-box">
          <div v-for="(l, i) in logs" :key="i" class="log-line" :class="l.level">
            <span class="log-ts">{{ fmtTime(l.ts) }}</span>
            <span class="log-msg">{{ l.msg }}</span>
          </div>
          <div v-if="!logs.length" class="log-empty">（暂无日志）</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.service-page { height: 100%; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; overflow: hidden; }
.empty { color: #666; font-size: 13px; }
.status-card { background: #1d1d1d; border: 1px solid #333; border-radius: 8px; padding: 12px 14px; }
.status-row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.badge { font-size: 12px; padding: 2px 10px; border-radius: 10px; border: 1px solid; }
.badge.on { color: #4ade80; border-color: #4ade80; background: rgba(74,222,128,.08); }
.badge.off { color: #888; border-color: #444; background: #2a2a2a; }
.kv { font-size: 12px; color: #888; }
.kv b { color: #ccc; font-weight: 600; }
.actions { margin-top: 10px; display: flex; gap: 8px; }
.act { font: inherit; font-size: 12px; padding: 4px 14px; border-radius: 6px; border: 1px solid #444; background: #2a2a2a; color: #ccc; cursor: pointer; }
.act:hover:not(:disabled) { border-color: #8ab4f8; color: #8ab4f8; }
.act:disabled { opacity: .4; cursor: not-allowed; }
.log-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; background: #161616; border: 1px solid #333; border-radius: 8px; overflow: hidden; }
.log-title { padding: 6px 12px; font-size: 12px; color: #888; border-bottom: 1px solid #333; }
.log-box { flex: 1; overflow: auto; padding: 8px 12px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.5; }
.log-line { white-space: pre-wrap; word-break: break-all; }
.log-ts { color: #555; margin-right: 8px; }
.log-msg { color: #bbb; }
.log-line.error .log-msg { color: #f87171; }
.log-line.info .log-msg { color: #8ab4f8; }
.log-empty { color: #555; }
</style>