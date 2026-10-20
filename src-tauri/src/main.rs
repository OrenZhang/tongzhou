mod computer;
mod core;
mod desktop;
mod host;
mod permission_panel;
mod power;
mod updates;
use core::Core;
use serde_json::{json, Value};
use tauri::{Manager, WebviewWindow};

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if window.label() == "main"
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")))
    {
        Ok(())
    } else {
        Err("Untrusted core caller".into())
    }
}
#[tauri::command]
async fn core_ready(window: WebviewWindow, core: tauri::State<'_, Core>) -> Result<(), String> {
    trusted(&window)?;
    tokio::time::timeout(std::time::Duration::from_secs(30), core.ready())
        .await
        .map_err(|_| "Core startup timed out")?
}
#[tauri::command]
async fn core_call(
    window: WebviewWindow,
    core: tauri::State<'_, Core>,
    method: String,
    args: Vec<Value>,
    undefined_args: Vec<usize>,
) -> Result<Value, String> {
    trusted(&window)?;
    if core.is_closing()
        || window
            .app_handle()
            .state::<updates::Updates>()
            .installing
            .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("应用正在退出".into());
    }
    core.ready().await?;
    core.request(
        json!({"type":"invoke","method":method,"args":args,"undefinedArgs":undefined_args}),
    )
    .await
}
fn main() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    let app = builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            desktop::show(app)
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            core_call,
            core_ready,
            permission_panel::permission_action
        ])
        .setup(|app| {
            app.manage(power::Power::new());
            app.manage(updates::Updates::default());
            desktop::setup(app.handle())?;
            app.manage(Core::spawn(app.handle())?);
            #[cfg(unix)]
            for kind in [
                tokio::signal::unix::SignalKind::terminate(),
                tokio::signal::unix::SignalKind::interrupt(),
            ] {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(mut signal) = tokio::signal::unix::signal(kind) {
                        signal.recv().await;
                        handle.exit(0);
                    }
                });
            }
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(|url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost"))
                })
                .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
                .build()?;
            let handle = app.handle().clone();
            app.get_webview_window("main")
                .unwrap()
                .on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if !handle.state::<Core>().is_closing()
                            && handle.tray_by_id("cosail").is_some()
                        {
                            api.prevent_close();
                            if let Some(window) = handle.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                    }
                });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri startup failed");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            desktop::show(app);
        }
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            let core = app.state::<Core>().inner().clone();
            if !core.exit_ready() {
                api.prevent_exit();
                if !core.begin_close() {
                    return;
                }
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    core.shutdown().await;
                    let installed = updates::install_pending(&app).await;
                    core.allow_exit();
                    match installed {
                        Ok(true) => {
                            app.restart();
                        }
                        Err(error) => {
                            use tauri_plugin_dialog::DialogExt;
                            app.dialog()
                                .message(format!("更新安装未完成，将重新启动客户端：{error}"))
                                .blocking_show();
                            app.restart();
                        }
                        Ok(false) => {}
                    }
                    if code == Some(tauri::RESTART_EXIT_CODE) {
                        app.restart();
                    } else {
                        app.exit(code.unwrap_or(0));
                    }
                });
            }
        }
    });
}
