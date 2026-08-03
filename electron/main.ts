// Electron 主进程：拉起 node sidecar、管理窗口/托盘、注入 desktop bridge。
// dev：窗口指 Vite 5173，sidecar 用 tsx 跑源码（PORT=3000 对齐 Vite proxy）。
// prod：窗口指 http://localhost:<port>/，sidecar 跑 dist-server/server.js（PORT=0，握手回传实际端口）。
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from 'electron';
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream, mkdirSync, appendFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import { URL } from 'node:url';

const DEV = !!process.env.CLAUDE_WEBUI_DEV;
const ROOT = resolve(__dirname, '..'); // dev：仓库根；packaged：app.asar 根（仅 in-proc 可读，外部进程读不了）
// sidecar 由外部 node 进程运行，只能读真实文件：packaged 下经 asarUnpack 落到 app.asar.unpacked。
const REAL_ROOT = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : ROOT;
const WEB_DIR = process.env.CLAUDE_WEBUI_WEB_DIR || join(REAL_ROOT, 'web');
const DIST_SERVER = join(REAL_ROOT, 'dist-server', 'server.js');
const CLAUDE_DIR = process.env.CLAUDE_WEBUI_DIR || join(homedir(), '.claude-webui');
const CACHE_DIR = join(CLAUDE_DIR, 'cache');
const LOG_DIR = join(CLAUDE_DIR, 'logs');
const LOG_FILE = join(LOG_DIR, 'sidecar.log');
const MAIN_LOG = join(LOG_DIR, 'main.log');
const STATE_FILE = join(CLAUDE_DIR, 'window-state.json');

// 主进程自身日志：记录启动诊断 + 未捕获异常（否则 packaged 下错误只弹窗、无留痕，难排查）。
function logMain(level: string, msg: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(MAIN_LOG, `${new Date().toISOString()} [${level}] ${msg}\n`);
  } catch { /* 忽略日志自身失败 */ }
}
process.on('uncaughtException', (err) => logMain('error', `uncaughtException: ${err?.stack ?? String(err)}`));

const NODE_VERSION = 'v22.11.0';
const NODE_DIST = 'https://nodejs.org/dist';
const NODE_MIRROR = process.env.CLAUDE_WEBUI_NODE_MIRROR || 'https://npmmirror.com/mirrors/node';

// —— 状态 ——
let sidecar: ChildProcess | null = null;
let port: number | null = null;
let startedAt: number | null = null;
let pid: number | null = null;
const logBuffer: { ts: number; level: 'log' | 'error' | 'info'; msg: string }[] = [];
const logSubs = new Map<number, (e: { ts: number; level: string; msg: string }) => void>();
const windows = new Map<string, BrowserWindow>();
let tray: Tray | null = null;
let splash: BrowserWindow | null = null;

// ============ Node 运行时 bootstrap ============

function nodeArch(): string {
  // Node dist 命名：win-x64 / darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64
  const a = arch();
  if (a === 'arm64') return 'arm64';
  return 'x64';
}

function nodeArchiveName(): string {
  const p = platform();
  const a = nodeArch();
  if (p === 'win32') return `node-${NODE_VERSION}-win-${a}.zip`;
  if (p === 'darwin') return `node-${NODE_VERSION}-darwin-${a}.tar.gz`;
  return `node-${NODE_VERSION}-linux-${a}.tar.xz`;
}

function nodeBinaryInCache(): string {
  const p = platform();
  const a = nodeArch();
  const dir = join(CACHE_DIR, `node-${NODE_VERSION}-${p}-${a}`);
  // 解压后顶层目录名形如 node-v22.11.0-win-x64
  const extracted = join(CACHE_DIR, nodeArchiveName().replace(/\.(zip|tar\.gz|tar\.xz)$/, ''));
  const bin = p === 'win32' ? 'node.exe' : 'bin/node';
  return join(extracted, bin);
}

async function streamDownload(url: string, dest: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const get = (u: string) => {
      https.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, u).toString();
          res.resume();
          return get(next);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`下载失败 ${u} -> ${res.statusCode}`));
          return;
        }
        pipeline(res, createWriteStream(dest)).then(resolveP).catch(reject);
      }).on('error', reject);
    };
    get(url);
  });
}

async function fetchText(url: string): Promise<string> {
  return new Promise((resolveP, reject) => {
    const get = (u: string) => {
      https.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, u).toString());
        }
        if (res.statusCode !== 200) return reject(new Error(`下载 SHASUMS 失败: ${res.statusCode}`));
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolveP(body));
      }).on('error', reject);
    };
    get(url);
  });
}

