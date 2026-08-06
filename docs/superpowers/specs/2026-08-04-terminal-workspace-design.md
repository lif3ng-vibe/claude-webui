# 终端工作区（多标签 + 分屏 + 拖拽合并）设计

> 本文件是 `claude-webui`「交互式终端工作区」功能的正式设计稿。新会话读这里即可获取需求与实现路线。
> 对应需求来源：用户希望终端窗口可拖拽合并成多标签、标签栏可横/纵、标签组可分屏、可任意拖拽重组，且**不影响现有功能**。

## 0. 背景与约束

- 现状（§11）：`🖥` 按钮走 `openWindow('/terminal/:dir/:sid')`，**一个终端 = 一个 OS/浏览器窗口**；`TerminalPage.vue` 是纯 xterm + WebSocket，全项目无多标签/分屏概念。
- 会话标题数据：`~/.claude/projects/<dir>/<sid>.jsonl` 内有 `{type:"ai-title", aiTitle, sessionId}` 行（Claude Code 自己写，随会话演进会更新），**目前 UI 哪都没用**；现有 `SessionEntry.preview` = 首条人类 prompt（≠ ai-title）。
- 硬规则不变：`~/.claude` 只读；API key 只在后端；续接 per-sessionId 锁（`runningSessions`）禁止并发写同一 session。
- **不影响现有功能**：现有 `🖥`→独立 OS 窗口的 `TerminalPage` 行为完全保留；本功能是**新增**的「终端工作区」面。

## 1. 目标 / 需求

1. **拖拽合并成多标签**：把一个终端（标签/组）拖到另一个上，合并成同一标签组的多标签；标签名 = 该会话的 AI 标题。
2. **标签栏横/纵**：每个标签组的标签栏可在**顶部（横）**或**左侧（纵）**间切换；纵向时标签列**宽度可拖**（看更多标题文字）。
3. **分屏**：标签组之间可**左右并排**或**上下堆叠**，可拖调宽/高；多个标签组同时可见。
4. **任意重组**：标签/组可拖拽在组之间移动、拆分、再合并。
5. **混合窗口**（用户选定）：工作区在单个 OS 窗口内；任一标签/组可**弹出**成独立 OS 窗口，可**收回**。
6. **标签名**：jsonl 最新 `aiTitle`；新会话未生成时用 `preview` 兜底；运行中标签随 aiTitle 更新刷新。
7. **持久化**：工作区布局持久化，重开自动恢复、各自重连。

## 2. 非目标（YAGNI）

- 不改现有 `🖥` 独立窗口终端、不改单发续接（§4.2）、不改对话/网关/飞书。
- 不做 OS 窗口之间的原生拖拽合并（混合模型的"弹出/收回"用应用内子树序列化 + BroadcastChannel 实现，不依赖 OS 级窗口合并）。
- 不做工作区内的命令联动（每个终端仍是独立 claude 进程，互不影响）。

## 3. 架构总览

三层解耦：

```
布局层（Vue 响应式）                终端层（脱离 Vue 深响应式）            后端（几乎不动）
WorkspaceStore                      TerminalRegistry                       WS /api/terminal/*（每标签一条，复用现有锁）
 └ LayoutNode split 树（持久化）      └ 按 tabId 持有 xterm+WS+hostEl        GET/PUT /api/workspace（新）
   ├ SplitLayout（递归 splitpanes）     └ attach/detach：移动 hostEl 不销毁   GET .../sessions/:sid/title（新）
   └ TabGroup                                                              listSessions 增 title 字段
       ├ TabStrip（top 横 | left 纵可拖宽）
       └ TerminalSlot ← registry.attach
```

**核心不变量**：终端实例（xterm + WebSocket）的生命周期挂在 `TerminalRegistry` 上，与布局树**完全无关**。布局树只存 tab 引用；标签被拖拽只改树结构 + 移动 xterm 的 `hostEl` 到新容器，**xterm 实例与 WebSocket 永不重建**——历史滚动与实时连接不丢。这是整个设计成立的地基，也是实现首步必须验证的风险点（§12）。

