import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '../config.js';

// 终端工作区的布局数据模型。后端只负责存取 + 容错校验；树变更纯函数在前端（web/src/lib/workspace/tree.ts）。

/** 一个终端标签的描述（持久化用；活终端状态在 registry，不在此）。 */
export interface TabDescriptor {
  /** 稳定 uuid（≠ sessionId），跨重载复用，作 registry key。 */
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

const filePath = (): string => join(configDir(), 'workspace.json');

export const DEFAULT_WORKSPACE: WorkspaceState = { version: 1, root: null };

/** 把 sizes 规整为长度 n、和≈100 的数组。长度不符或含非正值 → 均分（最安全）。 */
export function normalizeSizes(sizes: number[] | undefined, n: number): number[] {
  if (n <= 0) return [];
  const even = (): number[] => Array.from({ length: n }, () => 100 / n);
  if (!Array.isArray(sizes)) return even();
  const parsed = sizes.slice(0, n).map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  if (parsed.length !== n || parsed.some((x) => x === 0)) return even();
  const sum = parsed.reduce((a, b) => a + b, 0);
  return parsed.map((x) => (x / sum) * 100);
}

function isStr(x: unknown): x is string {
  return typeof x === 'string';
}

function validateTab(raw: unknown): TabDescriptor | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.id) || (r.kind !== 'resume' && r.kind !== 'new')) return null;
  const tab: TabDescriptor = { id: r.id, kind: r.kind };
  if (isStr(r.dirName)) tab.dirName = r.dirName;
  if (isStr(r.sessionId)) tab.sessionId = r.sessionId;
  if (isStr(r.cwd)) tab.cwd = r.cwd;
  if (isStr(r.providerId)) tab.providerId = r.providerId;
  if (isStr(r.title)) tab.title = r.title;
  // resume 至少要有 sessionId；new 至少要有 cwd。缺则丢弃。
  if (tab.kind === 'resume' && !tab.sessionId) return null;
  if (tab.kind === 'new' && !tab.cwd) return null;
  return tab;
}

function validateGroup(raw: unknown): TabGroupNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'group') return null;
  const strip: 'top' | 'left' = r.strip === 'left' ? 'left' : 'top';
  const tabs = Array.isArray(r.tabs) ? r.tabs.map(validateTab).filter((t): t is TabDescriptor => t !== null) : [];
  if (tabs.length === 0) return null; // 空组无效
  const activeRaw = isStr(r.activeTabId) ? r.activeTabId : '';
  const activeTabId = tabs.some((t) => t.id === activeRaw) ? activeRaw : tabs[0].id;
  const group: TabGroupNode = { type: 'group', id: isStr(r.id) ? r.id : crypto.randomUUID(), strip, tabs, activeTabId };
  if (typeof r.stripSize === 'number' && Number.isFinite(r.stripSize)) group.stripSize = r.stripSize;
  return group;
}

function validateSplit(raw: unknown): SplitNode | LayoutNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'split') return null;
  const orientation: 'horizontal' | 'vertical' = r.orientation === 'vertical' ? 'vertical' : 'horizontal';
  const childrenRaw = Array.isArray(r.children) ? r.children : [];
  const children = childrenRaw.map(validateNode).filter((c): c is LayoutNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]; // 单孩子 split 塌缩为孩子
  return { type: 'split', id: isStr(r.id) ? r.id : crypto.randomUUID(), orientation, sizes: normalizeSizes(r.sizes as number[] | undefined, children.length), children };
}

function validateNode(raw: unknown): LayoutNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = (raw as Record<string, unknown>).type;
  if (type === 'group') return validateGroup(raw);
  if (type === 'split') return validateSplit(raw);
  return null;
}

/**
 * 容错校验：把任意解析结果规整为合法 WorkspaceState。
 * 损坏 / 引用缺失 → 丢弃无效子树，不抛异常。
 */
export function validateWorkspaceState(raw: unknown): WorkspaceState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WORKSPACE };
  const r = raw as Record<string, unknown>;
  const root = r.root == null ? null : validateNode(r.root);
  const state: WorkspaceState = { version: 1, root };
  if (isStr(r.activeTabId)) state.activeTabId = r.activeTabId;
  return state;
}

/** 终端工作区布局存储：~/.claude-webui/workspace.json。 */
class WorkspaceStore {
  async load(): Promise<WorkspaceState> {
    try {
      const raw = JSON.parse(await readFile(filePath(), 'utf8'));
      return validateWorkspaceState(raw);
    } catch {
      return { ...DEFAULT_WORKSPACE };
    }
  }

  async save(state: unknown): Promise<WorkspaceState> {
    const clean = validateWorkspaceState(state);
    await mkdir(configDir(), { recursive: true });
    await writeFile(filePath(), JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }
}

export const workspaceStore = new WorkspaceStore();
