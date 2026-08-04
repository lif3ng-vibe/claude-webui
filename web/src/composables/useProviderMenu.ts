import { ref } from 'vue';

/**
 * 右键 provider 菜单状态：单例 composable，由 <ProviderMenu> 渲染，
 * 任意按钮 @contextmenu.prevent 触发 open(e, onPick)。
 * choose(undefined) = 用默认（活动/env）；choose(id) = 用该 provider。
 */
export function useProviderMenu() {
  const show = ref(false);
  const x = ref(0);
  const y = ref(0);
  let picker: ((providerId?: string) => void) | null = null;

  function open(e: MouseEvent, onPick: (providerId?: string) => void): void {
    e.preventDefault();
    picker = onPick;
    x.value = e.clientX;
    y.value = e.clientY;
    show.value = true;
  }
  function choose(providerId?: string): void {
    show.value = false;
    picker?.(providerId);
    picker = null;
  }
  return { show, x, y, open, choose };
}
