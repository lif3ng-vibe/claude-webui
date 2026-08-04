# 新建会话交互改进 — 设计

> 日期：2026-08-04
> 状态：已与用户确认设计，待实现
> 关联：`docs/design.md` §4.11（目录内新建会话 + 右键选 provider 启动）

## 1. 背景

claude-webui 的「新建会话」流程在 web 端有三处不顺：

1. **web 端选目录按钮无反应**：`NewSessionDialog` 的「选择目录…」按钮调 `pickDirectory()`，web 端它 `return null`（`web/src/lib/desktop.ts:96-99`），`NewSessionDialog.vue:28` 的 `if (p) cwd.value = p` 对 null 静默忽略 → 点了等于没点。桌面端有原生文件夹框，web 端没有任何回退。
2. **对话框内无法显式选 provider**：`NewSessionDialog` 内无可见 provider 选择器，只能右键「启动」按钮经隐藏的 `ProviderMenu` 选（`NewSessionDialog.vue:80`）；且外层「+」按钮的右键回调 `() => { showNew = true }`（`SessionsView.vue:479`、`DirPage.vue:114`）把选中的 providerId 直接丢弃——右键预置 provider 实际是坏的。
3. **主页目录行无逐目录新建入口**：「+新会话」只在左侧栏顶部 header（全局唯一），目录行右侧只有 ↗（`SessionsView.vue:523`）；想在某个目录下建会话得先打开对话框再选/输目录。

## 2. 目标

- web 端「选择目录…」按钮可用（从已用工作目录列表点选）。
- 新建会话对话框内可见、可选 provider（下拉）。
- 主页每个目录行右侧有「+」按钮，点击直接预填该目录开建。
- 顺带：修外层「+」右键丢 providerId 的 bug；DirPage「+」预填当前目录。

## 3. 硬约束

- `~/.claude` 只读不变；provider 经 `claude --settings` 注入机制不变（design.md §4.11）。
- 浏览器沙盒无法弹原生文件夹框拿任意绝对路径——web 端"选目录"只能从已有数据里选 + 手输兜底，这是硬限制。
- 后端 `/api/sessions/new`（`server/index.ts:279-336`）、终端 WS `/api/terminal/new`（`:679-685`）、`providerEnv`（`config.ts:138-146`）**均不改**；前端只是把下拉值当 providerId 传。

## 4. 设计

### 4.1 NewSessionDialog 改造（核心）

**加 prop 入口**（现在 cwd/providerId 是内部 ref 无入口，`NewSessionDialog.vue:13,18,23`）：

```ts
const props = defineProps<{
  show: boolean;
  defaultDir?: string;        // 预填工作目录
  defaultProviderId?: string; // 预选 provider（undefined=默认）
}>();
const cwd = ref('');
const providerId = ref<string | undefined>(undefined);
// 对话框实例复用（show true→false→true），用户又能在框内改 cwd/providerId：
// 每次 show 转 true 时，按当前 prop 重置可编辑态。
watch(() => props.show, (s) => {
  if (s) { cwd.value = props.defaultDir ?? ''; providerId.value = props.defaultProviderId; }
});
```

**provider 下拉（需求 2）**：加 `NSelect`，选项：
- 「默认（claude 配置）」→ providerId = undefined（不注入，走 `~/.claude/settings.json`，cc-switch 选中）
- 各 provider → providerId = id（从 `useConfig` 的 providers 数组拿，不含密钥）

语义不同于 ChatView 的"默认(env)"（=active/env 兜底）：此处"默认"=不注入 provider env。标签写「默认（claude 配置）」以区分。`providerId` 绑定下拉。

**web 选目录（需求 1）**：「选择目录…」按钮按运行时分流：
- 桌面端（`isDesktop`）：仍 `pickDirectory()` 原生文件夹框。
- web 端（`!isDesktop`）：弹出已用工作目录列表（NPopover/NSelect，数据来自 `/api/projects` 的 `cwd`），点选预填 cwd；全新目录仍走旁边手输框。

