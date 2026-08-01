<script setup lang="ts">
import { ref, watch } from 'vue';
import { NInput, NButton, NSelect, NSwitch, NCard, useMessage } from 'naive-ui';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useIntervalFn } from '@vueuse/core';
import { api, saveFeishu, feishuStatus, feishuRestart, type ConfigResponse, type FeishuInput } from '../api';

const emit = defineEmits<{ close: [] }>();
const queryClient = useQueryClient();
const msg = useMessage();
const configQuery = useQuery({ queryKey: ['config'], queryFn: api.config });

const appId = ref('');
const appSecret = ref('');
const allowed = ref('');
const domain = ref<'feishu' | 'lark'>('feishu');
const enableNotify = ref(true);
const chatIdForNotify = ref('');
const hasSecret = ref(false);

watch(
  configQuery.data,
  (c: ConfigResponse | undefined) => {
    if (!c?.feishu) return;
    appId.value = c.feishu.appId;
    appSecret.value = '';
    allowed.value = c.feishu.allowedUserIds.join('\n');
    domain.value = c.feishu.domain;
    enableNotify.value = c.feishu.enableNotify;
    chatIdForNotify.value = c.feishu.chatIdForNotify ?? '';
    hasSecret.value = c.feishu.hasSecret;
  },
  { immediate: true },
);

// 在线状态轮询（3s）
const state = ref<'online' | 'offline' | 'unconfigured'>('offline');
async function refreshStatus(): Promise<void> {
  try {
    state.value = (await feishuStatus()).state;
  } catch {
    /* 忽略 */
  }
}
useIntervalFn(refreshStatus, 3000, { immediateCallback: true });

const domainOptions = [
  { label: '飞书 (feishu.cn · 国内)', value: 'feishu' },
  { label: 'Lark (larksuite.com · 国际)', value: 'lark' },
];

async function save(): Promise<void> {
  const input: FeishuInput = {
    appId: appId.value.trim(),
    appSecret: appSecret.value.trim(), // 留空保留旧值（后端处理）
    allowedUserIds: allowed.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    domain: domain.value,
    enableNotify: enableNotify.value,
    chatIdForNotify: chatIdForNotify.value.trim() || undefined,
  };
  try {
    await saveFeishu(input);
    await feishuRestart(); // 配置变更后重启 bot
    await queryClient.invalidateQueries({ queryKey: ['config'] });
    await refreshStatus();
    msg.success('已保存并重启机器人');
    emit('close');
  } catch (e) {
    msg.error(String(e));
  }
}
</script>

<template>
  <NCard title="飞书机器人" class="settings-card" :bordered="false">
    <div class="settings-body">
      <div class="status-row">
        <span class="state-dot" :class="state" />
        <span class="state-text">{{ state === 'online' ? '在线' : state === 'unconfigured' ? '未配置' : '离线' }}</span>
        <span v-if="hasSecret && !appSecret" class="hint">（appSecret 已设，留空保留）</span>
      </div>
      <div class="row"><span class="lbl">App ID</span><NInput v-model:value="appId" size="small" placeholder="cli_xxx" /></div>
      <div class="row"><span class="lbl">App Secret</span><NInput v-model:value="appSecret" type="password" show-password-on="click" size="small" :placeholder="hasSecret ? '留空保留已设值' : '飞书应用 secret'" /></div>
      <div class="row"><span class="lbl">白名单 open_id</span><NInput v-model:value="allowed" type="textarea" :autosize="{ minRows: 2 }" size="small" placeholder="每行一个 ou_xxx（只有这些人能触发）" /></div>
      <div class="row"><span class="lbl">域名</span><NSelect v-model:value="domain" :options="domainOptions" size="small" class="flex-1" /></div>
      <div class="row"><span class="lbl">完成通知</span><NSwitch v-model:value="enableNotify" size="small" /></div>
      <div class="row"><span class="lbl">通知群 chat_id</span><NInput v-model:value="chatIdForNotify" size="small" placeholder="可选；留空发本人单聊" /></div>
      <p class="tip">保存后机器人随本地服务常驻；触发需在飞书开放平台配「机器人 + 长连接事件 im.message.receive_v1 + im:message 权限」，并把你的 open_id 填入白名单。</p>
    </div>

    <template #footer>
      <div class="flex gap-2 justify-end">
        <NButton size="small" @click="emit('close')">取消</NButton>
        <NButton size="small" type="primary" @click="save">保存并重启</NButton>
      </div>
    </template>
  </NCard>
</template>

<style scoped>
.settings-card { width: 560px; max-width: 92vw; }
.settings-body { display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow: auto; }
.row { display: flex; align-items: center; gap: 8px; }
.lbl { width: 104px; font-size: 12px; color: #888; flex-shrink: 0; }
.status-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #aaa; }
.state-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
.state-dot.online { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
.state-dot.unconfigured { background: #f59e0b; }
.hint { color: #666; }
.tip { font-size: 11px; color: #777; line-height: 1.5; margin: 4px 0 0; }
</style>
