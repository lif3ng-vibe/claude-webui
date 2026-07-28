import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ClaudeFileReader } from '../claude/FileReader.js';
import { ClaudeRunner } from '../claude/Runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reader = new ClaudeFileReader();
const runner = new ClaudeRunner();
const PORT = Number(process.env.PORT) || 3000;
const WEB_DIR = join(__dirname, '..', '..', 'web');

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

async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  dirName: string,
  sessionId: string,
): Promise<void> {
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
  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
    ac.abort();
  });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const write = (chunk: string): void => {
    if (clientGone) return;
    try {
      res.write(chunk);
    } catch {
      /* 客户端已断开 */
    }
  };

  try {
    for await (const ev of runner.run({ sessionId, cwd, prompt, model: body.model, signal: ac.signal })) {
      const payload =
        ev.type === 'stream-json' ? ev.data : ev.type === 'stderr' ? { text: ev.text } : { code: ev.code };
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

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    if (path === '/' && req.method === 'GET') {
      const html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
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