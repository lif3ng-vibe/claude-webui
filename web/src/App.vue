<script setup lang="ts">
import { NConfigProvider, NMessageProvider, darkTheme } from 'naive-ui';
import SessionsView from './components/SessionsView.vue';
</script>

<template>
  <NConfigProvider :theme="darkTheme">
    <NMessageProvider>
      <SessionsView />
    </NMessageProvider>
  </NConfigProvider>
</template>