## 4. 数据模型

### 4.1 布局树（持久化到 `~/.claude-webui/workspace.json`）

```ts
interface WorkspaceState { version: 1; root: LayoutNode | null; activeTabId?: string }

type LayoutNode = SplitNode | TabGroupNode

/** 内节点：分屏容器。 */
interface SplitNode {
  type: 'split';
  orientation: 'horizontal' | 'vertical'; // horizontal=子节点左右并排；vertical=上下堆叠（对齐 splitpanes 语义）
  sizes: number[];                         // 各子节点相对宽/高（0–100，和≈100）
  children: LayoutNode[];
}

/** 叶节点：标签组，同一时间只显示一个终端。 */
interface TabGroupNode {
  type: 'group';
  strip: 'top' | 'left';   // 标签栏：top=顶部一排（固定高）；left=左侧一列（宽度可拖）
  stripWidth?: number;      // strip='left' 时标签列像素宽（默认 160，范围 80–480）
  tabs: TabDescriptor[];
  activeTabId: string;
}

interface TabDescriptor {
  id: string;               // 稳定 uuid（≠ sessionId），跨重载复用，作 registry key
  kind: 'resume' | 'new';
  dirName?: string;         // kind='resume'：~/.claude/projects 下的编码目录名
  sessionId?: string;       // kind='resume'
  cwd?: string;             // kind='new'：工作目录
  providerId?: string;      // 可选 provider（右键选 provider 启动；经 --settings 注入，机制同 §4.11）
  title?: string;           // 最近已知 aiTitle/preview（断连占位，非权威；权威来自 registry 轮询）
}
```

**命名澄清**：`SplitNode.orientation` 的 horizontal/vertical 指**分屏方向**（并排/堆叠）；`TabGroupNode.strip` 的 top/left 指**标签栏位置**。两者语义不同，勿混。

**tabId ≠ sessionId**：一个 session 同一时刻只能有一个活终端（per-sessionId 锁），故一个 session 在工作区内只占一个 tab。tabId 是 UI 槽位 uuid，持久化以便重载后 registry 用同一 key 重连。

### 4.2 new 标签的 sid 回填

`/terminal/new` 起的是 fresh claude（不带 `--resume`），启动时无 sid。一旦它在 `~/.claude/projects/<encodeCwd(cwd)>/` 下写出新 jsonl（轮询发现「创建时间晚于该 tab 创建时刻」的最新 `.jsonl`），即把该 tab 升级为 `kind:'resume'` 并回填 `dirName/sessionId`。这样重载后能正确 resume，而不是再起第二个 session。（与 §4.11「新 session 靠轮询自然出现」同思路。）

## 5. TerminalRegistry（解耦层）

单例模块（非 Pinia；重的 xterm/WS 对象用 `markRaw`，只对 `status`/`title` 两个 `ref` 响应式）：

```ts
interface TerminalEntry {
  tabId: string;
  term: Terminal;            // @xterm/xterm，markRaw
  fit: FitAddon;             // markRaw
  ws: WebSocket;             // markRaw
  hostEl: HTMLDivElement;    // xterm 只 open 进这一个 div，终身不换
  status: Ref<TerminalStatus>; // 'connecting'|'live'|'exited'|'locked'|'error'
  title: Ref<string>;          // 当前显示标题
}

interface TabDescriptor { /* §4.1 */ }

class TerminalRegistry {
  acquire(desc: TabDescriptor): TerminalEntry;   // 已有同 tabId 则复用；否则建 xterm+WS+hostEl
  attach(tabId: string, container: HTMLElement): void; // container.appendChild(hostEl) → fit() → 发 resize
  release(tabId: string): void;                  // ws.close()（后端闭 WS 释放锁）→ term.dispose() → 移除 hostEl
  releaseAll(): void;
  get(tabId: string): TerminalEntry | undefined;
}
```

