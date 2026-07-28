import { defineStore } from 'pinia';

export const useUiStore = defineStore('ui', {
  state: () => ({ view: 'sessions' as 'sessions' | 'chat' }),
  actions: {
    setView(v: 'sessions' | 'chat') {
      this.view = v;
    },
  },
});