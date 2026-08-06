// 工作区后台同步：定时（~5s）
//  1) 按 dir 聚合拉 sessions，用最新 aiTitle 刷新 resume 标签的 registry.title（标签名实时更新）；
//  2) new 标签 sid 回填：同 cwd 锁保证同时只有一个 new 终端，取该 cwd 下 60s 窗口内最新未被认领的 session。
import { onMounted, onUnmounted } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { terminalRegistry } from '../lib/workspace/registry';
import { walkTabs } from '../lib/workspace/tree';
import { api, type SessionEntry } from '../api';

const POLL_MS = 5000;
const BACKFILL_WINDOW_MS = 60_000;

export function useWorkspaceSync(): void {
  const store = useWorkspaceStore();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    const tabs = walkTabs(store.root);

    // 1) 标题刷新
    const resumeTabs = tabs.filter((t) => t.kind === 'resume' && t.dirName && t.sessionId);
    const dirs = [...new Set(resumeTabs.map((t) => t.dirName!))];
    const sidTitle = new Map<string, string>();
    await Promise.all(
      dirs.map(async (d) => {
        try {
          for (const s of await api.sessions(d)) if (s.title) sidTitle.set(s.sessionId, s.title);
        } catch {
          /* 忽略 */
        }
      }),
    );
    for (const t of resumeTabs) {
      const title = sidTitle.get(t.sessionId!);
      const e = terminalRegistry.get(t.id);
      if (title && e) e.title.value = title;
    }

    // 2) new 标签 sid 回填
    const newTabs = tabs.filter((t) => t.kind === 'new' && t.cwd);
    if (newTabs.length) {
      try {
        const projects = await api.projects();
        const knownSids = new Set(tabs.filter((t) => t.sessionId).map((t) => t.sessionId));
        const cache = new Map<string, SessionEntry[]>();
        const since = Date.now() - BACKFILL_WINDOW_MS;
        for (const t of newTabs) {
          const proj = projects.find((p) => p.cwd === t.cwd);
          if (!proj) continue;
          if (!cache.has(proj.dirName)) {
            try {
              cache.set(proj.dirName, await api.sessions(proj.dirName));
            } catch {
              /* 忽略 */
            }
          }
          const ss = (cache.get(proj.dirName) ?? []).slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
          const cand = ss.find((s) => !knownSids.has(s.sessionId) && s.mtimeMs > since);
          if (cand) {
            knownSids.add(cand.sessionId);
            store.backfillTab(t.id, { kind: 'resume', dirName: proj.dirName, sessionId: cand.sessionId, title: cand.title || cand.preview });
          }
        }
      } catch {
        /* 忽略 */
      }
    }
  }

  onMounted(() => {
    timer = setInterval(() => void tick(), POLL_MS);
    void tick();
  });
  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });
}
