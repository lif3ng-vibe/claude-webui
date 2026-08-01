import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { ClaudeFileReader } from '../claude/FileReader.js';
import { ClaudeRunner } from '../claude/Runner.js';
import { SessionRunner } from '../claude/SessionRunner.js';
import { AnthropicProvider } from '../provider/AnthropicProvider.js';
import type { ProviderMessage } from '../provider/Provider.js';
import { resolveProvider, publicConfig, saveProviders } from '../config.js';
import { conversations, type Conversation, type ConvMessage } from '../conversations.js';
import { PromptsStore } from '../prompts.js';
import { FS_TOOLS, createFsToolExecutor } from '../tools/fsTools.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { createTerminalHandler } from '../terminal/TerminalManager.js';

const STUDY_PROMPT =
  '你是一个资深工程师。用户会给你 Claude Code session 里的某一步记录和一个问题。' +
  '先用 read_file / list_files / grep 调查工作目录里的真实文件（也可读 ~/.claude 下的 session 记录），' +
  '再给出准确、具体的回答。只读，不要尝试写文件。';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reader = new ClaudeFileReader();
const runner = new ClaudeRunner();
const prompts = new PromptsStore();
// 注意 `Number(process.env.PORT) || 3000` 会把 PORT=0 当成 falsy 回退 3000，桌面壳握手靠 PORT=0 绑随机端口，故显式区分"未设"与"=0"。
const rawPort = process.env.PORT;
const PORT = rawPort === undefined || rawPort === ''
  ? 3000
  : Number.isFinite(Number(rawPort)) ? Number(rawPort) : 3000;
// 静态资源路径需 env 可覆盖：打包成单文件 sidecar 后 import.meta.url 指向 bundle 目录（<root>/dist-server），
// 与源码（<root>/src/server）层级不同，故按 CLAUDE_WEBUI_BUNDLE 区分回退深度；显式 env 优先。
const WEB_DIR = process.env.CLAUDE_WEBUI_WEB_DIR
  || (process.env.CLAUDE_WEBUI_BUNDLE ? join(__dirname, '..', 'web') : join(__dirname, '..', '..', 'web'));
const DIST_DIR = process.env.CLAUDE_WEBUI_DIST_DIR || join(WEB_DIR, 'dist');

