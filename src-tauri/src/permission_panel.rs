use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
use tauri_nspanel::{ManagerExt, WebviewWindowExt};
#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(PermissionPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true,
            hides_on_deactivate: false,
            becomes_key_only_if_needed: true
        }
    })
}

const LABEL: &str = "permission-panel";
const PAGE: &str = "/computer-permission.html";

fn local_page(url: &tauri::Url) -> bool {
    ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")))
        && url.path() == PAGE
}

pub fn geometry(app: &AppHandle) -> Result<Value, String> {
    let main = app.get_webview_window("main").ok_or("主窗口已关闭")?;
    // Window enumeration can be unavailable before screen authorization; placement still works.
    #[cfg(target_os = "macos")]
    let settings_pids: Vec<u32> = tauri_nspanel::objc2_app_kit::NSRunningApplication::runningApplicationsWithBundleIdentifier(
        &tauri_nspanel::objc2_foundation::NSString::from_str("com.apple.systempreferences")
    ).iter().map(|app| app.processIdentifier() as u32).collect();
    let settings = xcap::Window::all().ok().and_then(|windows| {
        windows.into_iter().find_map(|window| {
            #[cfg(target_os = "macos")]
            if !settings_pids.contains(&window.pid().ok()?) { return None; }
            #[cfg(not(target_os = "macos"))]
            { return None; }
            if window.width().ok()? < 200 || window.height().ok()? < 180 || window.is_minimized().ok()? { return None; }
            Some(json!({"x":window.x().ok()?,"y":window.y().ok()?,"width":window.width().ok()?,"height":window.height().ok()?}))
        })
    });
    let monitor = if let Some(settings) = &settings {
        main.monitor_from_point(
            settings["x"].as_f64().unwrap_or(0.),
            settings["y"].as_f64().unwrap_or(0.),
        )
    } else {
        main.current_monitor()
    }
    .map_err(|e| e.to_string())?
    .or(main.primary_monitor().map_err(|e| e.to_string())?)
    .ok_or("无法识别显示器")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    Ok(
        json!({"settings":settings,"area":{"x":area.position.x as f64/scale,"y":area.position.y as f64/scale,"width":area.size.width as f64/scale,"height":area.size.height as f64/scale}}),
    )
}

pub fn open(app: &AppHandle, html: &str, bounds: &Value) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("此授权引导仅适用于 macOS".into());
    }
    let number = |key: &str| {
        bounds[key]
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or("授权助手位置无效")
    };
    let (x, y, width, height) = (
        number("x")?,
        number("y")?,
        number("width")?,
        number("height")?,
    );
    // UI markup is supplied by the same local renderer as Electron. Only this fixed page gets
    // the four narrow commands below; it cannot invoke the execution core or supply file paths.
    let script = format!(
        r#"(()=>{{
      document.documentElement.innerHTML={html};
      const act=action=>window.__TAURI_INTERNALS__.invoke('permission_action',{{action}})
        .catch(error=>document.querySelector('#feedback').textContent=String(error));
      document.querySelector('#application').addEventListener('mousedown',event=>{{if(event.button===0){{event.preventDefault();act('drag')}}}});
      document.querySelector('#application').addEventListener('dragstart',event=>event.preventDefault());
      document.querySelector('#close').addEventListener('click',()=>act('close'));
      document.querySelector('#reveal').addEventListener('click',()=>act('reveal'));
      document.querySelector('header').addEventListener('mousedown',event=>{{if(event.button===0 && !event.target.closest('button'))act('move')}});
    }})();"#,
        html = json!(html)
    );
    if let Some(window) = app.get_webview_window(LABEL) {
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        window.eval(script).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        {
            let panel = app.get_webview_panel(LABEL).map_err(|e| format!("{e:?}"))?;
            app.run_on_main_thread(move || panel.show())
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App(PAGE.trim_start_matches('/').into()),
    )
    .title("CoSail授权助手")
    .inner_size(width, height)
    .position(x, y)
    .decorations(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .visible(false)
    .focused(false)
    .focusable(false)
    .accept_first_mouse(true)
    .disable_drag_drop_handler()
    .initialization_script(format!(
        "document.addEventListener('DOMContentLoaded',()=>{{{script}}});"
    ))
    .on_navigation(local_page)
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
    .build()
    .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let source = window.clone();
        window
            .run_on_main_thread(move || {
                let result = (|| {
                    let panel = source
                        .to_panel::<PermissionPanel>()
                        .map_err(|e| e.to_string())?;
                    panel
                        .add_style_mask(
                            tauri_nspanel::StyleMask::empty()
                                .nonactivating_panel()
                                .value(),
                        )
                        .map_err(|e| e.to_string())?;
                    panel.set_collection_behavior(
                        tauri_nspanel::CollectionBehavior::new()
                            .can_join_all_spaces()
                            .full_screen_auxiliary()
                            .transient()
                            .ignores_cycle()
                            .value() | tauri_nspanel::objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllApplications,
                    );
                    panel.show();
                    Ok::<_, String>(())
                })();
                let _ = send.send(result);
            })
            .map_err(|e| e.to_string())?;
        receive.recv().map_err(|e| e.to_string())??;
    }
    Ok(())
}

