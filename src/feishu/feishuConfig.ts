import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, configDir } from '../config.js';

/** 飞书域名：feishu（国内，默认）/ lark（国际版）。 */
export type FeishuDomain = 'feishu' | 'lark';

/** 飞书机器人配置（含密钥，仅后端）。 */
export interface FeishuConfig {
  appId: string;
  appSecret: string;
  allowedUserIds: string[];
  domain: FeishuDomain;
  enableNotify: boolean;
  chatIdForNotify?: string;
  /** 续接硬超时（毫秒）；null=关闭，靠 /stop 手动停。 */
  timeoutMs?: number | null;
}

/** 不含密钥的飞书配置，供前端展示。 */
export interface PublicFeishuConfig {
  appId: string;
  allowedUserIds: string[];
  domain: FeishuDomain;
  enableNotify: boolean;
  chatIdForNotify?: string;
  hasSecret: boolean;
  timeoutMs?: number | null;
}

const configPath = (): string => join(configDir(), 'config.json');

/** 把任意 raw 归一为 FeishuConfig；appId/appSecret 任一缺失返回 null（视为未配置）。 */
function normalize(raw: unknown): FeishuConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const appId = String(r.appId ?? '').trim();
  const appSecret = String(r.appSecret ?? '').trim();
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    allowedUserIds: Array.isArray(r.allowedUserIds) ? r.allowedUserIds.map(String).filter(Boolean) : [],
    domain: r.domain === 'lark' ? 'lark' : 'feishu',
    enableNotify: r.enableNotify !== false, // 默认 true
    chatIdForNotify: r.chatIdForNotify ? String(r.chatIdForNotify) : undefined,
    timeoutMs: r.timeoutMs === undefined ? null : Number(r.timeoutMs) || null,
  };
}

/** 读取飞书配置；未配置（appId/appSecret 缺失）返回 null。 */
export async function loadFeishu(): Promise<FeishuConfig | null> {
  const c = await loadConfig();
  return normalize((c as { feishu?: unknown }).feishu);
}

/** 读取脱敏的飞书配置（不含 appSecret），供前端；未配置返回 null。 */
export async function publicFeishu(): Promise<PublicFeishuConfig | null> {
  const f = await loadFeishu();
  if (!f) return null;
  return {
    appId: f.appId,
    allowedUserIds: f.allowedUserIds,
    domain: f.domain,
    enableNotify: f.enableNotify,
    chatIdForNotify: f.chatIdForNotify,
    hasSecret: Boolean(f.appSecret),
    timeoutMs: f.timeoutMs ?? null,
  };
}

/**
 * 保存飞书配置。appSecret 传空串/未传时保留旧值（与 saveProviders 一致），
 * 避免前端回填脱敏配置时把密钥清空。
 */
export async function saveFeishu(patch: Partial<FeishuConfig>): Promise<void> {
  const cur = await loadConfig();
  const old = normalize((cur as { feishu?: unknown }).feishu);
  const merged: FeishuConfig = {
    appId: String(patch.appId ?? old?.appId ?? '').trim(),
    appSecret: (patch.appSecret && patch.appSecret.trim()) || old?.appSecret || '',
    allowedUserIds: Array.isArray(patch.allowedUserIds)
      ? patch.allowedUserIds.map(String).filter(Boolean)
      : (old?.allowedUserIds ?? []),
    domain: patch.domain ?? old?.domain ?? 'feishu',
    enableNotify: patch.enableNotify ?? old?.enableNotify ?? true,
    chatIdForNotify:
      patch.chatIdForNotify !== undefined ? (patch.chatIdForNotify || undefined) : old?.chatIdForNotify,
    timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : (old?.timeoutMs ?? null),
  };
  const next = { ...cur, feishu: merged };
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
}
