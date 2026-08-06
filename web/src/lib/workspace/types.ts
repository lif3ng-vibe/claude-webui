// 终端工作区布局类型（纯类型，无运行时依赖）。
// 后端 src/workspace/store.ts 有等价定义；前端 tree.ts 的纯函数测试经此导入，
// 避免拉入 api.ts 的 fetch/sse 依赖。

/** 一个终端标签的描述（持久化用；活终端状态在 registry，不在此）。 */
export interface TabDescriptor {
  /** 稳定 uuid（≠ sessionId），作 registry key。 */
  id: string;
  kind: 'resume' | 'new';
  /** kind='resume'：~/.claude/projects 下的编码目录名。 */
  dirName?: string;
  /** kind='resume'。 */
  sessionId?: string;
  /** kind='new'：工作目录。 */
  cwd?: string;
  /** 可选 provider（经 --settings 注入）。 */
  providerId?: string;
  /** 最近已知标题（断连占位，非权威）。 */
  title?: string;
}

/** 叶节点：标签组，同一时间只显示一个终端。 */
export interface TabGroupNode {
  type: 'group';
  /** 稳定 id：DnD 寻址 + Vue :key + 弹出/收回引用。 */
  id: string;
  /** 标签栏：top=顶部一排（固定高）；left=左侧一列（宽度可拖）。 */
  strip: 'top' | 'left';
  /** strip='left' 时标签列占该组宽度的百分比（默认 ~22，范围 10–50）。 */
  stripSize?: number;
  tabs: TabDescriptor[];
  activeTabId: string;
}

/** 内节点：分屏容器。 */
export interface SplitNode {
  type: 'split';
  /** 稳定 id：Vue :key + splitpanes @resized 定位 + 弹出/收回引用。 */
  id: string;
  /** horizontal=子节点左右并排；vertical=上下堆叠（对齐 splitpanes 语义）。 */
  orientation: 'horizontal' | 'vertical';
  /** 各子节点相对宽/高（0–100，和≈100）。 */
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = SplitNode | TabGroupNode;

export interface WorkspaceState {
  version: 1;
  root: LayoutNode | null;
  activeTabId?: string;
}
