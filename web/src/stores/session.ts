import { defineStore } from 'pinia';

interface SessionState {
  dirName: string;
  sessionId: string;
  title: string;
}

export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({ dirName: '', sessionId: '', title: '' }),
  actions: {
    select(dirName: string, sessionId: string, title: string) {
      this.dirName = dirName;
      this.sessionId = sessionId;
      this.title = title;
    },
    clear() {
      this.dirName = '';
      this.sessionId = '';
      this.title = '';
    },
  },
});