async function verifySha256(file: string, expected: string): Promise<void> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  if (h.digest('hex') !== expected) throw new Error('SHA256 校验失败');
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await new Promise<void>((res, rej) => {
    // 现代 tar（Windows 10+ 的 tar.exe 是 bsdtar）统一 -xf 支持 zip/gz/xz。
    execFile('tar', ['-xf', archive, '-C', dest], (err) => (err ? rej(err) : res()));
  });
}

async function downloadNode(): Promise<string> {
  const archive = nodeArchiveName();
  const archivePath = join(CACHE_DIR, archive);
  await mkdir(CACHE_DIR, { recursive: true });
  let shasums: string;
  try {
    shasums = await fetchText(`${NODE_DIST}/${NODE_VERSION}/SHASUMS256.txt`);
  } catch {
    shasums = await fetchText(`${NODE_MIRROR}/${NODE_VERSION}/SHASUMS256.txt`);
  }
  const expected = shasums.split('\n').find((l) => l.endsWith(archive))?.split(/\s+/)[0];
  if (!expected) throw new Error(`SHASUMS 中找不到 ${archive}`);

  const tryDownload = async (base: string) => {
    await streamDownload(`${base}/${NODE_VERSION}/${archive}`, archivePath);
    await verifySha256(archivePath, expected);
  };
  try {
    await tryDownload(NODE_DIST);
  } catch {
    await tryDownload(NODE_MIRROR);
  }
  await extractArchive(archivePath, CACHE_DIR);
  return nodeBinaryInCache();
}

function checkNodeVersion(nodeExe: string): Promise<string | null> {
  return new Promise((res) => {
    execFile(nodeExe, ['-v'], (err, stdout) => {
      if (err) return res(null);
      const v = stdout.trim();
      const major = Number(v.replace(/^v/, '').split('.')[0]);
      res(major >= 18 ? v : null);
    });
  });
}

async function resolveNode(): Promise<string> {
  if (process.env.CLAUDE_WEBUI_NODE) return process.env.CLAUDE_WEBUI_NODE;
  const sysVer = await checkNodeVersion('node');
  if (sysVer) return 'node';
  const cached = nodeBinaryInCache();
  if (existsSync(cached)) {
    const v = await checkNodeVersion(cached);
    if (v) return cached;
  }
  showSplash();
  const downloaded = await downloadNode();
  return downloaded;
}

function showSplash(): void {
  if (splash) return;
  splash = new BrowserWindow({
    width: 360, height: 120, frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, center: true,
  });
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0;background:#1d1d1d;color:#ddd;font:13px/1.6 system-ui;display:flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid #333">' +
    '正在准备 Node 运行环境…</body>'));
}

// ============ Sidecar ============

function appendLog(level: 'log' | 'error' | 'info', msg: string): void {
  const e = { ts: Date.now(), level, msg };
  logBuffer.push(e);
  if (logBuffer.length > 5000) logBuffer.splice(0, logBuffer.length - 5000);
  appendFile(LOG_FILE, JSON.stringify(e) + '\n').catch(() => {});
  for (const cb of logSubs.values()) cb(e);
}

async function startSidecar(): Promise<void> {
  const nodeExe = await resolveNode();
  await mkdir(LOG_DIR, { recursive: true });
  const isDev = DEV;
  const args = isDev
    ? [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'server', 'index.ts')]
    : [DIST_SERVER];
  const env = {
    ...process.env,
    PORT: isDev ? '3000' : '0',
    CLAUDE_WEBUI_HANDSHAKE: '1',
    ...(isDev ? { CLAUDE_WEBUI_DEV: '1' } : { CLAUDE_WEBUI_BUNDLE: '1', CLAUDE_WEBUI_WEB_DIR: WEB_DIR }),
  };
  const child = spawn(nodeExe, args, { cwd: REAL_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  sidecar = child;
  pid = child.pid ?? null;

  await new Promise<void>((resolveP, reject) => {
    let resolved = false;
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = line.match(/^CLAUDE_WEBUI_PORT=(\d+)$/);
        if (m && !resolved) {
          resolved = true;
          port = Number(m[1]);
          startedAt = Date.now();
          resolveP();
        } else {
          appendLog('log', line);
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) appendLog('error', line);
    });
    child.on('exit', (code) => {
      appendLog('info', `sidecar exited code=${code}`);
      port = null;
      startedAt = null;
      sidecar = null;
      if (!resolved) reject(new Error('sidecar 启动失败'));
    });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('sidecar 握手超时'));
      }
    }, 15000);
  });

  if (splash) {
    splash.close();
    splash = null;
  }
}

async function stopSidecar(): Promise<void> {
  if (!sidecar) return;
  const c = sidecar;
  return new Promise<void>((res) => {
    c.once('exit', () => res());
    c.kill('SIGTERM');
    setTimeout(() => {
      if (!c.killed) c.kill('SIGKILL');
      res();
    }, 3000);
  });
}

async function restartSidecar(): Promise<void> {
  await stopSidecar();
  await startSidecar();
  reloadAllWindows();
}