- **attach/detach = 移动 hostEl**：标签切到可见槽位时 `TerminalSlot` 的容器 `appendChild(hostEl)`；切走时被下一个标签的 hostEl 挤出。DOM 节点带子树搬家，xterm 画面保留，搬家后 `fit()` 重算列行并 `ws.send(resize)`。
- **WS 与锁**：复用现有 `/api/terminal/:dir/:sid` 与 `/api/terminal/new?cwd=&provider=`。闭 WS → 后端 `TerminalManager` kill PTY + 释放锁（现有逻辑，§11）。关 tab = `release` = 释放锁，天然与单发续接/独立窗口/飞书互斥。
- **Ctrl+C/Ctrl+V** 等按键处理沿用 `TerminalPage` 现有 `attachCustomKeyEventHandler` 逻辑（提取为 registry 内部共享）。

## 6. 前端组件树

```
views/WorkspaceView.vue          // 路由 /workspace；载入 workspace.json；防抖自动存；空态="添加终端"
└ components/workspace/
    SplitLayout.vue              // 递归：node.type==='split' → <Splitpanes :horizontal="orientation==='horizontal'" :sizes> 递归 children；否则 <TabGroup :node>
    TabGroup.vue                 // 叶：strip 区 + 当前 tab 的 <TerminalSlot>
    TabStrip.vue                 // top=固定高横栏（flex row）；left=左侧列（用内嵌 2 格 Splitpanes=[标签列(stripWidth) | 终端槽] 实现可拖宽）
    TabChip.vue                  // draggable；标题（truncate）+ 状态点 + 关闭钮
    TerminalSlot.vue             // 一个 ref 容器；onMounted/watch(activeTabId) → registry.attach(activeTabId, el)；onUnmounted 视情况 detach
stores/workspace.ts              // Pinia：root 树 + 树变更 action（调纯函数）+ 持久化
lib/workspace/tree.ts            // 纯函数：树变更（§7）——单测主战场
lib/workspace/registry.ts        // TerminalRegistry
composables/useTabTitle.ts       // 可见 tab 标题轮询
```

- **分屏调宽/高**：外层 split 树用 `splitpanes`（嵌套递归 + 自带 resizer）；纵向标签列宽也用内嵌 2 格 splitpanes，`stripWidth` 即其 size。**零自写 resizer**。
- **新建依赖**：`splitpanes`（Vue 3 原生、无额外依赖）。加入 `web/package.json`。

## 7. 树变更纯函数（`lib/workspace/tree.ts`，DnD 的核心，重点单测）

所有 DnD 操作最终调用这里的纯函数修改树；DnD 事件只负责「算落点 → 调对应函数」。函数返回新树（不可变更新），便于响应式与测试。

| 函数 | 语义 |
|---|---|
| `addTab(root, tab, groupId?)` | 新建标签：默认放进新单标签组（root 空时建 root），或指定组追加 |
| `moveTab(root, tabId, toGroupId, index?)` | 组内重排 / 跨组移动；源组空则 `collapseSplit` |
| `removeTab(root, tabId)` | 关标签；组空则塌缩；全空则 root=null |
| `splitGroup(root, groupId, tabId, edge)` | 边缘分屏：把目标组包成新 SplitNode（edge=left/right→horizontal，top/bottom→vertical），拖来 tab 作新兄弟单标签组，sizes 50/50 |
| `mergeGroupsInto(root, srcGroupId, dstGroupId)` | 整组拖到另一组：源组所有 tab 按 active 顺序并入目标组，删源组（需求 1「合并成多标签」） |
| `setStrip(root, groupId, strip)` / `setStripWidth` | 切标签栏横/纵、设列宽 |
| `setActiveTab(root, groupId, tabId)` | 切活动标签 |
| `collapseSplit(root)` | 删掉只有 1 个孩子的 split（提升孩子）；规整 sizes |
| `normalizeSizes(node)` | sizes 归一化和≈100 |
| `popOutSubtree(root, nodeId)` / `insertSubtree(root, subtree, target?)` | 弹出/收回（混合模型） |
| `findGroupOfTab(root, tabId)` / `findNode(root, id)` | 查询辅助 |

