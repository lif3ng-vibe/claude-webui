# 新建会话交互改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 web 端「新建会话」流程顺滑：web 端能选目录（已用目录列表）、对话框内可见可选 provider、主页目录行右侧可直接「在该目录新建」。

**Architecture:** 纯前端改动（3 个 Vue 文件 + 文档）。`NewSessionDialog` 加 `defaultDir`/`defaultProviderId` prop 入口、provider 下拉、web 端已用目录列表 popover，并去掉被下拉取代的隐藏右键菜单。`SessionsView`/`DirPage` 加 `pendingDir`/`pendingProviderId` 状态，外层「+」按钮右键修复为预选 provider、左键/目录行按钮预填目录。后端 `/api/sessions/new`、`/api/terminal/new`、`providerEnv`、`--settings` 注入机制均不动。

**Tech Stack:** Vue 3 `<script setup>` + naive-ui（NModal/NSelect/NPopover/NButton/NInput/NRadio/NEmpty）+ @tanstack/vue-query + vue-router。

## Global Constraints

- **前端无单测基建**：`web/package.json` 只有 `dev`/`build`/`typecheck`，没有 vitest。每个 task 的验证 = `cd web && npm run typecheck`（vue-tsc）通过 + 浏览器手测要点。**不引入新测试框架。**
- **后端零改动**：`/api/sessions/new`（`src/server/index.ts:279-336`）、WS `/api/terminal/new`（`:679-685`）、`providerEnv`（`src/config.ts:138-146`）、`--settings` 注入均不改。前端只是把下拉值当 `providerId` 传。
- **`~/.claude` 只读不变**；provider 选择只影响前端传哪个 `providerId`（`''`/`undefined` = 不注入 = 走 claude 自身 `settings.json`）。
- **代码注释中文，标识符/字符串字面量英文**（项目 `CLAUDE.md` 约定）。
- **commit message 用中文 Conventional Commits**（`feat(web): …`）。各 task 末尾的 commit 步骤可按「批量提交」偏好合并到实现末尾一次提交，不必逐 task 提交。
- 设计依据：`docs/superpowers/specs/2026-08-04-new-session-improvements-design.md`。

---

## File Structure

- **Modify** `web/src/components/NewSessionDialog.vue` — 核心改造：prop 入口、provider 下拉、web 选目录、去隐藏右键。整个 `<script setup>` 与 `<template>` 重写（文件仅 87 行）。
- **Modify** `web/src/components/SessionsView.vue` — 加 `pendingDir`/`pendingProviderId`/`openNew`；顶部「+」右键修复预选；目录行 `:523` 加「+」按钮；`:624` 给 `NewSessionDialog` 传 prop。
- **Modify** `web/src/views/DirPage.vue` — 加 `pendingDir`/`pendingProviderId`/`openNew`（预填当前目录 cwd）；「+」`:114` 左键预填 + 右键修复预选；`:147` 传 prop。
- **Modify** `README.md` — 「右键选 provider 启动」段 + 新建会话相关描述同步。
- **Modify** `docs/design.md` — §4.11 同步。

---

## Task 1: NewSessionDialog 改造（prop 入口 + provider 下拉 + web 选目录 + 去隐藏右键）

**Files:**
- Modify: `web/src/components/NewSessionDialog.vue`（整体重写 `<script setup>` + `<template>`）

**Interfaces:**
- Consumes: `api.projects`（`web/src/api.ts:236`，返回 `ProjectEntry[]`）、`useConfig()`（`web/src/composables/useConfig.ts`，`config.data.value.providers: PublicProvider[]`）、`pickDirectory`/`isDesktop`（`web/src/lib/desktop.ts:53,96`）、`createSessionStream`（`web/src/api.ts:201`，opts `{providerId?}`）。
- Produces: `NewSessionDialog` 新增 props `defaultDir?: string`、`defaultProviderId?: string`（供 Task 2/3 的父组件传入）；**移除**对话框内 `useProviderMenu`/`ProviderMenu` 用法。

- [ ] **Step 1: 重写 `<script setup>`**

把 `web/src/components/NewSessionDialog.vue` 第 1–64 行（`<script setup>` 整块）替换为：

