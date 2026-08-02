import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig, stripModelSuffix } from '../config.js';
import { checkGatewayAuth } from './auth.js';
import { parseAnthropicSse } from './parseSse.js';
import { saveLog, type GatewayLog } from './recorder.js';
import {
  openaiReqToAnthropic,
  anthropicReqToOpenai,
  anthropicRespToOpenai,
  openaiRespToAnthropic,
  type OpenAIReq,
} from './convert.js';
import { AnthropicToOpenAIStream, OpenAIToAnthropicStream } from './streamConvert.js';

type Fmt = 'anthropic' | 'openai';

interface ProviderFull {
  id: string;
  type: Fmt;
  baseURL: string;
  apiKey?: string;
  authToken?: string;
  model: string;
}

/** 按 body.model 匹配 provider（去后缀比较）；无匹配用活动；都没有返回 null。 */
export async function resolveProviderByModel(model: string): Promise<ProviderFull | null> {
  const c = await loadConfig();
  const providers = c.providers ?? [];
  const act = c.activeProviderId;
  let p = model ? providers.find((x) => stripModelSuffix(x.model) === stripModelSuffix(model)) : undefined;
  if (!p && act) p = providers.find((x) => x.id === act);
  if (!p) p = providers[0];
  if (!p) return null;
  return { id: p.id, type: p.type === 'openai' ? 'openai' : 'anthropic', baseURL: p.baseURL, apiKey: p.apiKey, authToken: p.authToken, model: p.model };
}

async function readBodyRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function authHeaders(p: ProviderFull, clientAnthropicVer?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (p.type === 'openai') {
    if (p.apiKey || p.authToken) h['authorization'] = `Bearer ${p.authToken || p.apiKey}`;
  } else {
    if (p.apiKey) h['x-api-key'] = p.apiKey;
    if (p.authToken) h['authorization'] = `Bearer ${p.authToken}`;
    h['anthropic-version'] = clientAnthropicVer || '2023-06-01';
  }
  return h;
}

function upstreamUrl(p: ProviderFull): string {
  return p.baseURL.replace(/\/$/, '') + (p.type === 'openai' ? '/v1/chat/completions' : '/v1/messages');
}

/** 把累积的响应字节解析成记录用的 Anthropic 风格 response。 */
function parseLogged(format: Fmt, buf: string, stream: boolean): GatewayLog['response'] {
  try {
    if (format === 'anthropic') return stream ? parseAnthropicSse(buf) : JSON.parse(buf || '{}');
    if (!stream) return openaiRespToAnthropic(JSON.parse(buf || '{}')) as GatewayLog['response'];
    // openai 流式：拼 delta.content
    const texts: string[] = [];
    let finish = 'stop';
    for (const chunk of buf.split(/\n\n/)) {
      const dLine = chunk.split(/\n/).find((l) => l.startsWith('data:'));
      if (!dLine) continue;
      const str = dLine.slice(5).trim();
      if (str === '[DONE]' || !str) continue;
      const j = JSON.parse(str);
      const ch = j.choices?.[0];
      if (ch?.delta?.content) texts.push(ch.delta.content);
      if (ch?.finish_reason) finish = ch.finish_reason;
    }
    return openaiRespToAnthropic({ choices: [{ message: { role: 'assistant', content: texts.join('') }, finish_reason: finish }], usage: {} }) as GatewayLog['response'];
  } catch {
    return undefined;
  }
}

function parseAnthropicSseEvent(raw: string): { type: string; data: Record<string, unknown> } | null {
  let type = '';
  let dataStr = '';
  for (const ln of raw.split(/\n/)) {
    if (ln.startsWith('event:')) type = ln.slice(6).trim();
    else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
  }
  if (!type) return null;
  try {
    return { type, data: JSON.parse(dataStr || '{}') };
  } catch {
    return null;
  }
}