落点判定（命中区）：拖拽中在目标终端区上覆盖**半透明分区**——中心=并入该组标签；上/下/左/右半=沿该方向 split 出新组。算命中用拖动光标相对容器中心的象限 + 距边阈值。

## 8. DnD 交互细节

- 拖拽源：`TabChip`（拖单个标签）、标签组标题区/手柄（拖整组）。
- `dataTransfer` MIME：`application/x-cwebui-tab`（载荷 `{tabId, fromGroupId}`）、`application/x-cwebui-group`（载荷 `{groupId}`）。
- 落点：`dragover` 计算命中区并渲染覆盖层（4 半区 + 中心），`drop` 调对应纯函数。
- 跨窗口：HTML5 DnD 仅限同窗口；弹出/收回走 §10。
- **DnD 事件本身 jsdom 难测**，故把"算命中区→选函数"做成纯函数 `resolveDrop(target, point) → DropPlan`，单测覆盖；事件层薄。

## 9. 持久化与重连

- **存储**：`~/.claude-webui/workspace.json`，经**后端** `GET/PUT /api/workspace` 读写（web/桌面统一；不走桌面 shell，与 `window-state.json` 区分）。
- **自动存**：树变更后防抖 500ms `PUT`。
- **重载恢复**：`GET` → 建树 → 每 tab `registry.acquire` + 连 WS（resume 直连 `/api/terminal/:dir/:sid`；new 若已回填 sid 则 resume，否则 `/api/terminal/new?cwd=`）。
- **容错**：state 损坏 / 引用了不存在的 session → 丢弃无效 tab 不崩；`version` 字段留迁移口；校验失败回退空工作区。

## 10. 弹出 / 收回（混合模型，最高复杂度，可后置打磨）

- **弹出**：把某标签/组的子树序列化为 token（或临时存后端换 id），`openWindow('/workspace?pop=<token>')`；新 OS 窗口加载工作区、只渲染该子树；主工作区从树中移除该子树并存盘。
- **收回**：弹出窗「收回」钮（或关闭时）→ BroadcastChannel 推送子树 → 主工作区 `insertSubtree` 插回（默认作为新标签组追加到末尾）并存盘。
- **状态**：弹出窗的活终端 WS 随该窗存活；收回时若主区已无同 session 占用则原样接回（hostEl 随子树 DOM 迁移）。
- v1 可先实现「弹出成独立单标签窗 + 收回」；多级子树弹出/精细插回位置作为打磨项。

## 11. 标题（aiTitle）

- 后端 `readLatestTitle(dirName, sid)`：扫 jsonl 取**最后一条** `type:'ai-title'` 的 `aiTitle`；按 `{文件 mtime → title}` 缓存（文件未变零开销）。
- `listSessions` 在现有 `preview` 基础上**增加 `title` 字段**（最新 aiTitle），供「加终端」选择器显示。
- 新端点 `GET /api/projects/:dir/sessions/:sid/title` → `{title}`，供单 tab 轻量轮询。
- 前端 `useTabTitle(tabId)`：可见 tab 每 ~5s 轮询，更新 registry 的 `title` ref → `TabChip` 实时刷新。
- 兜底链：aiTitle → `preview` → sid 前 8 位。new 标签 sid 回填前显示「新会话 · `<cwd basename>`」。

## 12. 错误处理 / 状态

