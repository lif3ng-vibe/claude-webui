<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

// 精简单页 shell：无 Sessions/Chat 顶栏，不能切同级列表项。
// 仅父子钻取间显示"← 返回"：判断本窗口是否从父项钻取而来
//（window.history.position > 0 表示本窗口有上一页可回退）。
const router = useRouter();
const showBack = ref((window.history.state?.position ?? 0) > 0);
router.afterEach(() => {
  showBack.value = (window.history.state?.position ?? 0) > 0;
});

function goBack(): void {
  void router.back();
}
</script>

<template>
  <div class="h-full flex flex-col">
    <div v-if="showBack" class="item-topbar">
      <button class="back-btn" title="返回上层" @click="goBack">← 返回</button>
    </div>
    <div class="flex-1 min-h-0">
      <router-view />
    </div>
  </div>
</template>

<style scoped>
.item-topbar {
  display: flex;
  align-items: center;
  padding: 4px 10px;
  border-bottom: 1px solid #333;
  background: #1a1a1a;
}
.back-btn {
  font-size: 12px;
  color: #8ab4f8;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.back-btn:hover {
  background: #ffffff14;
}
</style>