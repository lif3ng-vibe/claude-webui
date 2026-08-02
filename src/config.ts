import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

/** 应用数据目录。可用 CLAUDE_WEBUI_DIR 覆盖（测试用）。 */
export function configDir(): string {
  return process.env.CLAUDE_WEBUI_DIR || join(os.homedir(), '.claude-webui');
}

const configPath = (): string => join(configDir(), 'config.json');

/** 一个 provider 配置（含密钥，后端用）。 */
export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  authToken?: string;
  apiKey?: string;
  model: string;
  /** provider 协议类型；默认 anthropic。openai = OpenAI 兼容（/v1/chat/completions）。 */
  type?: 'anthropic' | 'openai';
}

export interface AppConfig {
  providers?: ProviderConfig[];
  activeProviderId?: string;
  maxTokens?: number;
  /** 飞书机器人配置（结构见 src/feishu/feishuConfig.ts）。 */
  feishu?: Record<string, unknown>;
  /** 中转网关可选 key（留空=本地不校验）。 */
  gatewayKey?: string;
  // 旧字段（兼容/兜底）
  anthropicApiKey?: string;
  anthropicAuthToken?: string;
  anthropicBaseURL?: string;
  model?: string;
}

/** 读取配置文件（不含 env 兜底，env 在解析时单独处理）。 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

/** 去掉 Claude Code 的 [1m] 之类上下文窗口后缀——代理不认。 */
export function stripModelSuffix(m: string): string {
  return m.replace(/\[.*\]$/, '');
}

/** 由环境变量构成的内置 provider（不写入文件，只读、不可删）。 */
function envProvider(): ProviderConfig | null {
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!baseURL && !authToken && !apiKey && !model) return null;
  return { id: 'env', name: '默认 (env)', baseURL: baseURL || '', authToken, apiKey, model: model || '' };
}

/** 不含密钥的 provider，供前端展示。 */
export interface PublicProvider {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  hasAuth: boolean;
  isEnv?: boolean;
  type?: 'anthropic' | 'openai';
}

export async function publicConfig(): Promise<{ providers: PublicProvider[]; activeProviderId: string; hasGatewayKey: boolean }> {
  const c = await loadConfig();
  const saved = c.providers ?? [];
  const list: PublicProvider[] = [];
  const env = envProvider();
  if (env) list.push({ id: 'env', name: env.name, baseURL: env.baseURL, model: stripModelSuffix(env.model), hasAuth: Boolean(env.authToken || env.apiKey), isEnv: true });
  for (const p of saved) list.push({ id: p.id, name: p.name, baseURL: p.baseURL, model: stripModelSuffix(p.model), hasAuth: Boolean(p.authToken || p.apiKey), type: p.type });
  const active = c.activeProviderId && list.some((p) => p.id === c.activeProviderId) ? c.activeProviderId : (list[0]?.id ?? '');
  return { providers: list, activeProviderId: active, hasGatewayKey: Boolean(c.gatewayKey) };
}

/** 保存中转网关 key（undefined=不改；''=清除；其它=设置）。 */
export async function saveGatewayKey(key: string | undefined): Promise<void> {
  const cur = await loadConfig();
  if (key === undefined) return;
  const next: AppConfig = { ...cur, gatewayKey: key || undefined };
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
}

/** 保存 providers（密钥留空时保留已有值）+ activeProviderId。 */
export async function saveProviders(providers: ProviderConfig[], activeProviderId: string): Promise<void> {
  const cur = await loadConfig();
  const old = new Map((cur.providers ?? []).map((p) => [p.id, p]));
  const merged = providers.map((p) => ({
    ...p,
    authToken: p.authToken || old.get(p.id)?.authToken,
    apiKey: p.apiKey || old.get(p.id)?.apiKey,
  }));
  const next: AppConfig = { ...cur, providers: merged, activeProviderId };
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
}

/** 解析某 provider（或 active/env 兜底）为 AnthropicProvider 所需配置。 */
export async function resolveProvider(id?: string): Promise<{
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  defaultModel: string;
  maxTokens?: number;
}> {
  const c = await loadConfig();
  const maxTokens = c.maxTokens;
  if (id && id !== 'env') {
    const p = (c.providers ?? []).find((x) => x.id === id);
    if (p) return { apiKey: p.apiKey, authToken: p.authToken, baseURL: p.baseURL, defaultModel: stripModelSuffix(p.model), maxTokens };
  }
  const env = envProvider();
  if (env) return { apiKey: env.apiKey, authToken: env.authToken, baseURL: env.baseURL, defaultModel: stripModelSuffix(env.model), maxTokens };
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || c.anthropicApiKey,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || c.anthropicAuthToken,
    baseURL: process.env.ANTHROPIC_BASE_URL || c.anthropicBaseURL,
    defaultModel: stripModelSuffix(process.env.ANTHROPIC_MODEL || c.model || ''),
    maxTokens,
  };
}