/** 通用网关：inFmt = 客户端协议格式。同格式透传；跨格式转换。 */
async function handleGateway(req: IncomingMessage, res: ServerResponse, inFmt: Fmt): Promise<void> {
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
    /* 透传原样 */
  }
  const model = typeof body.model === 'string' ? body.model : '';
  const provider = await resolveProviderByModel(model);
  if (!provider || !provider.baseURL || (!provider.apiKey && !provider.authToken)) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: 'no provider configured' } }));
    return;
  }

  const stream = body.stream === true;
  const sameFormat = inFmt === provider.type;
  const clientAnthropicVer = (() => {
    const v = headersLower['anthropic-version'];
    return typeof v === 'string' ? v : undefined;
  })();

  // 上游请求体：同格式原样；跨格式转换
  let upBodyRaw: string;
  try {
    upBodyRaw = sameFormat ? bodyRaw : JSON.stringify(inFmt === 'anthropic' ? anthropicReqToOpenai(body) : openaiReqToAnthropic(body as OpenAIReq));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: 'failed to convert request' } }));
    return;
  }
  const upHeaders = authHeaders(provider, clientAnthropicVer);
  const url = upstreamUrl(provider);

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: 'POST', headers: upHeaders, body: upBodyRaw });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: `upstream unreachable: ${String((e as Error)?.message ?? e)}` } }));
    return;
  }

  const clientContentType = sameFormat
    ? upstream.headers.get('content-type') ?? 'application/json'
    : inFmt === 'anthropic'
      ? 'text/event-stream'
      : 'application/json';
  res.writeHead(upstream.status, { 'content-type': stream && !sameFormat ? 'text/event-stream' : clientContentType });

  let clientBuf = ''; // 客户端实际看到的（记录用，inFmt 格式）
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });
  const dec = new TextDecoder();
  const reader = upstream.body?.getReader();

  try {
    if (sameFormat) {
      // 透传字节
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          res.write(value);
          clientBuf += dec.decode(value, { stream: true });
        }
        if (aborted) try { await reader.cancel(); } catch { /* 忽略 */ }
      }
    } else if (stream) {
      // 跨格式流式：边读后端事件边转换边发
      const anthropicConv = provider.type === 'anthropic' ? new AnthropicToOpenAIStream() : null;
      const openaiConv = provider.type === 'openai' ? new OpenAIToAnthropicStream() : null;
      let sseBuf = '';
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          sseBuf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = sseBuf.indexOf('\n\n')) >= 0) {
            const raw = sseBuf.slice(0, idx);
            sseBuf = sseBuf.slice(idx + 2);
            let lines: string[] = [];
            if (anthropicConv) {
              const ev = parseAnthropicSseEvent(raw);
              if (ev) lines = anthropicConv.feed(ev.type, ev.data);
            } else if (openaiConv) {
              const dLine = raw.split(/\n/).find((l) => l.startsWith('data:'));
              if (dLine) {
                const str = dLine.slice(5).trim();
                if (str && str !== '[DONE]') {
                  try {
                    lines = openaiConv.feed(JSON.parse(str));
                  } catch {
                    /* 跳过坏 chunk */
                  }
                }
              }
            }
            for (const l of lines) {
              res.write(l);
              clientBuf += l;
            }
          }
        }
      }
      if (aborted) try { await reader?.cancel(); } catch { /* 忽略 */ }
    } else {
      // 跨格式非流式：读完整 → 转换 JSON
      let backendBuf = '';
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          backendBuf += dec.decode(value, { stream: true });
        }
      }
      try {
        const j = JSON.parse(backendBuf || '{}');
        const converted = provider.type === 'anthropic' ? anthropicRespToOpenai(j) : openaiRespToAnthropic(j);
        clientBuf = JSON.stringify(converted);
        res.write(clientBuf);
      } catch {
        /* 转换失败：已写状态码，body 空 */
      }
    }
  } catch {
    /* 上游/写入中断：尽量已发的部分 */
  }
  try {
    res.end();
  } catch {
    /* 客户端已断 */
  }

  // 记录（clientBuf 是 inFmt 格式，统一解析）
  await saveLog({
    id: randomUUID(),
    createdAt: startedAt,
    providerId: provider.id,
    model: model || provider.model,
    stream,
    request: body,
    response: parseLogged(inFmt, clientBuf + dec.decode(), stream),
    elapsedMs: Date.now() - startedAt,
    status: upstream.ok ? 'ok' : 'error',
    error: upstream.ok ? undefined : `upstream ${upstream.status}`,
  }).catch(() => {});
}

/** POST /v1/messages（Anthropic 兼容入参）。 */
export async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleGateway(req, res, 'anthropic');
}

/** POST /v1/chat/completions（OpenAI 兼容入参）。 */
export async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleGateway(req, res, 'openai');
}
