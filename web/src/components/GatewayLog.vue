<script setup lang="ts">
import { ref, computed } from 'vue';
import { NInput, NButton, NTag, useMessage } from 'naive-ui';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api, deleteGatewayLog, saveGatewayKey, type GatewayLog, type ConfigResponse } from '../api';
import { renderContent } from '../lib/render';

const msg = useMessage();
const queryClient = useQueryClient();
const q = ref('');
const selected = ref<GatewayLog | null>(null);
const configQuery = useQuery({ queryKey: ['config'], queryFn: api.config });
const logsQuery = useQuery({ queryKey: ['gateway-logs'], queryFn: () => api.gatewayLogs(), refetchInterval: 5000 });
const logs = computed(() => logsQuery.data.value ?? []);
const filtered = computed(() => {
  const s = q.value.trim().toLowerCase();
  if (!s) return logs.value;
  return logs.value.filter((l) => l.model.toLowerCase().includes(s) || l.providerId.toLowerCase().includes(s) || l.status.includes(s));
});

const gwKey = ref('');
const hasKey = computed(() => (configQuery.data.value as ConfigResponse | undefined)?.hasGatewayKey ?? false);
async function saveKey(): Promise<void> {
  try {
    await saveGatewayKey(gwKey.value);
    gwKey.value = '';
    await queryClient.invalidateQueries({ queryKey: ['config'] });
    msg.success('已保存');
  } catch (e) {
    msg.error(String(e));
  }
}
async function del(id: string): Promise<void> {
  try {
    await deleteGatewayLog(id);
    await queryClient.invalidateQueries({ queryKey: ['gateway-logs'] });
    if (selected.value?.id === id) selected.value = null;
  } catch (e) {
    msg.error(String(e));
  }
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="toolbar">
      <NInput v-model:value="q" size="small" placeholder="过滤 model / provider / status" class="flex-1" />
      <NInput v-model:value="gwKey" size="small" :placeholder="hasKey ? '网关 key 已设（留空不改）' : '设置网关 key（留空=不校验）'" style="width: 260px" />
      <NButton size="small" @click="saveKey">保存 key</NButton>
    </div>
    <div class="flex-1 min-h-0 overflow-auto">
      <div v-for="l in filtered" :key="l.id" class="row" :class="{ sel: selected?.id === l.id }" @click="selected = selected?.id === l.id ? null : l">
        <span class="t">{{ fmtTime(l.createdAt) }}</span>
        <span class="m">{{ l.model }}</span>
        <span class="p">{{ l.providerId }}</span>
        <span class="d">{{ (l.elapsedMs / 1000).toFixed(1) }}s</span>
        <span class="u">{{ l.response?.usage ? `${l.response.usage.input_tokens ?? '?'}/${l.response.usage.output_tokens ?? '?'}` : '-' }}</span>
        <NTag :type="l.status === 'ok' ? 'success' : 'error'" size="small">{{ l.status }}</NTag>
        <button class="ask" @click.stop="del(l.id)">🗑</button>
      </div>
      <div v-if="!filtered.length" class="empty">暂无中转记录。把工具的 base URL 指向本服务（如 http://localhost:3000），发个请求试试。</div>
    </div>
    <div v-if="selected" class="detail">
      <div class="detail-head">
        <b>详情</b>
        <span>{{ selected.model }} · {{ selected.providerId }} · {{ (selected.elapsedMs / 1000).toFixed(1) }}s</span>
        <span v-if="selected.error" class="err">{{ selected.error }}</span>
        <span class="flex-1"></span>
        <NButton size="tiny" @click="selected = null">关闭</NButton>
      </div>
      <div class="detail-body">
        <div class="sec">
          <div class="sec-t">请求</div>
          <div class="meta">model: {{ selected.request.model }} · max_tokens: {{ selected.request.max_tokens }} · stream: {{ selected.request.stream }}</div>
          <div v-if="selected.request.system" class="sys">{{ selected.request.system }}</div>
          <div v-for="(m, i) in (selected.request.messages as Array<{ role: string; content: unknown }>)" :key="i" class="msg-block">
            <span class="role">{{ m.role }}</span>
            <div v-html="renderContent(m.content)" />
          </div>
        </div>
        <div class="sec">
          <div class="sec-t">响应</div>
          <div v-if="selected.response?.content" v-html="renderContent(selected.response.content)" />
          <div class="meta">stop_reason: {{ selected.response?.stop_reason }} · {{ selected.response?.usage ? `in ${selected.response.usage.input_tokens} / out ${selected.response.usage.output_tokens}` : '' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolbar { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid #2a2a2a; }
.row { display: flex; gap: 12px; align-items: center; padding: 6px 12px; border-bottom: 1px solid #222; cursor: pointer; font-size: 12px; }
.row:hover { background: #1f1f1f; }
.row.sel { background: #2a2138; }
.row .t { width: 80px; color: #888; }
.row .m { width: 170px; color: #ddd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .p { width: 80px; color: #888; }
.row .d { width: 50px; color: #888; }
.row .u { width: 60px; color: #888; }
.empty { padding: 32px; text-align: center; color: #666; }
.detail { border-top: 1px solid #2a2a2a; max-height: 48vh; overflow: auto; background: #161616; }
.detail-head { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #222; font-size: 12px; }
.err { color: #f87171; }
.detail-body { padding: 8px 12px; }
.sec { margin-bottom: 12px; }
.sec-t { font-size: 11px; color: #8ab4f8; margin-bottom: 4px; text-transform: uppercase; }
.meta { font-size: 11px; color: #777; margin: 4px 0; }
.sys { font-size: 12px; color: #aaa; background: #1a1a1a; padding: 6px; border-radius: 4px; margin: 4px 0; white-space: pre-wrap; }
.msg-block { padding: 4px 0 4px 8px; border-left: 2px solid #333; margin: 4px 0; }
.role { font-size: 11px; color: #8ab4f8; }
</style>
