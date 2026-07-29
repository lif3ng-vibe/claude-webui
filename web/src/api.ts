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

export interface ConfigResponse {
  providers: PublicProvider[];
  activeProviderId: string;
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

export const api = {
  projects: () => getJSON<ProjectEntry[]>('/api/projects'),
  sessions: (dir: string) => getJSON<SessionEntry[]>(`/api/projects/${dir}/sessions`),
  messages: (dir: string, sid: string) => getJSON<SessionMessage[]>(`/api/projects/${dir}/sessions/${sid}/messages`),
  config: () => getJSON<ConfigResponse>('/api/config'),
  prompts: () => getJSON<Array<{ id: string; title: string; text: string }>>('/api/prompts'),
};