import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

/** 应用数据目录。可用 CLAUDE_WEBUI_DIR 覆盖（测试用）。 */
export function configDir(): string {
  return process.env.CLAUDE_WEBUI_DIR || join(os.homedir(), '.claude-webui');
}

const configPath = (): string => join(configDir(), 'config.json');

export interface AppConfig {
  anthropicApiKey?: string;
  anthropicAuthToken?: string;
  anthropicBaseURL?: string;
  model?: string;
  maxTokens?: number;
}

/** 读取配置：环境变量优先于配置文件。 */
export async function loadConfig(): Promise<AppConfig> {
  let file: AppConfig = {};
  try {
    file = JSON.parse(await readFile(configPath(), 'utf8'));
  } catch {
    /* 无配置文件 */
  }
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || file.anthropicApiKey,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || file.anthropicAuthToken,
    anthropicBaseURL: process.env.ANTHROPIC_BASE_URL || file.anthropicBaseURL,
    model: process.env.ANTHROPIC_MODEL || file.model,
    maxTokens: file.maxTokens,
  };
}

export async function saveConfig(patch: AppConfig): Promise<AppConfig> {
  await mkdir(configDir(), { recursive: true });
  const next = { ...(await loadConfig()), ...patch };
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 去掉 Claude Code 的 [1m] 之类上下文窗口后缀——代理不认。 */
export function stripModelSuffix(m: string): string {
  return m.replace(/\[.*\]$/, '');
}

/** 给 AnthropicProvider 用的配置（model 已去后缀）。 */
export async function providerConfig(): Promise<{
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  defaultModel: string;
  maxTokens?: number;
}> {
  const c = await loadConfig();
  return {
    apiKey: c.anthropicApiKey,
    authToken: c.anthropicAuthToken,
    baseURL: c.anthropicBaseURL,
    defaultModel: c.model ? stripModelSuffix(c.model) : '',
    maxTokens: c.maxTokens,
  };
}

/** 不含密钥的配置，供前端展示。 */
export async function publicConfig(): Promise<{
  model: string;
  baseURL: string;
  hasAuth: boolean;
}> {
  const c = await loadConfig();
  return {
    model: c.model ? stripModelSuffix(c.model) : '',
    baseURL: c.anthropicBaseURL ?? '',
    hasAuth: Boolean(c.anthropicApiKey || c.anthropicAuthToken),
  };
}