<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { NInput, NButton, NSelect, NSwitch, NCard, useMessage } from 'naive-ui';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useIntervalFn } from '@vueuse/core';
import { api, saveFeishuApps, feishuStatus, type ConfigResponse, type FeishuAppInput, type PublicFeishuApp } from '../api';

const emit = defineEmits<{ close: [] }>();
const queryClient = useQueryClient();
const msg = useMessage();
const configQuery = useQuery({ queryKey: ['config'], queryFn: api.config });
const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects });

interface EditApp {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  allowed: string;
  domain: 'feishu' | 'lark';
  enableNotify: boolean;
  chatIdForNotify: string;
  boundDir: string;
  boundSid: string;
  hasSecret: boolean;
  providerId: string;
}

function toEdit(p: PublicFeishuApp): EditApp {
  return {
    id: p.id,
    name: p.name ?? '',
    appId: p.appId,
    appSecret: '',
    allowed: p.allowedUserIds.join('\n'),
    domain: p.domain,
    enableNotify: p.enableNotify,
    chatIdForNotify: p.chatIdForNotify ?? '',
    boundDir: p.boundSession?.dirName ?? '',
    boundSid: p.boundSession?.sessionId ?? '',
    hasSecret: p.hasSecret,
    providerId: p.providerId ?? '',
  };
}

const apps = ref<EditApp[]>([]);
watch(
  configQuery.data,
  (c: ConfigResponse | undefined) => {
    if (!c) return;
    apps.value = (c.feishu ?? []).map(toEdit);
    for (const a of apps.value) if (a.boundDir) void ensureSessions(a.boundDir);
  },
  { immediate: true },
);

function addApp(): void {
  apps.value.push({
    id: 'app_' + Date.now(),
    name: '', appId: '', appSecret: '', allowed: '', domain: 'feishu',
    enableNotify: true, chatIdForNotify: '', boundDir: '', boundSid: '', hasSecret: false, providerId: '',
  });
}
function removeApp(id: string): void {
  apps.value = apps.value.filter((a) => a.id !== id);
}

// 绑定 session 两级选择：目录 → session。
const dirOptions = computed(() => (projectsQuery.data.value ?? []).map((p) => ({ label: p.cwd || p.dirName, value: p.dirName })));
// provider 选择（注入 claude env；空=env/活动兜底）。
const providerOptions = computed(() => [
  { label: '默认（env/活动）', value: '' },
  ...(configQuery.data.value?.providers ?? []).map((p) => ({ label: `${p.name} · ${p.model}`, value: p.id })),
]);
const sessionsCache = ref<Record<string, Array<{ sessionId: string; preview: string }>>>({});
async function ensureSessions(dir: string): Promise<void> {
  if (!dir || sessionsCache.value[dir]) return;
  try {
    const ss = await api.sessions(dir);
    sessionsCache.value = { ...sessionsCache.value, [dir]: ss.map((s) => ({ sessionId: s.sessionId, preview: s.preview })) };
  } catch {
    /* 忽略 */
  }
}
function sessionOptions(dir: string): Array<{ label: string; value: string }> {
  return (sessionsCache.value[dir] ?? []).map((s) => ({
    label: `${s.sessionId.slice(0, 8)} · ${s.preview.slice(0, 30)}`,
    value: s.sessionId,
  }));
}
async function onDirChange(app: EditApp, dir: string): Promise<void> {
  app.boundDir = dir;
  app.boundSid = '';
  await ensureSessions(dir);
}

// per-app 在线状态轮询（3s）。
const statuses = ref<Record<string, { state: string; botName?: string }>>({});
async function refreshStatus(): Promise<void> {
  try {
    const r = await feishuStatus();
    statuses.value = Object.fromEntries(r.apps.map((a) => [a.id, { state: a.state, botName: a.botName }]));
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
  const input: FeishuAppInput[] = apps.value.map((a) => ({
    id: a.id,
    name: a.name || undefined,
    appId: a.appId,
    appSecret: a.appSecret,
    allowedUserIds: a.allowed.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    domain: a.domain,
    enableNotify: a.enableNotify,
    chatIdForNotify: a.chatIdForNotify || undefined,
    boundSession: a.boundDir && a.boundSid ? { dirName: a.boundDir, sessionId: a.boundSid } : null,
    providerId: a.providerId || undefined,
  }));
  try {
    await saveFeishuApps(input);
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
      <p class="tip">每个机器人绑定一个 Claude session（发消息即续接它）。机器人名/头像在飞书平台各自应用里设，代码改不了。</p>

      <div v-for="a in apps" :key="a.id" class="app-block">
        <div class="app-head">
          <span class="state-dot" :class="statuses[a.id]?.state ?? 'offline'" />
          <span class="app-name">{{ statuses[a.id]?.botName || a.name || a.appId || '新机器人' }}</span>
          <span class="state-text">{{ statuses[a.id]?.state === 'online' ? '在线' : '离线' }}</span>
          <button class="ask" @click="removeApp(a.id)">删除</button>
        </div>
        <div class="row"><span class="lbl">名称</span><NInput v-model:value="a.name" size="small" placeholder="备注，如「项目A」" /></div>
        <div class="row"><span class="lbl">App ID</span><NInput v-model:value="a.appId" size="small" placeholder="cli_xxx" /></div>
        <div class="row"><span class="lbl">App Secret</span><NInput v-model:value="a.appSecret" type="password" show-password-on="click" size="small" :placeholder="a.hasSecret ? '留空保留已设值' : 'secret'" /></div>
        <div class="row"><span class="lbl">白名单</span><NInput v-model:value="a.allowed" type="textarea" :autosize="{ minRows: 1 }" size="small" placeholder="留空则首个发消息者自动成为创建人" /></div>
        <div class="row"><span class="lbl">域名</span><NSelect v-model:value="a.domain" :options="domainOptions" size="small" class="flex-1" /></div>
        <div class="row"><span class="lbl">绑定目录</span><NSelect :value="a.boundDir" :options="dirOptions" size="small" class="flex-1" placeholder="选择工作目录" @update:value="(v: string) => onDirChange(a, v)" /></div>
        <div class="row"><span class="lbl">绑定 session</span><NSelect v-model:value="a.boundSid" :options="sessionOptions(a.boundDir)" size="small" class="flex-1" :placeholder="a.boundDir ? '选择 session' : '先选目录'" :disabled="!a.boundDir" /></div>
        <div class="row"><span class="lbl">完成通知</span><NSwitch v-model:value="a.enableNotify" size="small" /></div>
        <div class="row"><span class="lbl">通知群</span><NInput v-model:value="a.chatIdForNotify" size="small" placeholder="可选；留空发本人单聊" /></div>
        <div class="row"><span class="lbl">Provider</span><NSelect v-model:value="a.providerId" :options="providerOptions" size="small" class="flex-1" placeholder="默认（env/活动）" /></div>
      </div>

      <NButton size="small" dashed @click="addApp">+ 添加机器人</NButton>
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
.settings-card { width: 600px; max-width: 94vw; }
.settings-body { display: flex; flex-direction: column; gap: 8px; max-height: 64vh; overflow: auto; }
.tip { font-size: 11px; color: #888; line-height: 1.5; margin: 0 0 4px; }
.app-block { border: 1px solid #333; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.app-head { display: flex; align-items: center; gap: 6px; }
.app-name { font-weight: 500; color: #ddd; flex: 1; }
.row { display: flex; align-items: center; gap: 8px; }
.lbl { width: 84px; font-size: 12px; color: #888; flex-shrink: 0; }
.state-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
.state-dot.online { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
.state-text { font-size: 11px; color: #888; }
</style>
