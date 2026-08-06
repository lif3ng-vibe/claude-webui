<script setup lang="ts">
// 添加终端到工作区：续接现有 session（resume 标签）或新建终端（new 标签）。
// 目标组来自 store.addTarget.groupId（undefined → 新组）。确认后 store.addTab + closeAdd。
import { ref, computed, watch } from 'vue';
import { NModal, NInput, NRadio, NRadioGroup, NButton, NSelect, NPopover, NEmpty, useMessage } from 'naive-ui';
import { useQuery } from '@tanstack/vue-query';
import { api, type ProjectEntry, type SessionEntry, type TabDescriptor } from '../../api';
import { pickDirectory, isDesktop } from '../../lib/desktop';
import { useConfig } from '../../composables/useConfig';
import { useWorkspaceStore } from '../../stores/workspace';

const store = useWorkspaceStore();
const msg = useMessage();
const show = computed(() => store.addTarget !== null);
const targetGroupId = computed(() => store.addTarget?.groupId);

const mode = ref<'resume' | 'new'>('resume');
const cwd = ref('');
const providerId = ref('');
const selDir = ref<string>(''); // 选中的项目 dirName
const selSid = ref<string>('');
const showDirPopover = ref(false);

// 打开时重置
watch(show, (s) => {
  if (s) {
    mode.value = 'resume';
    cwd.value = '';
    providerId.value = '';
    selDir.value = '';
    selSid.value = '';
  }
});

const config = useConfig();
const providerOptions = computed(() => [
  { label: '默认（claude 自身配置）', value: '' },
  ...(config.data.value?.providers ?? []).map((p) => ({ label: `${p.name}${p.isEnv ? ' (env)' : ''}`, value: p.id })),
]);

const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects });
const projectOptions = computed(() => (projectsQuery.data.value ?? []).map((p) => ({ label: p.cwd, value: p.dirName })));
const sessionsQuery = useQuery({
  queryKey: ['sessions', selDir],
  queryFn: () => (selDir.value ? api.sessions(selDir.value) : Promise.resolve([])),
  enabled: computed(() => !!selDir.value),
});
const sessionOptions = computed(() =>
  (sessionsQuery.data.value ?? []).map((s: SessionEntry) => ({
    label: s.title || s.preview || s.sessionId.slice(0, 8),
    value: s.sessionId,
  })),
);

async function chooseDir(): Promise<void> {
  const p = await pickDirectory();
  if (p) cwd.value = p;
}

function confirm(): void {
  const pid = providerId.value || undefined;
  if (mode.value === 'resume') {
    if (!selDir.value || !selSid.value) {
      msg.warning('请选择工作目录与会话');
      return;
    }
    const proj = (projectsQuery.data.value ?? []).find((p) => p.dirName === selDir.value);
    const tab: TabDescriptor = { id: store.genId(), kind: 'resume', dirName: selDir.value, sessionId: selSid.value, providerId: pid, title: sessionOptions.value.find((o) => o.value === selSid.value)?.label };
    void proj;
    store.addTab(tab, { groupId: targetGroupId.value });
  } else {
    if (!cwd.value.trim()) {
      msg.warning('请选择或输入工作目录');
      return;
    }
    const tab: TabDescriptor = { id: store.genId(), kind: 'new', cwd: cwd.value.trim(), providerId: pid };
    store.addTab(tab, { groupId: targetGroupId.value });
  }
  store.closeAdd();
}
</script>

<template>
  <NModal :show="show" preset="card" title="添加终端到工作区" style="max-width: 520px" @update:show="(v: boolean) => !v && store.closeAdd()">
    <div class="flex flex-col gap-3">
      <NRadioGroup v-model:value="mode">
        <NRadio value="resume">续接现有会话</NRadio>
        <NRadio value="new">新建终端</NRadio>
      </NRadioGroup>

      <template v-if="mode === 'resume'">
        <div class="flex items-center gap-2">
          <span class="text-[13px] text-[#888] whitespace-nowrap w-16">工作目录</span>
          <NSelect v-model:value="selDir" :options="projectOptions" placeholder="选择工作目录…" size="small" filterable @update:value="selSid = ''" />
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[13px] text-[#888] whitespace-nowrap w-16">会话</span>
          <NSelect v-model:value="selSid" :options="sessionOptions" placeholder="选择会话…" size="small" filterable :disabled="!selDir" />
        </div>
      </template>

      <template v-else>
        <div class="flex gap-2">
          <NInput v-model:value="cwd" placeholder="工作目录绝对路径…" />
          <NButton v-if="isDesktop" @click="chooseDir">选择目录…</NButton>
          <NPopover v-else trigger="click" placement="bottom-end" :width="360" v-model:show="showDirPopover">
            <template #trigger>
              <NButton>选择目录…</NButton>
            </template>
            <div class="flex flex-col gap-1 max-h-60 overflow-auto">
              <NEmpty v-if="!projectOptions.length" description="暂无已用目录，请手输绝对路径" />
              <button
                v-for="p in (projectsQuery.data.value ?? [])"
                :key="p.dirName"
                class="text-left px-2 py-1 rounded hover:bg-[#ffffff14] truncate text-[13px] shrink-0"
                :title="p.cwd"
                @click="cwd = p.cwd; showDirPopover = false"
              >{{ p.cwd }}</button>
            </div>
          </NPopover>
        </div>
      </template>

      <div class="flex items-center gap-2">
        <span class="text-[13px] text-[#888] whitespace-nowrap w-16">Provider</span>
        <NSelect v-model:value="providerId" :options="providerOptions" size="small" />
      </div>

      <div class="flex justify-end gap-2">
        <NButton @click="store.closeAdd()">取消</NButton>
        <NButton type="primary" @click="confirm()">添加</NButton>
      </div>
    </div>
  </NModal>
</template>
