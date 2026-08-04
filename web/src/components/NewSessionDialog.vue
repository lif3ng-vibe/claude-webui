<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { NModal, NInput, NRadio, NRadioGroup, NButton, NSelect, NPopover, NEmpty, useMessage } from 'naive-ui';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { createSessionStream, api, type ProjectEntry } from '../api';
import { pickDirectory, isDesktop } from '../lib/desktop';
import { openWindow } from '../lib/openWindow';
import { broadcastInvalidate } from '../lib/broadcast';
import { useConfig } from '../composables/useConfig';

/**
 * 新建会话模态：选目录（桌面端原生文件夹框 / web 端已用目录列表）
 * + provider 下拉 + 模式（单发/终端）+ 首条指令。
 * 父组件可经 defaultDir / defaultProviderId 预填。
 */
const props = defineProps<{
  show: boolean;
  defaultDir?: string; // 预填工作目录
  defaultProviderId?: string; // 预选 provider（'' 或 undefined = 默认）
}>();
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>();
const router = useRouter();
const msg = useMessage();

const cwd = ref('');
/** providerId：'' = 默认（不注入，走 claude 自身 settings.json）；否则 = 该 provider id。 */
const providerId = ref('');
const mode = ref<'prompt' | 'terminal'>('prompt');
const prompt = ref('');
const running = ref(false);
const showDirPopover = ref(false);

// 对话框实例复用（show true→false→true）：每次打开按当前 prop 重置可编辑态
watch(
  () => props.show,
  (s) => {
    if (s) {
      cwd.value = props.defaultDir ?? '';
      providerId.value = props.defaultProviderId ?? '';
    }
  },
);

// provider 下拉选项：默认（claude 配置，不注入）+ 各 provider
const config = useConfig();
const providerOptions = computed(() => [
  { label: '默认（claude 自身配置）', value: '' },
  ...(config.data.value?.providers ?? []).map((p) => ({ label: `${p.name}${p.isEnv ? ' (env)' : ''}`, value: p.id })),
]);

// web 端选目录用：已用工作目录列表
const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects });
const dirOptions = computed<ProjectEntry[]>(() => projectsQuery.data.value ?? []);
function pickProjectDir(p: ProjectEntry): void {
  cwd.value = p.cwd;
  showDirPopover.value = false;
}

/** 桌面端：弹原生文件夹框；web 端走 NPopover 已用目录列表（见模板）。 */
async function chooseDir(): Promise<void> {
  const p = await pickDirectory();
  if (p) cwd.value = p;
}

/** 启动：providerId '' → undefined（不注入）。 */
function launch(): void {
  const pid = providerId.value || undefined;
  void (mode.value === 'prompt' ? runSingle(pid) : runTerminal(pid));
}

async function runSingle(pid?: string): Promise<void> {
  if (!cwd.value.trim()) { msg.warning('请选择或输入工作目录'); return; }
  if (!prompt.value.trim()) { msg.warning('请输入首条指令'); return; }
  running.value = true;
  try {
    await createSessionStream(cwd.value.trim(), prompt.value.trim(), (ev) => {
      if (ev.event === 'created' && ev.data?.sessionId) {
        broadcastInvalidate([['projects'], ['sessions']]);
        emit('update:show', false);
        router.push({ name: 'session', params: { dir: ev.data.dirName, sid: ev.data.sessionId } });
      } else if (ev.event === 'error') {
        msg.error(String(ev.data?.error ?? '失败'));
      }
    }, { providerId: pid });
  } catch (e) {
    msg.error(String(e));
  } finally {
    running.value = false;
  }
}

function runTerminal(pid?: string): void {
  if (!cwd.value.trim()) { msg.warning('请选择或输入工作目录'); return; }
  emit('update:show', false);
  const q = `?cwd=${encodeURIComponent(cwd.value.trim())}${pid ? `&provider=${encodeURIComponent(pid)}` : ''}`;
  openWindow(`/terminal/new${q}`);
}
</script>

<template>
  <NModal :show="props.show" @update:show="emit('update:show', $event)" preset="card" title="新建会话" style="max-width: 520px">
    <div class="flex flex-col gap-3">
      <div class="flex gap-2">
        <NInput v-model:value="cwd" placeholder="工作目录绝对路径…" />
        <!-- 桌面端：原生文件夹框；web 端：已用工作目录列表 popover -->
        <NButton v-if="isDesktop" @click="chooseDir">选择目录…</NButton>
        <NPopover v-else trigger="click" placement="bottom-end" :width="360" v-model:show="showDirPopover">
          <template #trigger>
            <NButton>选择目录…</NButton>
          </template>
          <div class="flex flex-col gap-1 max-h-60 overflow-auto">
            <NEmpty v-if="!dirOptions.length" description="暂无已用目录，请在左侧手输绝对路径" />
            <button
              v-for="p in dirOptions"
              :key="p.dirName"
              class="text-left px-2 py-1 rounded hover:bg-[#ffffff14] truncate text-[13px]"
              :title="p.cwd"
              @click="pickProjectDir(p)"
            >{{ p.cwd }}</button>
          </div>
        </NPopover>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-[13px] text-[#888] whitespace-nowrap">Provider</span>
        <NSelect v-model:value="providerId" :options="providerOptions" size="small" />
      </div>
      <NRadioGroup v-model:value="mode">
        <NRadio value="prompt">单发首条指令</NRadio>
        <NRadio value="terminal">交互式终端</NRadio>
      </NRadioGroup>
      <NInput v-if="mode === 'prompt'" v-model:value="prompt" type="textarea" placeholder="首条指令…" :disabled="running" />
      <div class="flex justify-end gap-2">
        <NButton @click="emit('update:show', false)">取消</NButton>
        <NButton type="primary" :loading="running" :disabled="running" @click="launch()">启动</NButton>
      </div>
    </div>
  </NModal>
</template>
