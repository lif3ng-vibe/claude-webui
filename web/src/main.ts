import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import 'virtual:uno.css';
import './styles.css';

const app = createApp(App);
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient });
app.mount('#app');