```ts
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { NModal, NInput, NRadio, NRadioGroup, NButton, NSelect, NPopover, NEmpty, useMessage } from 'naive-ui';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { createSessionStream, api, type ProjectEntry } from '../api';
import { pickDirectory, isDesktop } from '../lib/desktop';
import { openWindow } from '../lib/openWindow';
import { broadcastInvalidate } from '../lib/broadcast';
import { useConfig } from '../composables/useConfig';

/**
 * 新建会话模态：选目录（桌面端原生文件夹框 / web 端已用目录列表）
 * + provider 下拉 + 模式（单发/终端）+ 首条指令。
 * 父组件可经 defaultDir / defaultProviderId 预填。
 */
const props = defineProps<{
  show: boolean;
  defaultDir?: string; // 预填工作目录
  defaultProviderId?: string; // 预选 provider（'' 或 undefined = 默认）
}>();
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>();
const router = useRouter();
const msg = useMessage();

const cwd = ref('');
/** providerId：'' = 默认（不注入，走 claude 自身 settings.json）；否则 = 该 provider id。 */
const providerId = ref('');
const mode = ref<'prompt' | 'terminal'>('prompt');
const prompt = ref('');
const running = ref(false);
const showDirPopover = ref(false);

// 对话框实例复用（show true→false→true）：每次打开按当前 prop 重置可编辑态
watch(
  () => props.show,
  (s) => {
    if (s) {
      cwd.value = props.defaultDir ?? '';
      providerId.value = props.defaultProviderId ?? '';
    }
  },
);

// provider 下拉选项：默认（claude 配置，不注入）+ 各 provider
const config = useConfig();
const providerOptions = computed(() => [
  { label: '默认（claude 自身配置）', value: '' },
  ...(config.data.value?.providers ?? []).map((p) => ({ label: `${p.name}${p.isEnv ? ' (env)' : ''}`, value: p.id })),
]);

// web 端选目录用：已用工作目录列表
const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects });
const dirOptions = computed<ProjectEntry[]>(() => projectsQuery.data.value ?? []);
function pickProjectDir(p: ProjectEntry): void {
  cwd.value = p.cwd;
  showDirPopover.value = false;
}

/** 桌面端：弹原生文件夹框；web 端走 NPopover 已用目录列表（见模板）。 */
async function chooseDir(): Promise<void> {
  const p = await pickDirectory();
  if (p) cwd.value = p;
}

/** 启动：providerId '' → undefined（不注入）。 */
function launch(): void {
  const pid = providerId.value || undefined;
  void (mode.value === 'prompt' ? runSingle(pid) : runTerminal(pid));
}

async function runSingle(pid?: string): Promise<void> {
  if (!cwd.value.trim()) { msg.warning('请选择或输入工作目录'); return; }
  if (!prompt.value.trim()) { msg.warning('请输入首条指令'); return; }
  running.value = true;
  try {
    await createSessionStream(cwd.value.trim(), prompt.value.trim(), (ev) => {
      if (ev.event === 'created' && ev.data?.sessionId) {
        broadcastInvalidate([['projects'], ['sessions']]);
        emit('update:show', false);
        router.push({ name: 'session', params: { dir: ev.data.dirName, sid: ev.data.sessionId } });
      } else if (ev.event === 'error') {
        msg.error(String(ev.data?.error ?? '失败'));
      }
    }, { providerId: pid });
  } catch (e) {
    msg.error(String(e));
  } finally {
    running.value = false;
  }
}

function runTerminal(pid?: string): void {
  if (!cwd.value.trim()) { msg.warning('请选择或输入工作目录'); return; }
  emit('update:show', false);
  const q = `?cwd=${encodeURIComponent(cwd.value.trim())}${pid ? `&provider=${encodeURIComponent(pid)}` : ''}`;
  openWindow(`/terminal/new${q}`);
}
</script>
```

- [ ] **Step 2: 重写 `<template>`**

把第 66–87 行（`<template>` 整块）替换为：

