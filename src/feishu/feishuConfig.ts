import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, configDir } from '../config.js';

/** 飞书域名：feishu（国内，默认）/ lark（国际版）。 */
export type FeishuDomain = 'feishu' | 'lark';

/** 机器人绑定的 Claude session（"用途"）。 */
export interface BoundSession {
  dirName: string;
  sessionId: string;
}

/** 一个飞书自建应用配置（含密钥，仅后端）。 */
export interface FeishuApp {
  /** 内部 id（UI 增删用，前端生成）。 */
  id: string;
  /** 易记标签（UI 显示，可选）。 */
  name?: string;
  appId: string;
  appSecret: string;
  allowedUserIds: string[];
  domain: FeishuDomain;
  enableNotify: boolean;
  chatIdForNotify?: string;
  timeoutMs?: number | null;
  /** 该机器人续接的固定 session；为空则用命令切换。 */
  boundSession?: BoundSession | null;
}

/** 不含密钥的应用配置，供前端展示。 */
export interface PublicFeishuApp {
  id: string;
  name?: string;
  appId: string;
  allowedUserIds: string[];
  domain: FeishuDomain;
  enableNotify: boolean;
  chatIdForNotify?: string;
  hasSecret: boolean;
  timeoutMs?: number | null;
  boundSession?: BoundSession | null;
}

const configPath = (): string => join(configDir(), 'config.json');

/** 把任意 raw 归一为 FeishuApp；appId/appSecret 任一缺失返回 null（视为未配置/未完成）。 */
function normalizeApp(raw: unknown): FeishuApp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const appId = String(r.appId ?? '').trim();
  const appSecret = String(r.appSecret ?? '').trim();
  if (!appId || !appSecret) return null;
  const bound = r.boundSession;
  return {
    id: String(r.id ?? appId),
    name: r.name ? String(r.name) : undefined,
    appId,
    appSecret,
    allowedUserIds: Array.isArray(r.allowedUserIds) ? r.allowedUserIds.map(String).filter(Boolean) : [],
    domain: r.domain === 'lark' ? 'lark' : 'feishu',
    enableNotify: r.enableNotify !== false,
    chatIdForNotify: r.chatIdForNotify ? String(r.chatIdForNotify) : undefined,
    timeoutMs: r.timeoutMs === undefined ? null : Number(r.timeoutMs) || null,
    boundSession:
      bound && typeof bound === 'object'
        ? { dirName: String((bound as Record<string, unknown>).dirName ?? ''), sessionId: String((bound as Record<string, unknown>).sessionId ?? '') }
        : null,
  };
}

/**
 * 读取所有飞书应用（含迁移旧的单 app 配置：旧 `feishu:{appId,...}` → `[single]`）。
 * 只返回 appId+appSecret 齐全的有效应用。
 */
export async function loadFeishuApps(): Promise<FeishuApp[]> {
  const c = await loadConfig();
  const f = (c as { feishu?: unknown }).feishu;
  if (!f || typeof f !== 'object') return [];
  const apps = (f as { apps?: unknown }).apps;
  if (Array.isArray(apps)) return apps.map(normalizeApp).filter(Boolean) as FeishuApp[];
  // 旧格式：单个 app 对象
  const single = normalizeApp(f);
  return single ? [single] : [];
}

/** 读取脱敏的应用列表（不含 appSecret），供前端。 */
export async function publicFeishuApps(): Promise<PublicFeishuApp[]> {
  const apps = await loadFeishuApps();
  return apps.map((a) => ({
    id: a.id,
    name: a.name,
    appId: a.appId,
    allowedUserIds: a.allowedUserIds,
    domain: a.domain,
    enableNotify: a.enableNotify,
    chatIdForNotify: a.chatIdForNotify,
    hasSecret: Boolean(a.appSecret),
    timeoutMs: a.timeoutMs ?? null,
    boundSession: a.boundSession ?? null,
  }));
}

/**
 * 保存应用列表（整体替换）。appSecret 留空时保留旧值（前端回填脱敏配置不清空密钥）。
 */
export async function saveFeishuApps(input: FeishuApp[]): Promise<void> {
  const cur = await loadFeishuApps();
  const oldById = new Map(cur.map((a) => [a.id, a]));
  const apps: FeishuApp[] = input.map((p) => {
    const old = oldById.get(p.id);
    return {
      id: p.id || old?.id || p.appId,
      name: p.name || undefined,
      appId: String(p.appId ?? old?.appId ?? '').trim(),
      appSecret: (p.appSecret && p.appSecret.trim()) || old?.appSecret || '',
      allowedUserIds: Array.isArray(p.allowedUserIds) ? p.allowedUserIds.map(String).filter(Boolean) : (old?.allowedUserIds ?? []),
      domain: p.domain ?? old?.domain ?? 'feishu',
      enableNotify: p.enableNotify ?? old?.enableNotify ?? true,
      chatIdForNotify: p.chatIdForNotify !== undefined ? (p.chatIdForNotify || undefined) : old?.chatIdForNotify,
      timeoutMs: p.timeoutMs !== undefined ? p.timeoutMs : (old?.timeoutMs ?? null),
      boundSession: p.boundSession !== undefined ? (p.boundSession || null) : (old?.boundSession ?? null),
    };
  });
  const c = await loadConfig();
  const next = { ...c, feishu: { apps } };
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
}
