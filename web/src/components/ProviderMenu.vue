<script setup lang="ts">
import { computed } from 'vue';
import { NDropdown, type DropdownOption } from 'naive-ui';
import { useConfig } from '../composables/useConfig';

/** 右键 provider 下拉：定位到光标，选项=providers + 「默认（活动/env）」。单例，由 useProviderMenu 驱动。 */
const props = defineProps<{
  show: boolean;
  x: number;
  y: number;
}>();
const emit = defineEmits<{
  (e: 'choose', providerId?: string): void;
  (e: 'update:show', v: boolean): void;
}>();

const cfg = useConfig();
const options = computed<DropdownOption[]>(() => {
  const list: DropdownOption[] = [{ label: '默认（活动/env）', key: '' }];
  for (const p of cfg.data.value?.providers ?? []) {
    list.push({ label: `${p.name} · ${p.model}`, key: p.id });
  }
  return list;
});
function onSelect(key: string): void {
  emit('choose', key === '' ? undefined : key);
}
</script>

<template>
  <NDropdown
    placement="bottom-start"
    trigger="manual"
    :show="props.show"
    :x="props.x"
    :y="props.y"
    :options="options"
    @select="onSelect"
    @clickoutside="emit('update:show', false)"
  />
</template>
