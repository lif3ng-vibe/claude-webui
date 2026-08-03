// 桌面端持久化日志：把 `log::` 宏输出 + sidecar 子进程的 stdout/stderr 写到
// ~/.claude-webui/logs/desktop.log。release 下 windows_subsystem="windows" 没有控制台，
// sidecar 启动失败（拿不到端口→主窗口不创建）时，这个文件是唯一的排查线索。
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

fn claude_dir() -> PathBuf {
    std::env::var("CLAUDE_WEBUI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("no home").join(".claude-webui"))
}

/// 日志文件路径：~/.claude-webui/logs/desktop.log
pub fn path() -> &'static Path {
    LOG_PATH.get_or_init(|| claude_dir().join("logs").join("desktop.log"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct FileLogger;
impl log::Log for FileLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, r: &log::Record) {
        let line = format!("{} [{}] {}\n", now_ms(), r.level(), r.args());
        // 每行独立 append（启动期日志量小，规避跨线程文件句柄生命周期）。
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path()) {
            let _ = f.write_all(line.as_bytes());
        }
    }
    fn flush(&self) {}
}

/// 在 run() 最前面调用：建目录、写启动分隔、注册全局 logger。
pub fn init() {
    let _ = create_dir_all(path().parent().unwrap_or(Path::new(".")));
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path()) {
        let _ = writeln!(f, "\n========== claude-webui desktop 启动 (ts={}) ==========", now_ms());
    }
    let _ = log::set_logger(&FileLogger);
    log::set_max_level(log::LevelFilter::Info);
}
