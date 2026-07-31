import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import { router } from './router';
import { initShiki } from './lib/shiki';
import { setupBroadcastInvalidation } from './lib/broadcast';
import 'virtual:uno.css';
import './styles.css';

initShiki();

const app = createApp(App);
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

// 跨窗口：收到其它窗口的失效广播时，invalidate 本窗口 query 重新拉
setupBroadcastInvalidation((key) => {
  void queryClient.invalidateQueries({ queryKey: key });
});

app.use(createPinia());
app.use(VueQueryPlugin, { queryClient });
app.use(router);
app.mount('#app');