```html
<template>
  <NModal :show="props.show" @update:show="emit('update:show', $event)" preset="card" title="新建会话" style="max-width: 520px">
    <div class="flex flex-col gap-3">
      <div class="flex gap-2">
        <NInput v-model:value="cwd" placeholder="工作目录绝对路径…" />
        <!-- 桌面端：原生文件夹框；web 端：已用工作目录列表 popover -->
        <NButton v-if="isDesktop" @click="chooseDir">选择目录…</NButton>
        <NPopover v-else trigger="click" placement="bottom-end" :width="360" v-model:show="showDirPopover">
          <template #trigger>
            <NButton>选择目录…</NButton>
          </template>
          <div class="flex flex-col gap-1 max-h-60 overflow-auto">
            <NEmpty v-if="!dirOptions.length" description="暂无已用目录，请在左侧手输绝对路径" />
            <button
              v-for="p in dirOptions"
              :key="p.dirName"
              class="text-left px-2 py-1 rounded hover:bg-[#ffffff14] truncate text-[13px]"
              :title="p.cwd"
              @click="pickProjectDir(p)"
            >{{ p.cwd }}</button>
          </div>
        </NPopover>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-[13px] text-[#888] whitespace-nowrap">Provider</span>
        <NSelect v-model:value="providerId" :options="providerOptions" size="small" />
      </div>
      <NRadioGroup v-model:value="mode">
        <NRadio value="prompt">单发首条指令</NRadio>
        <NRadio value="terminal">交互式终端</NRadio>
      </NRadioGroup>
      <NInput v-if="mode === 'prompt'" v-model:value="prompt" type="textarea" placeholder="首条指令…" :disabled="running" />
      <div class="flex justify-end gap-2">
        <NButton @click="emit('update:show', false)">取消</NButton>
        <NButton type="primary" :loading="running" :disabled="running" @click="launch()">启动</NButton>
      </div>
    </div>
  </NModal>
</template>
```

要点：移除了原 `useProviderMenu`/`ProviderMenu` import 与 `<ProviderMenu>` 标签；启动按钮去掉 `@contextmenu.prevent`；`launch()` 不再接 `overridePid`（由下拉驱动）。

- [ ] **Step 3: 类型检查**

Run: `cd web && npm run typecheck`
Expected: 无错误（exit 0）。常见报错排查：`isDesktop` 未导入、`PublicProvider` 的 `isEnv` 字段访问——均已在上面对齐 `api.ts:31-39`。

- [ ] **Step 4: 手动验证（web 端）**

