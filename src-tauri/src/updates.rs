use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

pub struct Updates {
    staged: Mutex<(Option<Update>, Option<Vec<u8>>)>,
    pub installing: AtomicBool,
}
impl Default for Updates {
    fn default() -> Self {
        Self {
            staged: Mutex::new((None, None)),
            installing: AtomicBool::new(false),
        }
    }
}
const ENDPOINT: &str =
    "https://github.com/OrenZhang/tongzhou/releases/latest/download/tauri-latest.json";
pub fn configured() -> bool {
    option_env!("TONGZHOU_TAURI_UPDATER_PUBLIC_KEY").is_some_and(|key| !key.trim().is_empty())
}
fn publisher() -> Result<(String, tauri::Url), String> {
    let key = option_env!("TONGZHOU_TAURI_UPDATER_PUBLIC_KEY")
        .filter(|key| !key.trim().is_empty())
        .ok_or("Tauri 预览尚未配置更新签名公钥；请使用构建流程生成签名更新包")?;
    let url = tauri::Url::parse(option_env!("TONGZHOU_TAURI_UPDATE_URL").unwrap_or(ENDPOINT))
        .map_err(|e| e.to_string())?;
    trusted_download(&url)?;
    Ok((key.into(), url))
}
fn trusted_download(url: &tauri::Url) -> Result<(), String> {
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("更新仅接受无内嵌凭据的 HTTPS 地址".into());
    }
    Ok(())
}
pub async fn execute(app: &AppHandle, method: &str) -> Result<Value, String> {
    let state = app.state::<Updates>();
    match method {
        "updateCheck" => {
            if state.installing.load(Ordering::SeqCst) {
                return Err("更新正在安装".into());
            }
            let (key, url) = publisher()?;
            let mut staged = state.staged.lock().await;
            let builder = app
                .updater_builder()
                .pubkey(key)
                .endpoints(vec![url])
                .map_err(|e| e.to_string())?
                .timeout(std::time::Duration::from_secs(60));
            #[cfg(windows)]
            let builder = builder.on_before_exit({
                let handle = app.clone();
                move || tauri_plugin_single_instance::destroy(&handle)
            });
            let update = builder
                .build()
                .map_err(|e| e.to_string())?
                .check()
                .await
                .map_err(|e| e.to_string())?;
            if let Some(update) = &update {
                trusted_download(&update.download_url)?;
                // Preserve the existing stable-only policy; do not alter Tauri's downgrade check.
                if update.version.split('+').next().unwrap_or("").contains('-') {
                    return Err("更新源返回了预发布版本，已忽略".into());
                }
            }
            let result = update
                .as_ref()
                .map(|u| json!({"version":u.version}))
                .unwrap_or(Value::Null);
            *staged = (update, None);
            Ok(result)
        }
        "updateDownload" => {
            let mut staged = state.staged.lock().await;
            let update = staged.0.as_ref().ok_or("请先检查更新")?;
            let mut downloaded = 0u64;
            let bytes=update.download(|chunk,total| {
                downloaded+=chunk as u64;
                if let Some(total)=total.filter(|n|*n>0) { app.state::<crate::core::Core>().host_event("updateProgress",json!({"percent":((downloaded as f64 / total as f64)*100.).min(100.)})); }
            },||{}).await.map_err(|e|e.to_string())?;
            // download() verifies the publisher signature before returning bytes.
            staged.1 = Some(bytes);
            Ok(Value::Null)
        }
        "updateInstall" => {
            let staged = state.staged.lock().await;
            if staged.0.is_none() || staged.1.is_none() {
                return Err("尚无已校验的更新包".into());
            }
            if state.installing.swap(true, Ordering::SeqCst) {
                return Err("更新正在安装".into());
            }
            // Reply to the current Node request first. ExitRequested drains the shared core
            // before installing, including Windows installers that exit the process directly.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                app.exit(0);
            });
            Ok(Value::Null)
        }
        _ => Err("Unknown update operation".into()),
    }
}
pub async fn install_pending(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<Updates>();
    if !state.installing.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let mut staged = state.staged.lock().await;
    let update = staged.0.take().ok_or("更新信息已失效")?;
    let bytes = staged.1.take().ok_or("更新包已失效")?;
    drop(staged);
    tauri::async_runtime::spawn_blocking(move || update.install(bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_urls_require_tls_and_no_embedded_credentials() {
        for url in [
            "http://example.com/update",
            "https://user:token@example.com/update",
            "file:///tmp/update",
        ] {
            assert!(trusted_download(&tauri::Url::parse(url).unwrap()).is_err());
        }
        assert!(trusted_download(&tauri::Url::parse(ENDPOINT).unwrap()).is_ok());
    }
}

#[cfg(test)]
mod signed_download_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };
    /// Uses only an ephemeral key and a loopback artifact; never installs or replaces an app.
    #[test]
    #[ignore = "run through scripts/testing/tauri-desktop-smoke.mjs to generate a disposable signing key"]
    fn verifies_signed_download_and_rejects_tampering_and_version_replay() {
        let directory = std::path::PathBuf::from(
            std::env::var_os("TONGZHOU_TEST_UPDATE_DIR").expect("fixture directory"),
        );
        let public_key = std::fs::read_to_string(directory.join("key.pub")).unwrap();
        let signature = std::fs::read_to_string(directory.join("payload.sig")).unwrap();
        let payload = std::fs::read(directory.join("payload")).unwrap();
        let expected = payload.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let changed = Arc::new(AtomicBool::new(false));
        let replay = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (changed_server, replay_server, stopping) =
            (changed.clone(), replay.clone(), stop.clone());
        let server = std::thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                };
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0; 4096];
                let length = stream.read(&mut request).unwrap_or(0);
                let body = if String::from_utf8_lossy(&request[..length])
                    .starts_with("GET /artifact ")
                {
                    if changed_server.load(Ordering::Relaxed) {
                        b"TAMPERED".to_vec()
                    } else {
                        payload.clone()
                    }
                } else {
                    serde_json::to_vec(&json!({"version":if replay_server.load(Ordering::Relaxed){"2.0.1"}else{"2.0.0"},"url":format!("http://{address}/artifact"),"signature":signature.trim()})).unwrap()
                };
                let _=write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                let _ = stream.write_all(&body);
            }
        });
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        // HTTP is confined to this mock test configuration; shipped code requires HTTPS.
        context.config_mut().plugins.0.insert("updater".into(),json!({"pubkey":public_key.trim(),"dangerousInsecureTransportProtocol":true,"requireSignedVersion":true}));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        tauri::async_runtime::block_on(async {
            let updater = app
                .updater_builder()
                .no_proxy()
                .endpoints(vec![format!("http://{address}/latest").parse().unwrap()])
                .unwrap()
                .build()
                .unwrap();
            let update = updater.check().await.unwrap().unwrap();
            assert_eq!(update.download(|_, _| {}, || {}).await.unwrap(), expected);
            changed.store(true, Ordering::Relaxed);
            assert!(update.download(|_, _| {}, || {}).await.is_err());
            changed.store(false, Ordering::Relaxed);
            replay.store(true, Ordering::Relaxed);
            let replayed = updater.check().await.unwrap().unwrap();
            assert!(replayed.download(|_, _| {}, || {}).await.is_err());
        });
        stop.store(true, Ordering::Relaxed);
        server.join().unwrap();
    }
}
