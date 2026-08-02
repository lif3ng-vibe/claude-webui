import { loadConfig } from '../config.js';

type Headers = Record<string, string | string[] | undefined>;

/**
 * 校验中转请求。未配置 gatewayKey 时一律放行（本地零配置）；
 * 配了则要求客户端带 x-api-key 或 Authorization: Bearer，且与 key 相等。
 */
export async function checkGatewayAuth(headers: Headers): Promise<boolean> {
  const c = await loadConfig();
  const key = c.gatewayKey;
  if (!key) return true;
  const xkey = headers['x-api-key'];
  const auth = headers['authorization'];
  const raw = (Array.isArray(xkey) ? xkey[0] : xkey) ?? (Array.isArray(auth) ? auth[0] : auth) ?? '';
  const provided = raw.replace(/^Bearer\s+/i, '');
  return provided === key;
}
