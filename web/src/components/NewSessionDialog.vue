<script setup lang="ts">
import { ref } from 'vue';
import { NModal, NInput, NRadio, NRadioGroup, NButton, useMessage } from 'naive-ui';
import { useRouter } from 'vue-router';
import { createSessionStream } from '../api';
import { pickDirectory } from '../lib/desktop';
import { openWindow } from '../lib/openWindow';
import { broadcastInvalidate } from '../lib/broadcast';
import { useProviderMenu } from '../composables/useProviderMenu';
import ProviderMenu from './ProviderMenu.vue';

/** 新建会话模态：选目录（桌面原生框/web 输入）+ 模式（单发/终端）+ 首条指令。右键启动按钮选 provider。 */
const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>();
const router = useRouter();
const msg = useMessage();

const cwd = ref('');
const mode = ref<'prompt' | 'terminal'>('prompt');
const prompt = ref('');
const running = ref(false);
/** 右键选的 provider（undefined=默认）。 */
const providerId = ref<string | undefined>(undefined);
const menu = useProviderMenu();

async function chooseDir(): Promise<void> {
  const p = await pickDirectory();
  if (p) cwd.value = p;
}

/** 启动：overridePid 来自右键菜单；否则用已记录的 providerId（默认）。 */
function launch(overridePid?: string): void {
  if (overridePid !== undefined) providerId.value = overridePid;
  void (mode.value === 'prompt' ? runSingle(providerId.value) : runTerminal(providerId.value));
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
        <NButton @click="chooseDir">选择目录…</NButton>
      </div>
      <NRadioGroup v-model:value="mode">
        <NRadio value="prompt">单发首条指令</NRadio>
        <NRadio value="terminal">交互式终端</NRadio>
      </NRadioGroup>
      <NInput v-if="mode === 'prompt'" v-model:value="prompt" type="textarea" placeholder="首条指令…" :disabled="running" />
      <div class="flex justify-end gap-2">
        <NButton @click="emit('update:show', false)">取消</NButton>
        <NButton type="primary" :loading="running" :disabled="running" @click="launch()" @contextmenu.prevent="menu.open($event, (pid) => launch(pid))">
          启动
        </NButton>
      </div>
    </div>
    <ProviderMenu :show="menu.show.value" :x="menu.x.value" :y="menu.y.value" @choose="menu.choose" @update:show="menu.show.value = $event" />
  </NModal>
</template>