**去掉启动按钮的隐藏右键**：下拉已取代；移除对话框内 `useProviderMenu`/`ProviderMenu`（`NewSessionDialog.vue:24,85`）与启动按钮 `@contextmenu.prevent`（`:80`）。`runSingle`/`runTerminal` 仍读 `providerId.value`（现由下拉驱动）。

### 4.2 外层「+」按钮：修右键预选 + 预填目录

`SessionsView.vue:479`、`DirPage.vue:114` 的「+」按钮：

```ts
const pendingDir = ref<string | undefined>();
const pendingProviderId = ref<string | undefined>();
function openNew() { showNew.value = true; }
// 右键（保留，修复丢 pid）
@contextmenu.prevent="newMenu.open($event, (pid) => { pendingProviderId = pid; openNew(); })"
```

`<NewSessionDialog :show="showNew" :default-dir="pendingDir" :default-provider-id="pendingProviderId" @update:show=...>`

- SessionsView 顶部「+」左键：`pendingDir` 留空（用户在对话框选/输）；右键预选 provider。
- DirPage「+」左键：`pendingDir = 当前目录 cwd`（从 projectsQuery 反查，`DirPage.vue:50-54`），省去重选；右键 provider + dir。

### 4.3 目录行右侧「+」按钮（需求 3）

`SessionsView.vue` 目录行 ↗ 旁（`:523`）加：

```html
<button class="icon-btn-sm" title="在此目录新建会话（右键选 provider）"
  @click.stop="newInDir(node.p)"
  @contextmenu.prevent="newMenu.open($event, (pid) => newInDir(node.p, pid))">+</button>
```

`newInDir(p, pid?)`：`pendingDir = p.cwd; pendingProviderId = pid; showNew = true`。

### 4.4 状态管理

`pendingDir`/`pendingProviderId` 在 SessionsView、DirPage 各自 ref；开对话框前赋值，下次开对话框会重新赋值（无需显式清空）。

## 5. 数据流（后端不变 + 前端变化）

- 单发：下拉 providerId → `createSessionStream(cwd, prompt, cb, { providerId })` → `POST /api/sessions/new` body `{cwd,prompt,providerId}` → `handleNewSession`（`server/index.ts:306` `providerEnv` 注入）→ `runner.runNew`。
- 终端：下拉 providerId → `openWindow('/terminal/new?cwd=&provider=')` → WS `/api/terminal/new`（`:679`）→ `providerEnv` 注入。

## 6. 边界

- web 已用目录列表为空（首次使用 / `/api/projects` 无数据）→ 弹出空列表 + 提示"手输绝对路径"。
- 预填 `defaultDir` 用户仍可在对话框内改（下拉/手输）。
- 桌面端「选择目录…」仍走原生框，行为不变。
- `NewSessionDialog` 复用实例：`show` 从 false→true 时按 prop 重置 cwd/providerId（§4.1 watch）。

## 7. 不做（YAGNI）

- 不做 web 端"任意目录原生选择"（浏览器硬限制，不可能）。
- 不改后端 provider 注入逻辑。
- 不动续接「发送」、终端 🖥、复制 📋 这三个按钮的右键选 provider（它们本就正常，不在本次范围）。
- 不做目录行的多选/批量新建。

## 8. 测试

后端无改动，单测不动。前端：

- 手测：web 端「选择目录…」弹出已用目录列表、点选预填、手输新目录。
- 手测：对话框 provider 下拉切换 → 单发 / 终端两条路径 providerId 正确传入（看 `/api/sessions/new` body / WS query）。
- 手测：目录行「+」预填该目录；DirPage「+」预填当前目录。
- 手测：外层「+」右键选 provider → 对话框下拉预选该项。
- 桌面端回归：原生文件夹框仍可用。
- 类型检查：`cd web && npm run typecheck`。

## 9. 文档同步

- README：「右键选 provider 启动」段——新建会话改为对话框内下拉选（外层「+」按钮右键可预选）；新增 web 端选目录方式、目录行「+」按钮。
- design.md §4.11：同步上述变化。
