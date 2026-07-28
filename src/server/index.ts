import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ClaudeFileReader } from '../claude/FileReader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reader = new ClaudeFileReader();
const PORT = Number(process.env.PORT) || 3000;
const WEB_DIR = join(__dirname, '..', '..', 'web');

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    if (path === '/') {
      const html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (path === '/api/projects') return json(res, 200, await reader.listProjects());

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/sessions$/))) {
      return json(res, 200, await reader.listSessions(decodeURIComponent(m[1])));
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/))) {
      return json(res, 200, await reader.readSessionMessages(decodeURIComponent(m[1]), decodeURIComponent(m[2])));
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