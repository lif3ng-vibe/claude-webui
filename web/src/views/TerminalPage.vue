<script setup lang="ts">
// 网页交互终端：xterm.js 经 WebSocket 连后端 node-pty 跑 `claude --resume <sid>` 的交互式 TUI。
// WS 协议见 src/terminal/TerminalManager.ts：二进制=终端输入/输出，文本=控制/exit/error。
import { onMounted, onUnmounted, ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useResizeObserver } from '@vueuse/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { setTitle } from '../lib/head';
import '@xterm/xterm/css/xterm.css';

const route = useRoute();
const dir = computed(() => String(route.params.dir));
const sid = computed(() => String(route.params.sid));

const termEl = ref<HTMLDivElement | null>(null);
const statusMsg = ref('');
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
const enc = new TextEncoder();

function sendResize(): void {
  if (ws && ws.readyState === WebSocket.OPEN && fit) {
    fit.fit();
    ws.send(JSON.stringify({ type: 'resize', cols: term?.cols ?? 80, rows: term?.rows ?? 24 }));
  }
}

onMounted(() => {
  setTitle('终端 · ' + sid.value.slice(0, 8));
  if (!termEl.value) return;
  term = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13, theme: { background: '#1a1a1a', foreground: '#ddd', cursor: '#8ab4f8' } });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termEl.value);
  fit.fit();

  // Ctrl+C：有选中复制；Ctrl+V / Cmd+V：粘贴剪贴板到终端。
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && (ev.key === 'c' || ev.key === 'C')) {
      const sel = term?.getSelection() ?? '';
      if (sel.length > 0) {
        navigator.clipboard?.writeText(sel).catch(() => {});
        return false;
      }
      return true;
    }
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
      navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text && ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(text) as unknown as ArrayBuffer);
        })
        .catch(() => {});
      return false;
    }
    return true;
  });

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/api/terminal/${encodeURIComponent(dir.value)}/${encodeURIComponent(sid.value)}`;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  // 后端 → 终端：二进制写屏，文本=JSON（exit/error）。
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      term?.write(new Uint8Array(e.data));
    } else {
      try {
        const ctrl = JSON.parse(e.data as string) as { type: string; msg?: string; code?: number };
        if (ctrl.type === 'error') statusMsg.value = ctrl.msg ?? '错误';
        else if (ctrl.type === 'exit') statusMsg.value = `claude 已退出（code=${ctrl.code}）`;
      } catch { /* 忽略 */ }
    }
  };

  ws.onopen = () => sendResize();
  ws.onclose = (e) => {
    if (!statusMsg.value) {
      if (e.code === 4001) statusMsg.value = '该 session 正在被另一处续接（单发或终端），请先结束';
      else if (e.code === 4000) statusMsg.value = '无法确定该 session 的工作目录';
      else if (e.code === 4002) statusMsg.value = '启动 claude 失败';
      else if (e.code !== 1000) statusMsg.value = `连接已断开（${e.code}）`;
    }
  };
  ws.onerror = () => { statusMsg.value = statusMsg.value || '连接错误'; };

  // 终端 → 后端：输入发二进制（UTF-8 字节）；resize 发 JSON 文本。
  term.onData((d) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d) as unknown as ArrayBuffer);
  });
});

// 容器尺寸变化 → fit + 通知后端 resize。
useResizeObserver(termEl, () => sendResize());

onUnmounted(() => {
  ws?.close();
  term?.dispose();
  term = null;
  ws = null;
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div ref="termEl" class="terminal-box flex-1 min-h-0" />
    <div v-if="statusMsg" class="terminal-status">{{ statusMsg }}</div>
  </div>
</template>

<style scoped>
.terminal-box {
  background: #1a1a1a;
  padding: 6px 8px;
  overflow: hidden;
}
.terminal-box :deep(.xterm) {
  height: 100%;
}
.terminal-status {
  flex-shrink: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: #f87171;
  background: #1d1d1d;
  border-top: 1px solid #333;
}
</style>