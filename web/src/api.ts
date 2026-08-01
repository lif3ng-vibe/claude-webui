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

export interface PublicFeishuConfig {
  appId: string;
  allowedUserIds: string[];
  domain: 'feishu' | 'lark';
  enableNotify: boolean;
  chatIdForNotify?: string;
  hasSecret: boolean;
  timeoutMs?: number | null;
}

export interface FeishuInput {
  appId?: string;
  appSecret?: string;
  allowedUserIds?: string[];
  domain?: 'feishu' | 'lark';
  enableNotify?: boolean;
  chatIdForNotify?: string;
  timeoutMs?: number | null;
}

export interface ConfigResponse {
  providers: PublicProvider[];
  activeProviderId: string;
  feishu?: PublicFeishuConfig | null;
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

export async function saveFeishu(feishu: FeishuInput): Promise<PublicFeishuConfig | null> {
  const r = await fetch('/api/feishu/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(feishu),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as PublicFeishuConfig | null;
}
export async function feishuStatus(): Promise<{ state: 'online' | 'offline' | 'unconfigured' }> {
  return getJSON<{ state: 'online' | 'offline' | 'unconfigured' }>('/api/feishu/status');
}
export async function feishuRestart(): Promise<{ state: string }> {
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