// ============ 窗口 ============

async function loadWindowState(route: string): Promise<Record<string, unknown> | null> {
  try {
    const data = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return data[route] ?? null;
  } catch {
    return null;
  }
}

async function saveWindowState(route: string, w: BrowserWindow): Promise<void> {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch {}
  const anyWin = w as unknown as {
    getNormalSize(): [number, number];
    getNormalPosition(): [number, number];
    isAlwaysOnTop(): boolean;
  };
  data[route] = {
    width: anyWin.getNormalSize()[0],
    height: anyWin.getNormalSize()[1],
    x: anyWin.getNormalPosition()[0],
    y: anyWin.getNormalPosition()[1],
    alwaysOnTop: anyWin.isAlwaysOnTop(),
  };
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(data, null, 2));
}

function urlForRoute(route: string): string {
  if (DEV) return `http://localhost:5173${route}`;
  return `http://localhost:${port}${route}`;
}

async function createWindow(route: string): Promise<BrowserWindow> {
  const existing = windows.get(route);
  if (existing) {
    existing.focus();
    return existing;
  }
  const state = await loadWindowState(route);
  const w = new BrowserWindow({
    frame: false,
    width: (state?.width as number) ?? 1280,
    height: (state?.height as number) ?? 800,
    x: state?.x as number | undefined,
    y: state?.y as number | undefined,
    alwaysOnTop: !!state?.alwaysOnTop,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  windows.set(route, w);
  w.on('close', () => { void saveWindowState(route, w); });
  w.on('closed', () => windows.delete(route));
  await w.loadURL(urlForRoute(route));
  return w;
}

function reloadAllWindows(): void {
  for (const [route, w] of windows) {
    if (!w.isDestroyed()) w.loadURL(urlForRoute(route)).catch(() => {});
  }
}

// ============ 托盘 ============

function buildTray(): void {
  const iconPath = join(WEB_DIR, 'public', 'favicon.svg');
  const img = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('claude-webui');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => createWindow('/').then((w) => w.focus()) },
    { label: '重启后端', click: () => restartSidecar() },
    { label: '停止后端', click: () => stopSidecar() },
    { type: 'separator' },
    { label: '退出', click: () => { void stopSidecar().then(() => { tray?.destroy(); app.quit(); }); } },
  ]));
}

// ============ IPC ============

function setupIpc(): void {
  const senderFor = () => BrowserWindow.getFocusedWindow() ?? [...windows.values()][0];

  ipcMain.on('desktop:openWindow', (_e, path: string) => { void createWindow(path); });
  ipcMain.on('desktop:minimize', () => senderFor()?.minimize());
  ipcMain.on('desktop:toggleMaximize', () => {
    const w = senderFor();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on('desktop:close', () => senderFor()?.close());
  ipcMain.on('desktop:setAlwaysOnTop', (_e, v: boolean) => senderFor()?.setAlwaysOnTop(v));
  ipcMain.handle('desktop:isAlwaysOnTop', () => !!senderFor()?.isAlwaysOnTop());

  ipcMain.handle('service:status', () => ({
    running: !!sidecar && port !== null,
    port, pid, startedAt,
    uptimeMs: startedAt ? Date.now() - startedAt : 0,
  }));
  ipcMain.handle('service:start', async () => { if (!sidecar) await startSidecar(); });
  ipcMain.handle('service:stop', async () => { await stopSidecar(); });
  ipcMain.handle('service:restart', async () => { await restartSidecar(); });
  ipcMain.handle('service:getLogs', () => logBuffer.slice());
  ipcMain.on('service:onLog', (e, id: number) => { logSubs.set(id, (ev) => e.sender.send('service:log', id, ev)); });
  ipcMain.on('service:unsubLog', (_e, id: number) => { logSubs.delete(id); });
}

// ============ 生命周期 ============

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const main = windows.get('/');
    if (main) { if (main.isMinimized()) main.restore(); main.focus(); }
  });

  app.whenReady().then(async () => {
    setupIpc();
    logMain('info', `startup: DEV=${DEV} packaged=${app.isPackaged} REAL_ROOT=${REAL_ROOT}`);
    logMain('info', `paths: DIST_SERVER=${DIST_SERVER} exists=${existsSync(DIST_SERVER)} | web/dist/index exists=${existsSync(join(WEB_DIR, 'dist', 'index.html'))}`);
    try {
      await startSidecar();
    } catch (e) {
      appendLog('error', String(e));
      logMain('error', `startSidecar failed: ${String(e)}`);
    }
    await createWindow('/');
    buildTray();
  });

  // 桌面端：关最后一个窗口不退出（托盘常驻）。
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    // 不调用 app.quit()，托盘保活。
  });

  app.on('before-quit', () => {
    void stopSidecar();
  });
}