`npm run dev`（后端 3000）+ `cd web && npm run dev`（5173），浏览器开 http://localhost:5173 ：
- 点顶部「+」打开对话框：provider 下拉含「默认（claude 自身配置）」+ 各 provider；切换正常。
- web 端「选择目录…」弹出已用工作目录列表，点一项预填到 `cwd` 输入框，popover 关闭；全新目录仍可手输。
- 选目录 + 选 provider（或默认）+ 单发模式 + 输首条指令 → 启动 → 跳到新 session 时间线（验证 `/api/sessions/new` body 的 `providerId` 为下拉值；默认时为 undefined 不注入）。
- 交互式终端模式：启动开 `/terminal/new?cwd=&provider=` 新窗口。
- 桌面端回归（可选）：`isDesktop` 时「选择目录…」仍弹原生文件夹框。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/NewSessionDialog.vue
git commit -m "feat(web): 新建会话对话框加 provider 下拉与 web 选目录"
```

---

## Task 2: SessionsView — 目录行「+」按钮 + 顶部「+」右键预选 + 传 prop

**Files:**
- Modify: `web/src/components/SessionsView.vue`（script `:46-47` 附近、模板 `:479`、`:523`、`:624`）

**Interfaces:**
- Consumes: Task 1 的 `NewSessionDialog` props `defaultDir`/`defaultProviderId`。
- Produces: 无（消费侧）。

- [ ] **Step 1: 加 pending 状态与 openNew 函数**

在 `web/src/components/SessionsView.vue` 第 46–47 行：

```ts
const showNew = ref(false);
const newMenu = useProviderMenu();
```

之后插入：

```ts
const pendingDir = ref<string | undefined>();
const pendingProviderId = ref<string | undefined>();
/** 打开新建会话对话框；dir 预填工作目录，pid 预选 provider。 */
function openNew(dir?: string, pid?: string): void {
  pendingDir.value = dir;
  pendingProviderId.value = pid;
  showNew.value = true;
}
```

- [ ] **Step 2: 顶部「+」按钮改用 openNew（修右键丢 pid）**

第 479 行：

```html
<button class="icon-btn" title="新建会话（右键选 provider）" @click="showNew = true" @contextmenu.prevent="newMenu.open($event, () => { showNew = true })">
```

改为：

```html
<button class="icon-btn" title="新建会话（右键选 provider）" @click="openNew()" @contextmenu.prevent="newMenu.open($event, (pid?: string) => openNew(undefined, pid))">
```

- [ ] **Step 3: 目录行右侧加「+」按钮（在该目录新建）**

第 523 行（目录行 popout ↗ 按钮那一行）：

```html
<button class="icon-btn-sm popout" title="新窗口打开该目录" @click.stop="popDir(node.p)"><Icon name="arrow-up-right" :size="14" /></button>
```

在其**前面**插入新按钮（顺序变成 `[+新建] [↗新窗口]`）：

```html
<button class="icon-btn-sm" title="在此目录新建会话（右键选 provider）" @click.stop="openNew(node.p.cwd)" @contextmenu.prevent="newMenu.open($event, (pid?: string) => openNew(node.p.cwd, pid))">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
</button>
```

- [ ] **Step 4: 给 NewSessionDialog 传 prop**

第 624 行：

```html
<NewSessionDialog :show="showNew" @update:show="showNew = $event" />
```

改为：

```html
<NewSessionDialog :show="showNew" :default-dir="pendingDir" :default-provider-id="pendingProviderId" @update:show="showNew = $event" />
```

- [ ] **Step 5: 类型检查**

Run: `cd web && npm run typecheck`
Expected: exit 0。

- [ ] **Step 6: 手动验证**

浏览器主页：
- 目录行右侧出现「+」按钮（↗ 左边）；点击 → 对话框打开且 `cwd` 已预填该目录 cwd。
- 目录行「+」右键 → provider 菜单 → 选一项 → 对话框打开，provider 下落该项。
- 顶部「+」右键选 provider → 对话框 provider 下落该项（修复原来丢 pid）；左键 → 默认。
- 再次打开对话框（不同目录/不同 provider）预填正确刷新（验证 Task 1 的 watch 重置）。

- [ ] **Step 7: Commit**

```bash
git add web/src/components/SessionsView.vue
git commit -m "feat(web): 目录行加新建会话按钮并修复右键预选 provider"
```

---

## Task 3: DirPage — 「+」预填当前目录 + 右键预选 + 传 prop

**Files:**
- Modify: `web/src/views/DirPage.vue`（script `:23-24` 附近、模板 `:114`、`:147`）

**Interfaces:**
- Consumes: Task 1 的 `NewSessionDialog` props；本页 `projectsQuery`（`:50`）反查当前目录 cwd。
- Produces: 无。

- [ ] **Step 1: 加 pending 状态与 openNew 函数**

在 `web/src/views/DirPage.vue` 第 23–24 行：

```ts
const showNew = ref(false);
const newMenu = useProviderMenu();
```

之后插入：

```ts
const pendingDir = ref<string | undefined>();
const pendingProviderId = ref<string | undefined>();
/** 打开新建会话对话框；预填当前目录 cwd，pid 预选 provider。 */
function openNew(pid?: string): void {
  const p = (projectsQuery.data.value ?? []).find((x) => x.dirName === dir.value);
  pendingDir.value = p?.cwd;
  pendingProviderId.value = pid;
  showNew.value = true;
}
```

- [ ] **Step 2: 「+」按钮左键预填目录 + 右键预选**

第 114 行：

```html
<button class="icon-btn" title="新建会话（右键选 provider）" @click="showNew = true" @contextmenu.prevent="newMenu.open($event, () => { showNew = true })">
```

改为：

```html
<button class="icon-btn" title="新建会话（右键选 provider）" @click="openNew()" @contextmenu.prevent="newMenu.open($event, (pid?: string) => openNew(pid))">
```

- [ ] **Step 3: 给 NewSessionDialog 传 prop**

第 147 行：

```html
<NewSessionDialog :show="showNew" @update:show="showNew = $event" />
```

改为：

```html
<NewSessionDialog :show="showNew" :default-dir="pendingDir" :default-provider-id="pendingProviderId" @update:show="showNew = $event" />
```

- [ ] **Step 4: 类型检查**

Run: `cd web && npm run typecheck`
Expected: exit 0。

- [ ] **Step 5: 手动验证**

进任一目录页（`/projects/:dir`，可从主页 ↗ 打开）：
- header「+」点击 → 对话框 `cwd` 已预填该目录 cwd（无需重选）。
- 「+」右键选 provider → 对话框 provider 下落该项。
- 启动单发会正常建在该目录。

- [ ] **Step 6: Commit**

```bash
git add web/src/views/DirPage.vue
git commit -m "feat(web): DirPage 新建会话预填当前目录并修复右键预选"
```

---

## Task 4: 文档同步（README + design.md）

**Files:**
- Modify: `README.md`（「右键选 provider 启动」段，约 `:16`；功能列表 `:7`）
- Modify: `docs/design.md`（§4.11）

**Interfaces:** 无（纯文档）。

- [ ] **Step 1: 更新 README「右键选 provider 启动」段**

`README.md` 第 16 行整段（以「**右键选 provider 启动**：」开头）。把其中关于「新建会话」的描述改为对话框内可选；并补 web 选目录、目录行「+」按钮。将该段改为：

```markdown
**新建会话**：「+ 新会话」对话框内可直接选 **provider**（下拉：默认=走 claude 自身 `~/.claude/settings.json` 配置，即 cc-switch 当前选中；或任一已配 provider，经 `claude --settings` 一次性注入，不持久化）。**选目录**：桌面端弹原生文件夹框；web 端点「选择目录…」从已用工作目录列表里挑，全新目录手输。主页每个目录行右侧有「+」，点击直接在该目录下新建；外层「+」按钮与目录行「+」右键均可预选 provider 进对话框。

