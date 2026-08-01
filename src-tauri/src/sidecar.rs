// Sidecar 生命周期：spawn node 子进程、握手读端口、捕获日志、提供 status/启停/重启。
// dev：tsx 跑源码，PORT=3000（对齐 Vite proxy）；prod：node 跑 dist-server/server.js，PORT=0 握手回传实际端口。
use crate::nodedl;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Clone, Serialize)]
pub struct LogEntry {
    pub ts: u64,
    pub level: String,
    pub msg: String,
}

#[derive(Serialize)]
pub struct ServiceStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub uptime_ms: u64,
    pub started_at: Option<u64>,
}

struct Inner {
    child: Option<Child>,
    port: Option<u16>,
    started_at: Option<u64>,
    log_buffer: VecDeque<LogEntry>,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<Inner>>,
    app: Arc<Mutex<Option<AppHandle>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                child: None, port: None, started_at: None,
                log_buffer: VecDeque::with_capacity(4096),
            })),
            app: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn set_app(&self, app: AppHandle) {
        self.app.lock().await.replace(app);
    }

    pub async fn port(&self) -> Option<u16> {
        self.inner.lock().await.port
    }

    pub async fn get_logs(&self) -> Vec<LogEntry> {
        self.inner.lock().await.log_buffer.iter().cloned().collect()
    }

    async fn append_log(&self, level: &str, msg: String) {
        let entry = LogEntry { ts: now_ms(), level: level.into(), msg };
        {
            let mut g = self.inner.lock().await;
            g.log_buffer.push_back(entry.clone());
            let len = g.log_buffer.len();
            if len > 5000 {
                g.log_buffer.drain(0..len - 5000);
            }
        }
        if let Some(app) = self.app.lock().await.clone() {
            let _ = app.emit("service:log", entry);
        }
    }

    pub async fn status(&self) -> ServiceStatus {
        let g = self.inner.lock().await;
        let running = g.child.is_some() && g.port.is_some();
        ServiceStatus {
            running,
            port: g.port,
            pid: g.child.as_ref().and_then(|c| c.id()),
            started_at: g.started_at,
            uptime_ms: g.started_at.map(|s| now_ms().saturating_sub(s)).unwrap_or(0),
        }
    }

    pub async fn start(&self, app: AppHandle) -> Result<(), String> {
        {
            let g = self.inner.lock().await;
            if g.child.is_some() {
                return Ok(());
            }
        }
        spawn_sidecar(app, self.clone()).await
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut g = self.inner.lock().await;
        if let Some(mut child) = g.child.take() {
            g.port = None;
            g.started_at = None;
            let _ = child.start_kill();
            drop(g);
            self.append_log("info", "sidecar stopped".into()).await;
            tokio::spawn(async move { let _ = child.wait().await; });
        }
        Ok(())
    }

    pub async fn restart(&self, app: AppHandle) -> Result<(), String> {
        self.stop().await?;
        self.start(app).await
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

async fn spawn_sidecar(app: AppHandle, state: AppState) -> Result<(), String> {
    let node = nodedl::resolve_node().await?;

    let is_dev = cfg!(debug_assertions);
    let mut cmd = if is_dev {
        let root = project_root();
        let tsx = root.join("node_modules").join("tsx").join("dist").join("cli.mjs");
        let mut c = Command::new(node);
        c.arg(tsx).arg(root.join("src").join("server").join("index.ts"));
        c.current_dir(root);
        c.env("PORT", "3000");
        c.env("CLAUDE_WEBUI_HANDSHAKE", "1");
        c.env("CLAUDE_WEBUI_DEV", "1");
        c
    } else {
        let res = app.path().resource_dir().map_err(|e| e.to_string())?;
        let server = res.join("dist-server").join("server.js");
        let web_dir = res.join("web");
        // node-pty 作 resource 随包（见 tauri.conf.json resources），bundle 的 require('node-pty')
        // 经 NODE_PATH 解析：resource_dir 下（Tauri 保留 node_modules/node-pty 结构）与 node_modules 子目录都覆盖。
        let node_path = if cfg!(windows) {
            format!("{};{}\\node_modules", res.display(), res.display())
        } else {
            format!("{}:{}/node_modules", res.display(), res.display())
        };
        let mut c = Command::new(node);
        c.arg(&server);
        c.env("PORT", "0");
        c.env("CLAUDE_WEBUI_HANDSHAKE", "1");
        c.env("CLAUDE_WEBUI_BUNDLE", "1");
        c.env("CLAUDE_WEBUI_WEB_DIR", web_dir);
        c.env("NODE_PATH", node_path);
        c
    };

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("启动 sidecar 失败: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // 握手：先读 stdout 首个 CLAUDE_WEBUI_PORT=<n>（15s 超时），拿到端口后再起 drain 任务。
    let state_for_handshake = state.clone();
    let mut reader = BufReader::new(stdout);
    let mut got_port: Option<u16> = None;

    let handshake = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).await?;
            if n == 0 { break; }
            let trimmed = line.trim_end();
            if let Some(rest) = trimmed.strip_prefix("CLAUDE_WEBUI_PORT=") {
                if let Ok(p) = rest.trim().parse::<u16>() {
                    got_port = Some(p);
                    break;
                }
            }
            state_for_handshake.append_log("log", trimmed.to_string()).await;
        }
        Result::<(), std::io::Error>::Ok(())
    }).await;

    let _ = handshake;

    if handshake.is_err() {
        return Err("sidecar 握手超时".into());
    }
    if got_port.is_none() {
        return Err("sidecar 未回传端口".into());
    }

    {
        let mut g = state.inner.lock().await;
        g.port = got_port;
        g.started_at = Some(now_ms());
        g.child = Some(child);
    }

    // 握手后剩余 stdout drain。
    let state_for_drain = state.clone();
    tokio::spawn(async move {
        let mut reader = reader;
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).await.unwrap_or(0);
            if n == 0 { break; }
            let trimmed = line.trim_end();
            if !trimmed.is_empty() {
                state_for_drain.append_log("log", trimmed.to_string()).await;
            }
        }
    });

    // stderr drain。
    let state_for_err = state.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).await.unwrap_or(0);
            if n == 0 { break; }
            let trimmed = line.trim_end();
            if !trimmed.is_empty() {
                state_for_err.append_log("error", trimmed.to_string()).await;
            }
        }
    });

    Ok(())
}