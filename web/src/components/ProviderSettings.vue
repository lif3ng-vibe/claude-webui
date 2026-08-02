<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { NInput, NButton, NSelect, NCard, useMessage } from 'naive-ui';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api, saveConfig, type ConfigResponse, type ProviderInput } from '../api';

const emit = defineEmits<{ close: [] }>();
const queryClient = useQueryClient();
const msg = useMessage();
const configQuery = useQuery({ queryKey: ['config'], queryFn: api.config });

interface EditProvider extends ProviderInput {
  isEnv?: boolean;
}

const providers = ref<EditProvider[]>([]);
const activeId = ref('');

watch(
  configQuery.data,
  (c: ConfigResponse | undefined) => {
    if (!c) return;
    providers.value = c.providers.map((p) => ({ id: p.id, name: p.name, baseURL: p.baseURL, model: p.model, authToken: '', apiKey: '', isEnv: p.isEnv, type: p.type ?? 'anthropic' }));
    activeId.value = c.activeProviderId;
  },
  { immediate: true },
);

const activeOptions = computed(() => providers.value.map((p) => ({ label: p.name || p.id, value: p.id })));
const typeOptions = [
  { label: 'Anthropic（/v1/messages）', value: 'anthropic' },
  { label: 'OpenAI（/v1/chat/completions）', value: 'openai' },
];

function addProvider(): void {
  const id = 'p' + Date.now();
  providers.value.push({ id, name: '新 provider', baseURL: '', model: '', authToken: '', apiKey: '', type: 'anthropic' });
  activeId.value = id;
}

function removeProvider(id: string): void {
  providers.value = providers.value.filter((p) => p.id !== id);
  if (activeId.value === id) activeId.value = providers.value[0]?.id ?? '';
}

async function save(): Promise<void> {
  const editable: ProviderInput[] = providers.value
    .filter((p) => !p.isEnv)
    .map((p) => ({ id: p.id, name: p.name, baseURL: p.baseURL, model: p.model, authToken: p.authToken, apiKey: p.apiKey, type: p.type }));
  try {
    await saveConfig(editable, activeId.value);
    await queryClient.invalidateQueries({ queryKey: ['config'] });
    msg.success('已保存');
    emit('close');
  } catch (e) {
    msg.error(String(e));
  }
}
</script>

<template>
  <NCard title="Provider 配置" class="settings-card" :bordered="false">
    <div class="settings-body">
      <div class="row">
        <span class="lbl">活动 provider</span>
        <NSelect v-model:value="activeId" :options="activeOptions" size="small" class="flex-1" />
      </div>

      <div v-for="p in providers" :key="p.id" class="provider-block">
        <div class="provider-head">
          <span class="provider-name">{{ p.name || p.id }}{{ p.isEnv ? ' · 内置(只读)' : '' }}</span>
          <button v-if="!p.isEnv" class="ask" @click="removeProvider(p.id)">删除</button>
        </div>
        <div class="row"><span class="lbl">名称</span><NInput v-model:value="p.name" :disabled="p.isEnv" size="small" /></div>
        <div class="row"><span class="lbl">类型</span><NSelect v-model:value="p.type" :disabled="p.isEnv" :options="typeOptions" size="small" /></div>
        <div class="row"><span class="lbl">baseURL</span><NInput v-model:value="p.baseURL" :disabled="p.isEnv" size="small" placeholder="https://api.anthropic.com" /></div>
        <div class="row"><span class="lbl">model</span><NInput v-model:value="p.model" :disabled="p.isEnv" size="small" placeholder="glm-5.2:cloud / claude-sonnet-5" /></div>
        <div class="row"><span class="lbl">authToken</span><NInput v-model:value="p.authToken" type="password" show-password-on="click" size="small" :placeholder="p.isEnv ? '(env)' : '留空保留已设值'" /></div>
        <div class="row"><span class="lbl">apiKey</span><NInput v-model:value="p.apiKey" type="password" show-password-on="click" size="small" :placeholder="p.isEnv ? '(env)' : '留空保留已设值'" /></div>
      </div>

      <NButton size="small" dashed @click="addProvider">+ 添加 provider</NButton>
    </div>

    <template #footer>
      <div class="flex gap-2 justify-end">
        <NButton size="small" @click="emit('close')">取消</NButton>
        <NButton size="small" type="primary" @click="save">保存</NButton>
      </div>
    </template>
  </NCard>
</template>

<style scoped>
.settings-card { width: 560px; max-width: 92vw; }
.settings-body { display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow: auto; }
.row { display: flex; align-items: center; gap: 8px; }
.lbl { width: 72px; font-size: 12px; color: #888; flex-shrink: 0; }
.provider-block { border: 1px solid #333; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.provider-head { display: flex; align-items: center; justify-content: space-between; }
.provider-name { font-weight: 500; color: #ddd; }
</style>