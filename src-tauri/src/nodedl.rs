// Node 运行时 bootstrap：优先系统 node（≥18），缺失则下载固定 Node 22 LTS。
// 与 Electron 的 JS bootstrap 对称：官方源 + npmmirror 备选 + SHA256 校验 + 系统 tar 解压。
use std::path::{Path, PathBuf};
use std::process::Command;

const NODE_VERSION: &str = "v22.11.0";
const NODE_DIST: &str = "https://nodejs.org/dist";
const NODE_MIRROR: &str = "https://npmmirror.com/mirrors/node";

fn claude_dir() -> PathBuf {
    std::env::var("CLAUDE_WEBUI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("no home").join(".claude-webui"))
}

fn cache_dir() -> PathBuf {
    claude_dir().join("cache")
}

fn platform_arch() -> (&'static str, &'static str) {
    let p = if cfg!(target_os = "windows") { "win" }
        else if cfg!(target_os = "macos") { "darwin" }
        else { "linux" };
    let a = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    (p, a)
}

fn archive_name() -> String {
    let (p, a) = platform_arch();
    let ext = if p == "win" { "zip" } else if p == "darwin" { "tar.gz" } else { "tar.xz" };
    format!("node-{}-{}-{}.{}", NODE_VERSION, p, a, ext)
}

fn extracted_dir_name() -> String {
    let (p, a) = platform_arch();
    format!("node-{}-{}-{}", NODE_VERSION, p, a)
}

fn node_binary_in_cache() -> PathBuf {
    let bin = if cfg!(target_os = "windows") { "node.exe" } else { "bin/node" };
    cache_dir().join(extracted_dir_name()).join(bin)
}

fn check_version(node: &Path) -> Option<String> {
    let out = Command::new(node).arg("-v").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let major: i32 = v.trim_start_matches('v').split('.').next()?.parse().ok()?;
    if major >= 18 { Some(v) } else { None }
}

pub async fn resolve_node() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("CLAUDE_WEBUI_NODE") {
        return Ok(PathBuf::from(p));
    }
    // 尝试从 PATH 中找到 node 的绝对路径
    if let Ok(node_path) = which::which("node") {
        if let Some(_v) = check_version(&node_path) {
            return Ok(node_path);
        }
    }
    let cached = node_binary_in_cache();
    if cached.exists() && check_version(&cached).is_some() {
        return Ok(cached);
    }
    download_node().await
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(false)
        .build().map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("获取 SHASUMS 失败: {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn stream_to_file(url: &str, dest: &Path) -> Result<(), String> {
    use futures_util::StreamExt;
    let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("下载失败 {}: {}", url, resp.status()));
    }
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let status = Command::new("tar")
        .arg("-xf").arg(archive).arg("-C").arg(dest)
        .status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("解压失败: tar exit {:?}", status.code()));
    }
    Ok(())
}

async fn download_node() -> Result<PathBuf, String> {
    let archive = archive_name();
    let archive_path = cache_dir().join(&archive);
    std::fs::create_dir_all(cache_dir()).map_err(|e| e.to_string())?;

    let shasums = match fetch_text(&format!("{}/{}/SHASUMS256.txt", NODE_DIST, NODE_VERSION)).await {
        Ok(s) => s,
        Err(_) => fetch_text(&format!("{}/{}/SHASUMS256.txt", NODE_MIRROR, NODE_VERSION)).await?,
    };
    let expected = shasums
        .lines()
        .find(|l| l.ends_with(&archive))
        .and_then(|l| l.split_whitespace().next())
        .ok_or_else(|| format!("SHASUMS 中找不到 {}", archive))?
        .to_string();

    async fn try_dl(base: &str, archive: &str, archive_path: &std::path::Path, expected: &str) -> Result<(), String> {
        let url = format!("{}/{}/{}", base, NODE_VERSION, archive);
        stream_to_file(&url, archive_path).await?;
        if sha256_file(archive_path)? != expected {
            return Err("SHA256 校验失败".into());
        }
        Ok(())
    }
    if let Err(e) = try_dl(NODE_DIST, &archive, &archive_path, &expected).await {
        log::warn!("官方源下载失败，回退 npmmirror: {}", e);
        try_dl(NODE_MIRROR, &archive, &archive_path, &expected).await?;
    }
    extract(&archive_path, &cache_dir())?;
    Ok(node_binary_in_cache())
}