import { readSSE, type SSEEvent } from './lib/sse';
import type { TabDescriptor, TabGroupNode, SplitNode, LayoutNode, WorkspaceState } from './lib/workspace/types';
export type { TabDescriptor, TabGroupNode, SplitNode, LayoutNode, WorkspaceState };

export interface ProjectEntry {
  dirName: string;
  cwd: string;
  sessionCount: number;
  latestMtimeMs: number;
}

export interface SessionEntry {
  sessionId: string;
  dirName: string;
  mtimeMs: number;
  size: number;
  preview: string;
  /** 最新 AI 标题（jsonl 最后一条 type:"ai-title"）；无则空串。 */
  title?: string;
}

export interface SessionMessage {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown };
  toolUseResult?: unknown;
  isSidechain?: boolean;
  raw?: unknown;
}

export interface PublicProvider {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  hasAuth: boolean;
  isEnv?: boolean;
  type?: 'anthropic' | 'openai';
}

export interface BoundSession {
  dirName: string;
  sessionId: string;
}

export interface PublicFeishuApp {
  id: string;
  name?: string;
  appId: string;
  allowedUserIds: string[];
  domain: 'feishu' | 'lark';
  enableNotify: boolean;
  chatIdForNotify?: string;
  hasSecret: boolean;
  timeoutMs?: number | null;
  boundSession?: BoundSession | null;
  providerId?: string;
}

export interface FeishuAppInput {
  id: string;
  name?: string;
  appId?: string;
  appSecret?: string;
  allowedUserIds?: string[];
  domain?: 'feishu' | 'lark';
  enableNotify?: boolean;
  chatIdForNotify?: string;
  timeoutMs?: number | null;
  boundSession?: BoundSession | null;
  providerId?: string;
}

export interface FeishuAppStatus {
  id: string;
  name?: string;
  appId: string;
  botName?: string;
  state: 'online' | 'offline';
}

export interface GatewayLog {
  id: string;
  createdAt: number;
  providerId: string;
  model: string;
  stream: boolean;
  request: Record<string, unknown>;
  response?: { content?: unknown[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
  elapsedMs: number;
  status: 'ok' | 'error';
  error?: string;
  test?: boolean;
}

export interface ConfigResponse {
  providers: PublicProvider[];
  activeProviderId: string;
  feishu: PublicFeishuApp[];
  hasGatewayKey: boolean;
}

export interface RunningSessionInfo {
  sessionId: string;
  cwd: string;
  status: string;
  name?: string;
  updatedAt?: number;
}

export interface ConversationSummary {
  id: string;
  kind: 'chat' | 'study';
  title: string;
  updatedAt: number;
}

export interface ConvMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface Conversation {
  id: string;
  kind: 'chat' | 'study';
  title: string;
  systemPrompt?: string;
  model?: string;
  providerId?: string;
  cwd?: string;
  studySessionId?: string;
  messages: ConvMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ProviderInput {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  authToken?: string;
  apiKey?: string;
  type?: 'anthropic' | 'openai';
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function saveConfig(providers: ProviderInput[], activeProviderId: string): Promise<ConfigResponse> {
  const r = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providers, activeProviderId }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as ConfigResponse;
}

export async function saveFeishuApps(apps: FeishuAppInput[]): Promise<PublicFeishuApp[]> {
  const r = await fetch('/api/feishu/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apps }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as PublicFeishuApp[];
}
export async function feishuStatus(): Promise<{ apps: FeishuAppStatus[] }> {
  return getJSON<{ apps: FeishuAppStatus[] }>('/api/feishu/status');
}
export async function feishuRestart(): Promise<{ apps: FeishuAppStatus[] }> {
  const r = await fetch('/api/feishu/restart', { method: 'POST' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export async function deleteGatewayLog(id: string): Promise<void> {
  const r = await fetch(`/api/gateway/logs/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
export async function saveGatewayKey(key: string): Promise<void> {
  const r = await fetch('/api/gateway/key', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gatewayKey: key }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
/** 复制命令（含 provider env 的 resume 命令，后端生成因前端无密钥）。 */
export async function copyCommand(dir: string, sid: string, providerId?: string): Promise<string> {
  const q = providerId ? `?provider=${encodeURIComponent(providerId)}` : '';
  const r = await fetch(`/api/projects/${dir}/sessions/${sid}/copy-command${q}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { command: string }).command;
}

/** 新建会话 SSE：POST /api/sessions/new，逐事件回调（created/stream-json/stderr/exit/error/done）。 */
export async function createSessionStream(
  cwd: string,
  prompt: string,
  onEvent: (ev: SSEEvent) => void,
  opts: { providerId?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const resp = await fetch('/api/sessions/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, prompt, providerId: opts.providerId }),
    signal: opts.signal,
  });
  if (!resp.ok || !resp.body) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  await readSSE(resp, onEvent);
}

export interface GatewayTestResult {
  ok: boolean;
  model?: string;
  content?: string;
  elapsedMs: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: string;
}
export async function gatewayTest(providerId?: string, prompt?: string): Promise<GatewayTestResult> {
  const r = await fetch('/api/gateway/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId, prompt }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export const api = {
  projects: () => getJSON<ProjectEntry[]>('/api/projects'),
  sessions: (dir: string) => getJSON<SessionEntry[]>(`/api/projects/${dir}/sessions`),
  messages: (dir: string, sid: string) => getJSON<SessionMessage[]>(`/api/projects/${dir}/sessions/${sid}/messages`),
  config: () => getJSON<ConfigResponse>('/api/config'),
  prompts: () => getJSON<Array<{ id: string; title: string; text: string }>>('/api/prompts'),
  running: () => getJSON<RunningSessionInfo[]>('/api/running'),
  conversations: () => getJSON<ConversationSummary[]>('/api/conversations'),
  conversation: (id: string) => getJSON<Conversation>(`/api/conversations/${id}`),
  gatewayLogs: (q?: string) => getJSON<GatewayLog[]>(`/api/gateway/logs${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  gatewayLog: (id: string) => getJSON<GatewayLog>(`/api/gateway/logs/${id}`),
};

export async function saveConversation(c: Partial<Conversation> & { id: string; kind: 'chat' | 'study'; title: string; messages: ConvMessage[] }): Promise<Conversation> {
  const r = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(c),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export async function deleteConversation(id: string): Promise<void> {
  const r = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

// —— 终端工作区 ——
/** 读取持久化的终端工作区布局。 */
export async function getWorkspace(): Promise<WorkspaceState> {
  return getJSON<WorkspaceState>('/api/workspace');
}
/** 保存终端工作区布局（后端会再校验一遍）。 */
export async function saveWorkspace(state: WorkspaceState): Promise<WorkspaceState> {
  const r = await fetch('/api/workspace', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
/** 单 session 的最新 AI 标题（轮询刷新标签名用）。 */
export async function sessionTitle(dir: string, sid: string): Promise<string> {
  const r = await fetch(`/api/projects/${dir}/sessions/${sid}/title`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { title: string }).title;
}