续接 `发送`、🖥 终端、📋 复制命令三个按钮仍支持右键选 provider（经 `claude --settings` 注入，机制同上；左键不选 = 走 claude 自身配置）。
```

- [ ] **Step 2: 更新 README 功能列表（`:7` 第 1 条）**

`README.md` 第 7 条「Claude session 查看…」中「**目录内新建会话**」括注补充 web 选目录方式，改为：

```markdown
**目录内新建会话**（桌面端原生选目录框 / web 从已用目录列表选或手输路径，对话框内可选 provider，单发首条指令或交互式终端，建完直接跳转；目录行右侧「+」可直接在该目录新建）
```

- [ ] **Step 3: 更新 design.md §4.11**

`docs/design.md` §4.11「目录内新建会话」第一条子项，把「web 回退输入绝对路径」改为反映 web 已用目录列表 + 对话框内 provider 下拉；并在「右键选 provider 启动」子项注明新建会话改为对话框内下拉（外层「+」右键预选），续接/终端/复制三按钮仍右键。具体：将该节首行子弹点改为：

```markdown
  - 选工作目录（桌面端 `pickDirectory` 原生文件夹框，web 端从 `/api/projects` 已用目录列表点选或手输）+ 模式（单发首条指令 / 交互式终端）+ **provider 下拉**（默认=不注入走 claude settings.json，或任一 provider 经 `--settings` 注入）。
```

并在该节「右键选 provider 启动」子弹点把「`+ 新会话`（右键预置 provider 进对话框）」改为：

```markdown
  - `+ 新会话`：对话框内 provider 下拉选；外层「+」与目录行「+」右键 = 预选 provider 进对话框（`NewSessionDialog` 加 `defaultDir`/`defaultProviderId` prop，`watch(show)` 重置）。
```

- [ ] **Step 4: 检查文档无残留矛盾**

通读改动后的 README 第 7、16 行与 design.md §4.11，确认不再出现「web 回退输入绝对路径」（已改为列表选择）、不再把新建会话列为「仅右键选 provider」。

- [ ] **Step 5: Commit**

```bash
git add README.md docs/design.md
git commit -m "docs: 同步新建会话 provider 下拉与 web 选目录"
```

---

## 完成判据

- web 端「选择目录…」弹出已用目录列表（不再无反应）；桌面端原生框不变。
- 新建会话对话框内 provider 下拉可见可选，默认=不注入。
- 主页目录行右侧「+」预填该目录开建；DirPage「+」预填当前目录。
- 外层「+」右键选 provider 能预选进对话框（修复丢 pid）。
- `cd web && npm run typecheck` 通过；README/design.md 已同步。
