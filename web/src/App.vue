<script setup lang="ts">
import { NConfigProvider, NMessageProvider, darkTheme } from 'naive-ui';
</script>

<template>
  <NConfigProvider :theme="darkTheme">
    <NMessageProvider>
      <router-view />
    </NMessageProvider>
  </NConfigProvider>
</template>