// 结构化日志：写 stderr（stdout 留给握手行，shell 干净解析）。
function log(level: 'log' | 'error' | 'info', msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: Date.now(), level, msg, ...fields });
  process.stderr.write(line + '\n');
}

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
/** 共享锁驱动器：web 续接、飞书续接、本地通知都经此（见 src/claude/SessionRunner.ts）。 */
const sessionRunner = new SessionRunner(runner, runningSessions);

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

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  res.writeHead(200, SSE_HEADERS);
  const write = sseWriter(res, req);

  const result = await sessionRunner.runLocked(
    { sessionId, cwd, prompt, model: body.model, signal: ac.signal },
    {
      source: 'web',
      onEvent: (ev) => {
        const payload = ev.type === 'stream-json' ? ev.data : ev.type === 'stderr' ? { text: ev.text } : { code: ev.code };
        write(`event: ${ev.type}\n`);
        write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    },
  );
  if (result.ok) {
    write('event: done\ndata: {}\n\n');
  } else if (!result.aborted && !result.busy) {
    write(`event: error\ndata: ${JSON.stringify({ error: result.error ?? 'failed' })}\n\n`);
  }
  try {
    if (!res.writableEnded) res.end();
  } catch {
    /* 忽略 */
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
  const studyConvId = crypto.randomUUID();
  const now = Date.now();
  let studyMessages: unknown[] = [];

  const ac = new AbortController();
  res.writeHead(200, SSE_HEADERS);
  const write = sseWriter(res, req);
  req.on('close', () => ac.abort());
  write(`event: conversation\ndata: ${JSON.stringify({ id: studyConvId })}\n\n`);
  const steps = Array.isArray(body.steps) ? body.steps : body.step != null ? [body.step] : [];
  const stepText = steps
    .map((s: unknown, i: number) => `--- 步骤 ${i + 1} ---\n${JSON.stringify(s)}`)
    .join('\n\n')
    .slice(0, 8000);
  const userMessage =
    `以下是 Claude Code session（工作目录 ${cwd}）里的 ${steps.length} 步记录：\n\n${stepText}\n\n` +
    `问题：${question}\n\n` +
    `你可以使用 read_file / list_files / grep（根目录为该工作目录，也可读 ~/.claude）查阅真实文件后再回答。`;

  try {
    for await (const d of provider.stream({
      model: body.model || cfg.defaultModel,
      messages: [{ role: 'user', content: userMessage }],
      systemPrompt: typeof body.systemPrompt === 'string' && body.systemPrompt ? body.systemPrompt : STUDY_PROMPT,
      tools: FS_TOOLS,
      executeTool: executor,
    })) {
      if (d.type === 'messages') studyMessages = d.messages as unknown[];
      const payload =
        d.type === 'request'
          ? { request: d.request }
          : d.type === 'messages'
            ? { messages: d.messages }
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
    if (studyMessages.length) {
      await conversations.save({
        id: studyConvId,
        kind: 'study',
        title: question.slice(0, 40) || '深问',
        systemPrompt: STUDY_PROMPT,
        cwd,
        studySessionId: dirName,
        messages: studyMessages as ConvMessage[],
        createdAt: now,
        updatedAt: Date.now(),
      });
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
    if (path === '/api/running' && req.method === 'GET') return json(res, 200, await reader.getRunningSessions());

    // —— 对话持久化 ——
    if (path === '/api/conversations' && req.method === 'GET') return json(res, 200, await conversations.list());
    if (path === '/api/conversations' && req.method === 'POST') {
      const b = await readBody(req);
      const now = Date.now();
      const c: Conversation = {
        id: String(b.id ?? crypto.randomUUID()),
        kind: b.kind === 'study' ? 'study' : 'chat',
        title: String(b.title ?? '新对话'),
        systemPrompt: b.systemPrompt,
        model: b.model,
        providerId: b.providerId,
        cwd: b.cwd,
        studySessionId: b.studySessionId,
        messages: Array.isArray(b.messages) ? b.messages : [],
        createdAt: Number(b.createdAt ?? now),
        updatedAt: now,
      };
      await conversations.save(c);
      return json(res, 200, c);
    }
    let cm: RegExpMatchArray | null;
    if ((cm = path.match(/^\/api\/conversations\/([^/]+)$/))) {
      const id = decodeURIComponent(cm[1]);
      if (req.method === 'GET') {
        const c = await conversations.get(id);
        return c ? json(res, 200, c) : json(res, 404, { error: '对话不存在' });
      }
      if (req.method === 'PUT') {
        const cur = await conversations.get(id);
        if (!cur) return json(res, 404, { error: '对话不存在' });
        const b = await readBody(req);
        const next: Conversation = {
          ...cur,
          ...b,
          id: cur.id,
          kind: cur.kind,
          createdAt: cur.createdAt,
          updatedAt: Date.now(),
        };
        await conversations.save(next);
        return json(res, 200, next);
      }
      if (req.method === 'DELETE') {
        await conversations.remove(id);
        return json(res, 200, { ok: true });
      }
    }

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

// 网页交互终端：在同一个 http server 上挂 WebSocket（noServer + 手动 upgrade，按路径路由）。
const terminalHandler = createTerminalHandler(reader, runningSessions);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const m = req.url?.match(/^\/api\/terminal\/([^/]+)\/([^/]+)$/);
  if (!m) {
    socket.destroy();
    return;
  }
  const dirName = decodeURIComponent(m[1]);
  const sessionId = decodeURIComponent(m[2]);
  wss.handleUpgrade(req, socket, head, (ws) => {
    terminalHandler(ws as WebSocket, dirName, sessionId);
  });
});

server.listen(PORT, () => {
  // 绑 port 0 时 OS 分配随机端口，必须用实际端口而非请求端口，否则 shell 握手拿不到。
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  // 桌面壳握手：首行 stdout 回传实际端口，shell 据此把窗口指向 http://localhost:<port>/。
  if (process.env.CLAUDE_WEBUI_HANDSHAKE === '1') {
    process.stdout.write(`CLAUDE_WEBUI_PORT=${actualPort}\n`);
    log('info', 'sidecar started', { port: actualPort });
  } else {
    console.log(`claude-webui 开发服务: http://localhost:${actualPort}`);
  }
});