// 窗口几何按路由持久化到 ~/.claude-webui/window-state.json。
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub always_on_top: bool,
}

fn claude_dir() -> PathBuf {
    std::env::var("CLAUDE_WEBUI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("no home").join(".claude-webui"))
}

fn state_file() -> PathBuf {
    claude_dir().join("window-state.json")
}

fn read_all() -> HashMap<String, WindowState> {
    std::fs::read_to_string(state_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn load(route: &str) -> Option<WindowState> {
    read_all().get(route).cloned()
}

pub fn save(route: &str, st: &WindowState) {
    let mut all = read_all();
    all.insert(route.to_string(), st.clone());
    let _ = std::fs::create_dir_all(claude_dir());
    let _ = std::fs::write(state_file(), serde_json::to_string_pretty(&all).unwrap_or_default());
}