// Tauri 主入口：注册 single-instance、注入 desktop bridge（init script）、拉起 sidecar、托盘、窗口控制命令。
mod desktop_log;
mod nodedl;
mod sidecar;
mod window_state;

use sidecar::{AppState, ServiceStatus, LogEntry};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

// 注入 window.__claudeWebuiDesktop，形状与 Electron preload 一致。
// 依赖 withGlobalTauri=true 暴露 window.__TAURI__.core.invoke / .event.listen。
const INIT_SCRIPT: &str = r#"
(function(){
  if (window.__claudeWebuiDesktop) return;
  var invoke = window.__TAURI__.core.invoke;
  var listen = window.__TAURI__.event.listen;
  window.__claudeWebuiDesktop = {
    kind: 'tauri',
    openWindow: function(p){ return invoke('desktop_open_window', { path: p }); },
    minimize: function(){ return invoke('desktop_minimize'); },
    toggleMaximize: function(){ return invoke('desktop_toggle_maximize'); },
    close: function(){ return invoke('desktop_close'); },
    setAlwaysOnTop: function(v){ return invoke('desktop_set_always_on_top', { v: v }); },
    isAlwaysOnTop: function(){ return invoke('desktop_is_always_on_top'); },
    pickDirectory: function(){ return invoke('desktop_pick_directory'); },
    service: {
      status: function(){ return invoke('service_status'); },
      start: function(){ return invoke('service_start'); },
      stop: function(){ return invoke('service_stop'); },
      restart: function(){ return invoke('service_restart'); },
      getLogs: function(){ return invoke('service_get_logs'); },
      onLog: function(cb){
        var u = listen('service:log', function(e){ cb(e.payload); });
        return function(){ u.then(function(un){ un(); }); };
      }
    }
  };
})();
"#;

fn label_for_route(path: &str) -> String {
    if path == "/" { "main".into() } else {
        path.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').to_string()
    }
}

async fn url_for_route(state: &AppState, path: &str) -> Result<String, String> {
    if cfg!(debug_assertions) {
        Ok(format!("http://localhost:5173{}", path))
    } else {
        let port = state.port().await.ok_or("sidecar 未就绪")?;
        Ok(format!("http://localhost:{}{}", port, path))
    }
}

async fn create_window(app: AppHandle, state: AppState, path: String) -> Result<(), String> {
    let label = label_for_route(&path);
    if let Some(w) = app.get_webview_window(&label) {
        w.set_focus().ok();
        return Ok(());
    }
    let url_str = url_for_route(&state, &path).await?;
    let url: tauri::Url = url_str.parse().map_err(|e: url::ParseError| e.to_string())?;
    let saved = window_state::load(&path);

    let mut builder = WebviewWindowBuilder::new(&app, label.clone(), WebviewUrl::External(url))
        .decorations(false)
        .initialization_script(INIT_SCRIPT)
        .title("");
    if let Some(s) = saved {
        builder = builder.inner_size(s.width as f64, s.height as f64)
            .position(s.x as f64, s.y as f64)
            .always_on_top(s.always_on_top);
    } else {
        builder = builder.inner_size(1280.0, 800.0);
    }
    let win = builder.build().map_err(|e| e.to_string())?;

    // 关闭时保存几何。
    let win_for_event = win.clone();
    let path2 = path.clone();
    win.on_window_event(move |ev| {
        if matches!(ev, tauri::WindowEvent::Destroyed) {
            if let (Ok(pos), Ok(size), Ok(aot)) = (win_for_event.outer_position(), win_for_event.inner_size(), win_for_event.is_always_on_top()) {
                window_state::save(&path2, &window_state::WindowState {
                    width: size.width,
                    height: size.height,
                    x: pos.x,
                    y: pos.y,
                    always_on_top: aot,
                });
            }
        }
    });
    let _ = state;
    Ok(())
}

#[tauri::command]
async fn desktop_open_window(path: String, state: tauri::State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    create_window(app, state.inner().clone(), path).await
}

#[tauri::command]
async fn desktop_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn desktop_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_set_always_on_top(v: bool, window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_always_on_top(v).map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_is_always_on_top(window: tauri::WebviewWindow) -> Result<bool, String> {
    Ok(window.is_always_on_top().unwrap_or(false))
}

#[tauri::command]
fn desktop_open_devtools(window: tauri::WebviewWindow) -> Result<(), String> {
    // 需 Cargo.toml 的 devtools feature（已启用，release 也可用）。
    window.open_devtools();
    Ok(())
}

#[tauri::command]
async fn desktop_pick_directory() -> Result<Option<String>, String> {
    // rfd 原生文件夹选择框（无父窗口也能弹）；返回选中绝对路径或 None（取消）。
    let handle = rfd::AsyncFileDialog::new().pick_folder().await;
    Ok(handle.map(|h| h.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn service_status(state: tauri::State<'_, AppState>) -> Result<ServiceStatus, String> {
    Ok(state.inner().status().await)
}

#[tauri::command]
async fn service_start(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    state.inner().start(app).await
}

#[tauri::command]
async fn service_stop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.inner().stop().await
}

#[tauri::command]
async fn service_restart(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    state.inner().restart(app).await
}

#[tauri::command]
async fn service_get_logs(state: tauri::State<'_, AppState>) -> Result<Vec<LogEntry>, String> {
    Ok(state.inner().get_logs().await)
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>).map_err(|e| e.to_string())?;
    let restart = MenuItem::with_id(app, "restart", "重启后端", true, None::<&str>).map_err(|e| e.to_string())?;
    let stop = MenuItem::with_id(app, "stop", "停止后端", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &restart, &stop, &quit]).map_err(|e| e.to_string())?;
    let icon = app.default_window_icon().cloned().ok_or("no icon")?;
    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("claude-webui")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_focus();
                } else {
                    let state = app.state::<AppState>().inner().clone();
                    let app3 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = create_window(app3, state, "/".into()).await;
                    });
                }
            }
            "restart" => {
                let state = app.state::<AppState>().inner().clone();
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = state.restart(app2).await;
                });
            }
            "stop" => {
                let state = app.state::<AppState>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = state.stop().await;
                });
            }
            "quit" => {
                let state = app.state::<AppState>().inner().clone();
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = state.stop().await;
                    app2.exit(0);
                });
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    desktop_log::init();
    log::info!(
        "tauri run: debug_assertions={}, target={}{}",
        cfg!(debug_assertions),
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            desktop_open_window, desktop_minimize, desktop_toggle_maximize,
            desktop_close, desktop_set_always_on_top, desktop_is_always_on_top, desktop_open_devtools, desktop_pick_directory,
            service_status, service_start, service_stop, service_restart, service_get_logs,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>().inner().clone();
            // 托盘
            if let Err(e) = build_tray(&handle) {
                log::error!("托盘构建失败: {e}");
            }
            // 异步：拉起 sidecar，再创建主窗口。
            let app2 = handle.clone();
            let state2 = state.clone();
            tauri::async_runtime::spawn(async move {
                state2.set_app(app2.clone()).await;
                if let Err(e) = state2.start(app2.clone()).await {
                    log::error!("sidecar 启动失败: {e}");
                }
                if let Err(e) = create_window(app2, state2, "/".into()).await {
                    log::error!("主窗口创建失败: {e}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}