- **锁冲突（WS close 4001）**：tab `status='locked'`，标「被别处占用」，**不自动重连**（会再冲突），给手动「重试 / 关闭」。
- **claude 退出（`{type:'exit',code}`）**：`status='exited'`，保留末屏，状态条显退出码 +「重连」钮。
- **连接错误 / 启动失败（4000/4002）**：`status='error'`，显原因。
- **空工作区**：引导「添加终端」（选 session / 新建；复用 `NewSessionDialog` 与 provider 右键逻辑）。
- **attach 失败**：try/catch；hostEl 缺失则重建 entry。
- **xterm 搬家保真**：若实测 appendChild 搬家导致画面/输入异常，退路是 detach 时存屏缓冲、reattach 重画（代价：丢滚动历史）——优先证伪此风险（构建顺序第 2 步）。

## 13. 入口与"不影响现有功能"

- 新增「终端工作区」入口（左栏 header + 顶栏）→ 路由 `/workspace`（`ItemLayout` shell 之外，独立全屏页）。
- **现有 `🖥` 完全不动**：仍开独立 `TerminalPage` OS 窗口。工作区自带「加终端」。
- 工作区与独立窗口/单发续接/飞书经 per-sessionId 锁天然互斥。

## 14. 后端改动清单

| 改动 | 文件 | 说明 |
|---|---|---|
| 新 | `src/workspace/store.ts` | `~/.claude-webui/workspace.json` 读写（get/save；容错） |
| 改 | `src/claude/FileReader.ts` | `readLatestTitle(dirName, sid)`（带 mtime 缓存）；`listSessions` 增 `title` |
| 改 | `src/server/index.ts` | `GET/PUT /api/workspace`；`GET /api/projects/:dir/sessions/:sid/title` |

无新 WS 协议；终端复用现有 `/api/terminal/*`。

## 15. 测试（vitest，TDD）

- **树纯函数**（最高价值，先写）：`addTab/moveTab/removeTab/splitGroup/mergeGroupsInto/collapseSplit/setStrip/normalizeSizes/popOut/insert/find*` 全覆盖；含空树、单组、嵌套 split、sizes 归一、源组塌缩等边界。
- **落点判定**：`resolveDrop` 各象限 + 中心 + 阈值。
- **标题提取**：`readLatestTitle` 多 ai-title 取最后、无则空、解析容错、mtime 缓存命中。
- **持久化**：`workspace/store` 序列化往返、损坏降级、version 兼容。
- **后端端点**：`/api/workspace` GET/PUT、`/title`（mock fs）。
- **前端**：`TabGroup`/`TabStrip` 渲染（top/left）、`TerminalSlot` attach 调用（spy registry）、`useTabTitle` 轮询（mock fetch）。
- **手工 QA 清单**：xterm 搬家保真、各 DnD 操作、三端（web/Electron/Tauri）跑通、与独立窗口锁互斥。

## 16. 构建顺序

1. **后端**：`readLatestTitle` + 缓存、`listSessions` 带 `title`、`/api/workspace` GET/PUT、`/title` 端点（+ 单测）。
2. **TerminalRegistry + TerminalSlot**：先证明「一个终端在两个槽位间搬家不丢画面/连接」（风险点验证，最小 demo）。
3. **WorkspaceStore + 树纯函数 + 单测** + splitpanes 静态渲染 + 持久化往返。
4. **TabGroup**：标签栏 top/left + 可拖宽 + 加/关/切换。
5. **DnD**：组内重排 / 跨组移动 / 整组合并（需求 1）。
6. **DnD**：边缘分屏 + 调宽（需求 2/3）。
7. **标题轮询**刷新。
8. **弹出 / 收回**（混合模型）。
9. 空态 / 错误态 / 三端 QA + 同步 README、design.md（§11 增「终端工作区」子节）。

## 17. 风险