#[tauri::command]
pub async fn permission_action(window: WebviewWindow, action: String) -> Result<(), String> {
    if window.label() != LABEL || !local_page(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted permission assistant".into());
    }
    match action.as_str() {
        "close" => {
            #[cfg(target_os = "macos")]
            {
                let panel = window
                    .app_handle()
                    .get_webview_panel(LABEL)
                    .map_err(|e| format!("{e:?}"))?;
                window
                    .run_on_main_thread(move || panel.hide())
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        "move" => window.start_dragging().map_err(|e| e.to_string()),
        "reveal" => window
            .app_handle()
            .opener()
            .reveal_item_in_dir(crate::computer::application(window.app_handle())?)
            .map_err(|e| e.to_string()),
        "drag" => {
            #[cfg(target_os = "macos")]
            {
                let path = crate::computer::application(window.app_handle())?;
                let icon = image::load_from_memory(include_bytes!("../../build/icon.png"))
                    .map_err(|e| e.to_string())?
                    .thumbnail(48, 48);
                let mut png = std::io::Cursor::new(Vec::new());
                icon.write_to(&mut png, image::ImageFormat::Png)
                    .map_err(|e| e.to_string())?;
                let (send, receive) = tokio::sync::oneshot::channel();
                let source = window.clone();
                let feedback = window.clone();
                window
                    .run_on_main_thread(move || {
                        let result = drag::start_drag(
                            &source,
                            drag::DragItem::Files(vec![path]),
                            drag::Image::Raw(png.into_inner()),
                            move |result, _| {
                                match result {
                                    drag::DragResult::Dropped => {
                                        if let Ok(panel) = feedback.app_handle().get_webview_panel(LABEL) {
                                            panel.hide();
                                        }
                                    }
                                    drag::DragResult::Cancel => {
                                        let _ = feedback.eval("document.querySelector('#feedback').textContent='已取消拖动，可重新拖入系统设置。'");
                                    }
                                }
                            },
                            drag::Options::default(),
                        )
                        .map_err(|e| e.to_string());
                        let _ = send.send(result);
                    })
                    .map_err(|e| e.to_string())?;
                receive.await.map_err(|_| "授权拖动已取消")?
            }
            #[cfg(not(target_os = "macos"))]
            Err("此授权引导仅适用于 macOS".into())
        }
        _ => Err("Unknown permission assistant action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permission_page_rejects_remote_and_other_local_windows() {
        for url in [
            "tauri://localhost/computer-permission.html",
            "http://tauri.localhost/computer-permission.html",
        ] {
            assert!(local_page(&tauri::Url::parse(url).unwrap()));
        }
        for url in [
            "https://example.com/computer-permission.html",
            "tauri://localhost/",
            "tauri://other/computer-permission.html",
            "tauri://localhost/computer-diagnostic.html",
        ] {
            assert!(!local_page(&tauri::Url::parse(url).unwrap()));
        }
    }
}
