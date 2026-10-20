use serde_json::{json, Value};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

fn string(value: &Value) -> Result<&str, String> {
    value.as_str().ok_or("Missing string argument".into())
}
fn label(id: &str) -> String {
    let mut hash = DefaultHasher::new();
    id.hash(&mut hash);
    format!("auth-{:x}", hash.finish())
}
fn dialog(app: &AppHandle, options: &Value) -> FileDialogBuilder<tauri::Wry> {
    let mut builder = app.dialog().file();
    if let Some(parent) = app.get_webview_window("main") {
        builder = builder.set_parent(&parent);
    }
    if let Some(title) = options["title"].as_str() {
        builder = builder.set_title(title);
    }
    if let Some(path) = options["defaultPath"].as_str() {
        let path = std::path::Path::new(path);
        if let Some(name) = path.file_name().and_then(|p| p.to_str()) {
            builder = builder.set_file_name(name);
        }
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            builder = builder.set_directory(parent);
        }
    }
    if let Some(filters) = options["filters"].as_array() {
        for filter in filters {
            let extensions: Vec<&str> = filter["extensions"]
                .as_array()
                .map(|v| v.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            builder = builder.add_filter(filter["name"].as_str().unwrap_or("Files"), &extensions);
        }
    }
    builder
}
fn paths(files: Option<Vec<FilePath>>) -> Result<Value, String> {
    let canceled = files.is_none();
    let files = files
        .unwrap_or_default()
        .into_iter()
        .map(|f| {
            f.into_path()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"canceled":canceled,"filePaths":files}))
}
fn safe_url(raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw).map_err(|e| e.to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
    {
        return Err("Unsafe authorization URL".into());
    }
    Ok(url)
}
pub async fn execute(app: &AppHandle, message: &Value) -> Result<Value, String> {
    let args = &message["args"];
    match message["method"].as_str().unwrap_or("") {
        "desktopInfo" => Ok(json!({"updatesConfigured":crate::updates::configured()})),
        method @ ("powerStatus" | "powerStart" | "powerStop") => {
            app.state::<crate::power::Power>()
                .call(method, args[0].as_u64().unwrap_or(0))
                .await
        }
        method @ ("updateCheck" | "updateDownload" | "updateInstall") => {
            crate::updates::execute(app, method).await
        }
        "permissionGeometry" => crate::permission_panel::geometry(app),
        "permissionPanel" => {
            crate::permission_panel::open(app, string(&args[0])?, &args[1])?;
            Ok(Value::Null)
        }
        "computerStatus" => Ok(crate::computer::status(app)),
        "computerType" => {
            let id = string(&args[0])?
                .parse::<u32>()
                .map_err(|_| "Invalid window id")?;
            let pid = u32::try_from(args[1].as_u64().ok_or("Invalid window PID")?)
                .map_err(|_| "Invalid window PID")?;
            let (title, text) = (string(&args[2])?.to_owned(), string(&args[3])?.to_owned());
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::computer::type_text(&app, id, pid, &title, &text)
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(json!({"ok":true}))
        }
        "computerCapture" => {
            let id = string(&args[0])?
                .parse::<u32>()
                .map_err(|_| "Invalid window id")?;
            let pid = u32::try_from(args[1].as_u64().ok_or("Invalid window PID")?)
                .map_err(|_| "Invalid window PID")?;
            if crate::computer::status(app)["screen"] == "denied" {
                return Err("请先在系统设置中授予屏幕录制权限".into());
            }
            tauri::async_runtime::spawn_blocking(move || crate::computer::capture(id, pid))
                .await
                .map_err(|e| e.to_string())?
        }
        "computerApplication" => Ok(
            json!({"path":crate::computer::application(app)?,"development":cfg!(debug_assertions)}),
        ),
        "computerReveal" => {
            app.opener()
                .reveal_item_in_dir(crate::computer::application(app)?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "computerSettings" => {
            if !cfg!(target_os = "macos") {
                return Err("此授权引导仅适用于 macOS".into());
            }
            let url = match string(&args[0])? {
                "accessibility" => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
                }
                "screen" => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
                }
                _ => return Err("未知的系统权限".into()),
            };
            app.opener()
                .open_url(url, None::<String>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "diagnosticOpen" => crate::computer::diagnostic_open(app, string(&args[0])?),
        "diagnosticRead" => {
            let window = app
                .get_webview_window("computer-diagnostic")
                .ok_or("自检窗口已关闭")?;
            Ok(json!(window
                .url()
                .map_err(|e| e.to_string())?
                .fragment()
                .unwrap_or("")))
        }
        "diagnosticClose" => {
            if let Some(window) = app.get_webview_window("computer-diagnostic") {
                window.close().map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }

        "openDialog" => {
            let properties = args[0]["properties"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let directory = properties.iter().any(|v| v == "openDirectory");
            let multiple = properties.iter().any(|v| v == "multiSelections");
            let builder = dialog(app, &args[0]);
            let (send, receive) = oneshot::channel();
            if directory && multiple {
                builder.pick_folders(move |files| {
                    let _ = send.send(files);
                });
            } else if directory {
                builder.pick_folder(move |file| {
                    let _ = send.send(file.map(|f| vec![f]));
                });
            } else if multiple {
                builder.pick_files(move |files| {
                    let _ = send.send(files);
                });
            } else {
                builder.pick_file(move |file| {
                    let _ = send.send(file.map(|f| vec![f]));
                });
            }
            paths(receive.await.map_err(|_| "File dialog closed")?)
        }
        "saveDialog" => {
            let (send, receive) = oneshot::channel();
            dialog(app, &args[0]).save_file(move |file| {
                let _ = send.send(file);
            });
            let file = receive.await.map_err(|_| "Save dialog closed")?;
            Ok(match file {
                None => json!({"canceled":true}),
                Some(file) => {
                    json!({"canceled":false,"filePath":file.into_path().map_err(|e| e.to_string())?.to_string_lossy()})
                }
            })
        }
        "openExternal" => {
            let url = tauri::Url::parse(string(&args[0])?).map_err(|e| e.to_string())?;
            if !matches!(url.scheme(), "https" | "http")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Only HTTP(S) URLs may be opened".into());
            }
            app.opener()
                .open_url(url.as_str(), None::<String>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "openPath" => {
            app.opener()
                .open_path(string(&args[0])?, None::<String>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "clipboard" => {
            let text = string(&args[0])?;
            app.clipboard()
                .write_text(text)
                .map_err(|e| e.to_string())?;
            if app.clipboard().read_text().map_err(|e| e.to_string())? != text {
                return Err("Clipboard verification failed".into());
            }
            Ok(Value::Null)
        }
        "theme" => {
            let theme = match string(&args[0])? {
                "system" => None,
                "light" => Some(tauri::Theme::Light),
                "dark" => Some(tauri::Theme::Dark),
                _ => return Err("Invalid theme".into()),
            };
            if let Some(window) = app.get_webview_window("main") {
                window.set_theme(theme).map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "restart" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                app.restart();
            });
            Ok(Value::Null)
        }
        "authOpen" => {
            let id = label(string(&args[0])?);
            if let Some(window) = app.get_webview_window(&id) {
                window.close().map_err(|e| e.to_string())?;
            }
            let url = safe_url(string(&args[1])?)?;
            let mut builder = WebviewWindowBuilder::new(app, id, WebviewUrl::External(url))
                .title("CoSail · 独立授权窗口")
                .inner_size(900., 760.)
                .incognito(true)
                .on_navigation(|url| safe_url(url.as_str()).is_ok())
                .on_download(|_, _| false)
                .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny);
            if args[2]["mode"] == "proxy" {
                let proxy =
                    tauri::Url::parse(string(&args[2]["proxyUrl"])?).map_err(|e| e.to_string())?;
                if proxy.scheme() != "http" {
                    return Err(
                        "Tauri 授权窗口暂仅支持 HTTP 代理；请使用设备码或 Electron。".into(),
                    );
                }
                builder = builder.proxy_url(proxy);
            }
            builder.build().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "authClose" => {
            if let Some(window) = app.get_webview_window(&label(string(&args[0])?)) {
                window.close().map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "authCloseAll" => {
            for (id, window) in app.webview_windows() {
                if id.starts_with("auth-") {
                    let _ = window.close();
                }
            }
            Ok(Value::Null)
        }
        _ => Err("Unknown native host operation".into()),
    }
}
