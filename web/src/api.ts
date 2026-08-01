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
}

export interface FeishuAppStatus {
  id: string;
  name?: string;
  appId: string;
  state: 'online' | 'offline';
}

export interface ConfigResponse {
  providers: PublicProvider[];
  activeProviderId: string;
  feishu: PublicFeishuApp[];
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

export const api = {
  projects: () => getJSON<ProjectEntry[]>('/api/projects'),
  sessions: (dir: string) => getJSON<SessionEntry[]>(`/api/projects/${dir}/sessions`),
  messages: (dir: string, sid: string) => getJSON<SessionMessage[]>(`/api/projects/${dir}/sessions/${sid}/messages`),
  config: () => getJSON<ConfigResponse>('/api/config'),
  prompts: () => getJSON<Array<{ id: string; title: string; text: string }>>('/api/prompts'),
  running: () => getJSON<RunningSessionInfo[]>('/api/running'),
  conversations: () => getJSON<ConversationSummary[]>('/api/conversations'),
  conversation: (id: string) => getJSON<Conversation>(`/api/conversations/${id}`),
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