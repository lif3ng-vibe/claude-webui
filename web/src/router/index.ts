import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { setHead, FAVICON } from '../lib/head';
import MainApp from '../views/MainApp.vue';
import ItemLayout from '../views/ItemLayout.vue';
import DirPage from '../views/DirPage.vue';
import SessionPage from '../views/SessionPage.vue';
import ConversationPage from '../views/ConversationPage.vue';

// 主页 / 不走路由切换（Sessions/Chat 仍由 Pinia ui.view 驱动）；
// 下列三项为精简单页 shell（独立窗口），父子可下钻。
const routes: RouteRecordRaw[] = [
  { path: '/', component: MainApp, name: 'home' },
  {
    path: '/projects/:dir',
    component: ItemLayout,
    children: [{ path: '', component: DirPage, name: 'dir' }],
  },
  {
    path: '/projects/:dir/sessions/:sid',
    component: ItemLayout,
    children: [{ path: '', component: SessionPage, name: 'session' }],
  },
  {
    path: '/conversations/:id',
    component: ItemLayout,
    children: [{ path: '', component: ConversationPage, name: 'conversation' }],
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// type 级 title/favicon：按路由 pattern 立刻设，无数据依赖、几乎不闪。
// 各页面加载数据后再细化 title（conversation 还按 kind 切 favicon）。
router.beforeEach((to) => {
  switch (to.name) {
    case 'home':
      setHead({ title: 'claude-webui', favicon: FAVICON.home });
      break;
    case 'dir':
      setHead({ title: 'Sessions · claude-webui', favicon: FAVICON.dir });
      break;
    case 'session':
      setHead({ title: 'Session · claude-webui', favicon: FAVICON.session });
      break;
    case 'conversation':
      setHead({ title: 'Conversation · claude-webui', favicon: FAVICON.chat });
      break;
  }
});