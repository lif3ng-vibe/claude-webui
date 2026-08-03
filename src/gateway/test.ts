import { randomUUID } from 'node:crypto';
import { loadConfig, resolveProvider } from '../config.js';
import { openaiReqToAnthropic, openaiRespToAnthropic } from './convert.js';
import { saveLog } from './recorder.js';

export interface TestResult {
  ok: boolean;
  model?: string;
  content?: string;
  elapsedMs: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: string;
}

/**
 * 用指定（或活动/首个）provider 发一条测试请求，验证中转→provider→返回全链路。
 * 不写入中转日志（测试专用）。providerId 留空用活动 provider。
 */
export async function testProvider(providerId?: string, prompt = '请回复 OK'): Promise<TestResult> {
  const startedAt = Date.now();
  try {
    const c = await loadConfig();
    const providers = c.providers ?? [];
    const pid = providerId ?? c.activeProviderId ?? providers[0]?.id;
    if (!pid) return { ok: false, elapsedMs: 0, error: '未配置 provider' };
    const configured = pid === 'env' ? null : providers.find((x) => x.id === pid);
    if (!configured && pid !== 'env') return { ok: false, elapsedMs: 0, error: `provider ${pid} 不存在` };
    const cfg = await resolveProvider(pid);
    if (!cfg.baseURL || (!cfg.apiKey && !cfg.authToken)) {
      return { ok: false, elapsedMs: 0, error: 'provider 未配置 baseURL/key' };
    }
    const type = configured?.type === 'openai' ? 'openai' : 'anthropic';
    const p = { id: pid, type, baseURL: cfg.baseURL, apiKey: cfg.apiKey, authToken: cfg.authToken, model: configured?.model ?? cfg.defaultModel };
    const anthropicReq = { model: p.model, max_tokens: 100, messages: [{ role: 'user', content: prompt }] };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let upstreamUrl: string;
    let upstreamBody: string;
    if (type === 'openai') {
      if (p.apiKey || p.authToken) headers['authorization'] = `Bearer ${p.authToken || p.apiKey}`;
      upstreamBody = JSON.stringify(openaiReqToAnthropic(anthropicReq));
      upstreamUrl = p.baseURL.replace(/\/$/, '') + '/v1/chat/completions';
    } else {
      if (p.apiKey) headers['x-api-key'] = p.apiKey;
      if (p.authToken) headers['authorization'] = `Bearer ${p.authToken}`;
      headers['anthropic-version'] = '2023-06-01';
      upstreamBody = JSON.stringify(anthropicReq);
      upstreamUrl = p.baseURL.replace(/\/$/, '') + '/v1/messages';
    }

    const up = await fetch(upstreamUrl, { method: 'POST', headers, body: upstreamBody });
    const text = await up.text();
    if (!up.ok) {
      const elapsedMs = Date.now() - startedAt;
      await saveLog({ id: randomUUID(), createdAt: startedAt, providerId: p.id, model: p.model, stream: false, request: anthropicReq, elapsedMs, status: 'error', error: `upstream ${up.status}: ${text.slice(0, 300)}`, test: true }).catch(() => {});
      return { ok: false, elapsedMs, error: `upstream ${up.status}: ${text.slice(0, 300)}` };
    }

    const j = JSON.parse(text);
    const resp = type === 'openai' ? openaiRespToAnthropic(j) : j;
    const content = Array.isArray(resp.content)
      ? (resp.content as Array<Record<string, unknown>>).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('')
      : '';
    const elapsedMs = Date.now() - startedAt;
    await saveLog({ id: randomUUID(), createdAt: startedAt, providerId: p.id, model: p.model, stream: false, request: anthropicReq, response: resp, elapsedMs, status: 'ok', test: true }).catch(() => {});
    return { ok: true, model: String(resp.model ?? p.model), content, elapsedMs, usage: resp.usage };
  } catch (e) {
    return { ok: false, elapsedMs: Date.now() - startedAt, error: String((e as Error)?.message ?? e) };
  }
}
