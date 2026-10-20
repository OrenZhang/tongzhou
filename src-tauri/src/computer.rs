use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn status(app: &AppHandle) -> Value {
    #[cfg(target_os = "macos")]
    let (accessibility, screen) = unsafe {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXIsProcessTrusted() -> bool;
        }
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
        }
        (
            AXIsProcessTrusted(),
            if CGPreflightScreenCaptureAccess() {
                "granted"
            } else {
                "denied"
            },
        )
    };
    #[cfg(not(target_os = "macos"))]
    let (accessibility, screen) = (true, "available");
    json!({"permissionAssistant":cfg!(target_os="macos"),"supported":true,"platform":if cfg!(target_os="macos") {"darwin"} else if cfg!(windows) {"win32"} else {"linux"},"accessibility":accessibility,"screen":screen,"emergencyShortcut":app.state::<crate::desktop::Desktop>().shortcut.load(std::sync::atomic::Ordering::Relaxed)})
}
pub fn application(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if cfg!(target_os = "macos") {
        let directory = executable
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .ok_or("Application bundle unavailable")?;
        if directory.extension().is_none_or(|ext| ext != "app") {
            return Err("请使用 CoSail 应用包启动".into());
        }
        Ok(directory.to_owned())
    } else {
        let _ = app;
        Ok(executable)
    }
}
pub fn capture(id: u32, pid: u32) -> Result<Value, String> {
    // Never replace a missing/changed target with another window or a desktop screenshot.
    let window = xcap::Window::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.id().ok() == Some(id) && w.pid().ok() == Some(pid))
        .ok_or("窗口已关闭，请重新列出窗口")?;
    if window.is_minimized().map_err(|e| e.to_string())? {
        return Err("请先恢复目标窗口，再重新截图".into());
    }
    let bounds = json!({"x":window.x().map_err(|e|e.to_string())?,"y":window.y().map_err(|e|e.to_string())?,"width":window.width().map_err(|e|e.to_string())?,"height":window.height().map_err(|e|e.to_string())?});
    let image = window.capture_image().map_err(|e| e.to_string())?;
    if image.width() == 0 || image.height() == 0 {
        return Err("未获取目标窗口图像".into());
    }
    let image = image::DynamicImage::ImageRgba8(image)
        .thumbnail(1280, 960)
        .to_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 75)
        .encode_image(&image)
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"width":image.width(),"height":image.height(),"bounds":bounds,"mimeType":"image/jpeg","data":STANDARD.encode(bytes)}),
    )
}
pub fn diagnostic_open(app: &AppHandle, title: &str) -> Result<Value, String> {
    if let Some(window) = app.get_webview_window("computer-diagnostic") {
        window.close().map_err(|e| e.to_string())?;
    }
    let window = WebviewWindowBuilder::new(
        app,
        "computer-diagnostic",
        WebviewUrl::App("computer-diagnostic.html".into()),
    )
    .title(title)
    .inner_size(600., 300.)
    .initialization_script(format!(
        "document.addEventListener('DOMContentLoaded',()=>{{ document.title={}; }});",
        json!(title)
    ))
    .on_navigation(|url| {
        (url.scheme() == "tauri" && url.host_str() == Some("localhost")
            || matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost"))
            && url.path() == "/computer-diagnostic.html"
    })
    .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
    .build()
    .map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(json!({"pid":std::process::id()}))
}

/// Text is posted by the authorized native host, never its script subprocess.
pub fn type_text(
    app: &AppHandle,
    id: u32,
    pid: u32,
    title: &str,
    text: &str,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventCreateKeyboardEvent(
                source: *const c_void,
                key: u16,
                down: bool,
            ) -> *mut c_void;
            fn CGEventKeyboardSetUnicodeString(
                event: *mut c_void,
                length: usize,
                units: *const u16,
            );
            fn CGEventSetFlags(event: *mut c_void, flags: u64);
            fn CGEventPostToPid(pid: i32, event: *mut c_void);
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFRelease(value: *const c_void);
        }
        if status(app)["accessibility"] != true {
            return Err("请先为 CoSail 授予辅助功能权限".into());
        }
        if text.is_empty() || text.chars().count() > 32 || pid > i32::MAX as u32 {
            return Err("Invalid text input batch".into());
        }
        let window = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| {
                w.id().ok() == Some(id)
                    && w.pid().ok() == Some(pid)
                    && w.title().ok().as_deref() == Some(title)
            })
            .ok_or("目标窗口已改变，请重新截图")?;
        for character in text.chars() {
            if !window.is_focused().map_err(|e| e.to_string())? {
                return Err("目标窗口已失去焦点，已停止输入，请重新截图确认".into());
            }
            let mut buffer = [0u16; 2];
            let units = character.encode_utf16(&mut buffer);
            for down in [true, false] {
                unsafe {
                    let event = CGEventCreateKeyboardEvent(std::ptr::null(), 0, down);
                    if event.is_null() {
                        return Err("系统无法创建文字输入事件".into());
                    }
                    CGEventKeyboardSetUnicodeString(event, units.len(), units.as_ptr());
                    CGEventSetFlags(event, 0);
                    CGEventPostToPid(pid as i32, event);
                    CFRelease(event);
                }
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, pid, title, text);
        Err("Native text input is only available on macOS".into())
    }
}
