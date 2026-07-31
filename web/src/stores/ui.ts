import { defineStore } from 'pinia';

export const useUiStore = defineStore('ui', {
  state: () => ({ view: 'sessions' as 'sessions' | 'chat' | 'service' }),
  actions: {
    setView(v: 'sessions' | 'chat' | 'service') {
      this.view = v;
    },
  },
});