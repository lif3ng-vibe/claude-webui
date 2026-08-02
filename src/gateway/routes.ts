import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig, resolveProvider, stripModelSuffix } from '../config.js';
import { checkGatewayAuth } from './auth.js';
import { parseAnthropicSse } from './parseSse.js';
import { saveLog, type GatewayLog } from './recorder.js';

/**
 * 按 body.model 匹配 provider（model 字段精确，去后缀比较）；
 * 无匹配用活动 provider；都没有返回 null。
 */
export async function resolveProviderByModel(model: string): Promise<string | null> {
  const c = await loadConfig();
  const providers = c.providers ?? [];
  const act = c.activeProviderId;
  if (model) {
    const m = stripModelSuffix(model);
    const hit = providers.find((p) => stripModelSuffix(p.model) === m);
    if (hit) return hit.id;
  }
  if (act && providers.some((p) => p.id === act)) return act;
  return providers[0]?.id ?? null;
}

async function readBodyRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** POST /v1/messages：auth → 按 model 选 provider → fetch 字节透传 → 记录。 */
export async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const headersLower: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) headersLower[k.toLowerCase()] = v;

  if (!(await checkGatewayAuth(headersLower))) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid gateway key' } }));
    return;
  }

  const bodyRaw = await readBodyRaw(req);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(bodyRaw || '{}');
  } catch {
    /* 透传原样；body 保持空 */
  }

  const model = typeof body.model === 'string' ? body.model : '';
  const providerId = await resolveProviderByModel(model);
  if (!providerId) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: 'no provider configured' } }));
    return;
  }
  const cfg = await resolveProvider(providerId);
  if (!cfg.baseURL || (!cfg.apiKey && !cfg.authToken)) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: 'provider not fully configured' } }));
    return;
  }

  // 上游 headers：透传 anthropic-version，认证替换为 provider 凭证。
  const upHeaders: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) upHeaders['x-api-key'] = cfg.apiKey;
  if (cfg.authToken) upHeaders['authorization'] = `Bearer ${cfg.authToken}`;
  const ver = headersLower['anthropic-version'];
  upHeaders['anthropic-version'] = (Array.isArray(ver) ? ver[0] : ver) || '2023-06-01';

  const upstreamUrl = cfg.baseURL.replace(/\/$/, '') + '/v1/messages';
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method: 'POST', headers: upHeaders, body: bodyRaw });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: `upstream unreachable: ${String((e as Error)?.message ?? e)}` } }));
    return;
  }

  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });

  // 透传字节 + tee 累积
  let buffer = '';
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });
  const reader = upstream.body?.getReader();
  const dec = new TextDecoder();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || aborted) break;
        res.write(value);
        buffer += dec.decode(value, { stream: true });
      }
    } catch {
      /* 上游中断：尽量已透传的部分 */
    }
    if (aborted)
      try {
        await reader.cancel();
      } catch {
        /* 忽略 */
      }
  }
  buffer += dec.decode();
  try {
    res.end();
  } catch {
    /* 客户端已断 */
  }

  // 记录（失败不影响已返回的响应）
  const streamFlag = body.stream === true;
  let response: GatewayLog['response'];
  try {
    response = streamFlag ? parseAnthropicSse(buffer) : JSON.parse(buffer || '{}');
  } catch {
    response = undefined;
  }
  await saveLog({
    id: randomUUID(),
    createdAt: startedAt,
    providerId,
    model: model || cfg.defaultModel,
    stream: streamFlag,
    request: body,
    response,
    elapsedMs: Date.now() - startedAt,
    status: upstream.ok ? 'ok' : 'error',
    error: upstream.ok ? undefined : `upstream ${upstream.status}`,
  }).catch(() => {});
}
