<script setup lang="ts">
import { NConfigProvider, NMessageProvider, darkTheme } from 'naive-ui';
import TitleBar from './components/TitleBar.vue';
</script>

<template>
  <NConfigProvider :theme="darkTheme">
    <NMessageProvider>
      <div class="flex flex-col h-screen">
        <TitleBar />
        <div class="flex-1 min-h-0">
          <router-view />
        </div>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>