- **xterm DOM 搬家保真**：最高风险，构建第 2 步先证伪；退路见 §12。
- **DnD 落点 UX**：边缘分屏的命中区手感需调参，靠纯函数 + 手工 QA。
- **new 标签 sid 回填时序**：轮询发现新 jsonl 的判定（创建时间晚于 tab 创建）需稳健，避免错认成别的 session。
- **splitpanes 与递归树集成**：sizes 双向同步（splitpanes `@resized` → store → 持久化）需小心循环。
- **跨窗口弹出/收回**：BroadcastChannel 同步 + 子树序列化 + 活终端归属切换，复杂；v1 可裁剪范围。

## 18. 开放问题（实现中决断，默认值如下）

- 弹出窗是否独立持久化：默认**不**（弹出窗关闭即收回或丢弃；主工作区是唯一权威 `workspace.json`）。
- 工作区是否多实例（多个 OS 窗口各开工作区）：默认**单**工作区（主窗口）；后续按需。
- 标签关闭二次确认：默认**直接关**（关=断 WS=释放锁，无破坏性；terminal 仍在，可再 resume）。

## 19. 实现修正记录（与初稿的偏差 + 踩坑）

实现中偏离了初稿若干处，记录于此以免文档与代码不符：

- **拖拽改用 pointer 事件，不用 HTML5 DnD**（`web/src/lib/workspace/pointerDnd.ts` + `TabGroup.vue`）。原因：Tauri（Windows WebView2）下 HTML5 DnD 的 `dragover`/`drop` 不可靠，即便 Rust 端 `WebviewWindowBuilder::drag_and_drop(false)`（注意 Tauri 2.11 的方法名是 `drag_and_drop`，不是 `drag_drop_enabled`）也未能让其在 Tauri 窗口稳定触发。pointer 事件（pointerdown→阈值进入拖拽→pointermove 用 `elementFromPoint` + `data-ws-tab`/`data-ws-area` 命中→pointerup 落定）在浏览器与 Tauri 行为一致。落点判定纯函数（`resolveZone`）复用；`chipDropIndex`/`readPayload`/HTML5 MIME 载荷已废弃（保留导出供旧测试）。点击 vs 拖拽用移动阈值（4px）区分：未过阈值松开 = 切活动标签。
- **深拷贝用 JSON，不用 `structuredClone`**（`tree.ts` 的 `clone`）。原因：`structuredClone` 对 Vue 响应式 Proxy 抛 `DataCloneError`；布局树是纯可序列化数据，`JSON.parse(JSON.stringify())` 等效且安全（`saveWorkspace` 亦如此序列化响应式 state）。
- **`markRaw(undefined)` 会抛错**（`registry.ts`）：markRaw 内部 `Object.defineProperty` 不能作用于 undefined/null。修法：entry 初始 `ws` 不 markRaw（`undefined as unknown as WebSocket`），在 `connect()` 里对真实 WebSocket 再 `markRaw(ws)`。
- **`BroadcastChannel.postMessage` 同样走 structured clone**（`popout.ts` 的 `broadcastDock`）：广播收回子树前必须 `JSON.parse(JSON.stringify(subtree))` 转纯对象，否则响应式 Proxy 抛 DataCloneError。
- **弹出窗关闭要走桌面 bridge**：JS `window.close()` 关不掉 Tauri OS 窗口；用 `closeWindow()`（`desktop.ts` → `desktop.close()`）。并加 `dockSent` 守卫，避免「收回按钮 + beforeunload」双触发导致重复标签。
- **splitpanes 方向语义**（易错）：`.splitpanes--horizontal{flex-direction:column}`=上下堆叠、`.splitpanes--vertical`（默认，不加 `horizontal` prop）=左右并排。故 `SplitLayout` 用 `:horizontal="node.orientation === 'vertical'"`（语义反向映射）；**左侧标签栏**组内的 `[标签列 | 终端]` 用**默认**（不加 `horizontal`）→ 左右并排，分隔条拖动即改标签列宽（`stripSize` = 占组宽百分比，钳制 10–50）。
- **分屏方向翻转**入口放在工作区**顶栏**「排列」按钮（全局，翻转根分屏），不放每个组里（避免重复）。

