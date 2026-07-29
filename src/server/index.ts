import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { ClaudeFileReader } from '../claude/FileReader.js';
import { ClaudeRunner } from '../claude/Runner.js';
import { AnthropicProvider } from '../provider/AnthropicProvider.js';
import type { ProviderMessage } from '../provider/Provider.js';
import { resolveProvider, publicConfig, saveProviders } from '../config.js';
import { PromptsStore } from '../prompts.js';
import { FS_TOOLS, createFsToolExecutor } from '../tools/fsTools.js';

const STUDY_PROMPT =
  '你是一个资深工程师。用户会给你 Claude Code session 里的某一步记录和一个问题。' +
  '先用 read_file / list_files / grep 调查工作目录里的真实文件（也可读 ~/.claude 下的 session 记录），' +
  '再给出准确、具体的回答。只读，不要尝试写文件。';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reader = new ClaudeFileReader();
const runner = new ClaudeRunner();
const prompts = new PromptsStore();
const PORT = Number(process.env.PORT) || 3000;
const WEB_DIR = join(__dirname, '..', '..', 'web');
const DIST_DIR = join(WEB_DIR, 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const DEV_HINT =
  '<!doctype html><meta charset="utf-8"><title>claude-webui</title>' +
  '<body style="background:#1a1a1a;color:#ddd;font:14px/1.6 system-ui;padding:24px">' +
  '<h2 style="color:#8ab4f8">前端未构建</h2>' +
  '<p>开发模式：启动后端后，用前端 dev server <code>cd web && npm run dev</code> 打开 ' +
  '<a style="color:#8ab4f8" href="http://localhost:5173">http://localhost:5173</a>。</p>' +
  '<p>单进程模式：先 <code>cd web && npm run build</code>，再重启后端，访问本页。</p>' +
  '</body>';

async function serveDistFile(urlPath: string, res: ServerResponse): Promise<boolean> {
  const filePath = join(DIST_DIR, urlPath);
  const rel = relative(DIST_DIR, filePath);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    try {
      const data = await readFile(filePath);
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
      res.end(data);
      return true;
    } catch {
      /* 文件不存在 */
    }
  }
  return false;
}

/** 正在运行的 session（按 sessionId 加锁，防止并发写同一 session 导致分叉）。 */
const runningSessions = new Set<string>();

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

function sseWriter(res: ServerResponse, req: IncomingMessage) {
  let clientGone = false;
  req.on('close', () => { clientGone = true; });
  const write = (chunk: string): void => {
    if (clientGone) return;
    try {
      res.write(chunk);
    } catch {
      /* 客户端已断开 */
    }
  };
  return write;
}

async function handleRun(req: IncomingMessage, res: ServerResponse, dirName: string, sessionId: string): Promise<void> {
  if (runningSessions.has(sessionId)) {
    json(res, 409, { error: '该 session 正在运行中，请等当前指令结束' });
    return;
  }
  const body = await readBody(req);
  const prompt = String(body.prompt ?? '');
  if (!prompt) {
    json(res, 400, { error: 'prompt 不能为空' });
    return;
  }
  const cwd = await reader.getSessionCwd(dirName, sessionId);
  if (!cwd) {
    json(res, 400, { error: '无法确定该 session 的工作目录，不能续接' });
    return;
  }

  runningSessions.add(sessionId);
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  res.writeHead(200, SSE_HEADERS);
  const write = sseWriter(res, req);

  try {
    for await (const ev of runner.run({ sessionId, cwd, prompt, model: body.model, signal: ac.signal })) {
      const payload = ev.type === 'stream-json' ? ev.data : ev.type === 'stderr' ? { text: ev.text } : { code: ev.code };
      write(`event: ${ev.type}\n`);
      write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    write('event: done\ndata: {}\n\n');
  } catch (e) {
    write(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`);
  } finally {
    runningSessions.delete(sessionId);
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* 忽略 */
    }
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages as ProviderMessage[] : [];
  if (!messages.length) {
    json(res, 400, { error: 'messages 不能为空' });
    return;
  }
  const cfg = await resolveProvider(body.providerId);
  if (!cfg.defaultModel) {
    json(res, 400, { error: '未配置 model（在设置里配置 provider，或设 ANTHROPIC_MODEL）' });
    return;
  }
  const provider = new AnthropicProvider(cfg);
  const ac = new AbortController();
  res.writeHead(200, SSE_HEADERS);
  const write = sseWriter(res, req);
  req.on('close', () => ac.abort());

  try {
    for await (const d of provider.stream({
      model: body.model || cfg.defaultModel,
      messages,
      systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined,
    })) {
      const payload =
        d.type === 'request'
          ? { request: d.request }
          : d.type === 'text' || d.type === 'thinking'
            ? { text: d.text }
            : d.type === 'tool_use'
              ? { toolCall: d.toolCall }
              : d.type === 'error'
                ? { error: d.error }
                : {};
      write(`event: ${d.type}\n`);
      write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  } catch (e) {
    write(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`);
  } finally {
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* 忽略 */
    }
  }
}

