import { defineStore } from 'pinia';

export const useUiStore = defineStore('ui', {
  state: () => ({ view: 'sessions' as 'sessions' | 'chat' | 'service' | 'gateway' | 'workspace' }),
  actions: {
    setView(v: 'sessions' | 'chat' | 'service' | 'gateway' | 'workspace') {
      this.view = v;
    },
  },
});