async function handleStudy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const dirName = String(body.dirName ?? '');
  const sessionId = String(body.sessionId ?? '');
  const question = String(body.question ?? '');
  if (!dirName || !sessionId || !question) {
    json(res, 400, { error: '需要 dirName/sessionId/question' });
    return;
  }
  const cwd = await reader.getSessionCwd(dirName, sessionId);
  if (!cwd) {
    json(res, 400, { error: '无法确定该 session 的工作目录' });
    return;
  }
  const cfg = await resolveProvider(body.providerId);
  if (!cfg.defaultModel) {
    json(res, 400, { error: '未配置 model' });
    return;
  }

  const executor = createFsToolExecutor([cwd, reader.claudeHome()]);
  const provider = new AnthropicProvider(cfg);
  const steps = Array.isArray(body.steps) ? body.steps : body.step != null ? [body.step] : [];
  const stepText = steps
    .map((s: unknown, i: number) => `--- 步骤 ${i + 1} ---\n${JSON.stringify(s)}`)
    .join('\n\n')
    .slice(0, 8000);
  const userMessage =
    `以下是 Claude Code session（工作目录 ${cwd}）里的 ${steps.length} 步记录：\n\n${stepText}\n\n` +
    `问题：${question}\n\n` +
    `你可以使用 read_file / list_files / grep（根目录为该工作目录，也可读 ~/.claude）查阅真实文件后再回答。`;

  const ac = new AbortController();
  res.writeHead(200, SSE_HEADERS);
  const write = sseWriter(res, req);
  req.on('close', () => ac.abort());

  try {
    for await (const d of provider.stream({
      model: body.model || cfg.defaultModel,
      messages: [{ role: 'user', content: userMessage }],
      systemPrompt: typeof body.systemPrompt === 'string' && body.systemPrompt ? body.systemPrompt : STUDY_PROMPT,
      tools: FS_TOOLS,
      executeTool: executor,
    })) {
      const payload =
        d.type === 'request'
          ? { request: d.request }
          : d.type === 'text' || d.type === 'thinking'
            ? { text: d.text }
            : d.type === 'tool_use'
              ? { toolCall: d.toolCall }
              : d.type === 'tool_result'
                ? { id: d.id, name: d.name, result: d.result }
                : d.type === 'error'
                  ? { error: d.error }
                  : {};
      write(`event: ${d.type}\n`);
      write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  } catch (e) {
    write(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`);
  } finally {
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* 忽略 */
    }
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    if (path === '/' && req.method === 'GET') {
      try {
        const html = await readFile(join(DIST_DIR, 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(DEV_HINT);
      }
    }

    // 静态资源（构建产物 web/dist）+ SPA fallback
    if (req.method === 'GET' && !path.startsWith('/api/')) {
      if (await serveDistFile(path, res)) return;
      if (!path.includes('.', 1)) {
        try {
          const html = await readFile(join(DIST_DIR, 'index.html'), 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(html);
        } catch {
          /* dist 未构建，落到 404 */
        }
      }
    }

    // —— 配置 ——
    if (path === '/api/config' && req.method === 'GET') return json(res, 200, await publicConfig());
    if (path === '/api/config' && req.method === 'PUT') {
      const b = await readBody(req);
      const providers = Array.isArray(b.providers) ? b.providers : [];
      await saveProviders(providers, String(b.activeProviderId ?? ''));
      return json(res, 200, await publicConfig());
    }

    // —— 预置提示词 ——
    if (path === '/api/prompts' && req.method === 'GET') return json(res, 200, await prompts.list());
    if (path === '/api/prompts' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.id || !b.title || typeof b.text !== 'string') return json(res, 400, { error: '需要 id/title/text' });
      return json(res, 200, await prompts.upsert({ id: String(b.id), title: String(b.title), text: String(b.text) }));
    }
    let pm: RegExpMatchArray | null;
    if ((pm = path.match(/^\/api\/prompts\/([^/]+)$/)) && req.method === 'DELETE') {
      return json(res, 200, await prompts.remove(decodeURIComponent(pm[1])));
    }

    // —— 对话 ——
    if (path === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (path === '/api/study' && req.method === 'POST') return await handleStudy(req, res);

    // —— session 浏览 / 续接 ——
    if (path === '/api/projects' && req.method === 'GET') return json(res, 200, await reader.listProjects());

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/sessions$/)) && req.method === 'GET') {
      return json(res, 200, await reader.listSessions(decodeURIComponent(m[1])));
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/)) && req.method === 'GET') {
      return json(res, 200, await reader.readSessionMessages(decodeURIComponent(m[1]), decodeURIComponent(m[2])));
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/run$/)) && req.method === 'POST') {
      return await handleRun(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`claude-webui 开发服务: http://localhost:${PORT}`);
});