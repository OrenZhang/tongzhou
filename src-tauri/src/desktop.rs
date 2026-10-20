use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub struct Desktop {
    pub shortcut: AtomicBool,
    open: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}
pub fn show(app: &AppHandle) {
    if let Some(core) = app.try_state::<crate::core::Core>() {
        if core.is_closing() {
            return;
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
pub fn language(app: &AppHandle, language: &str) {
    if let Some(state) = app.try_state::<Desktop>() {
        let english = language == "en";
        let _ = state.open.set_text(if english {
            "Open CoSail"
        } else {
            "打开 CoSail"
        });
        let _ = state.quit.set_text(if english {
            "Quit CoSail"
        } else {
            "退出 CoSail"
        });
    }
}
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", "打开 CoSail", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 CoSail", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(Desktop {
        shortcut: AtomicBool::new(false),
        open,
        quit,
    });
    TrayIconBuilder::with_id("cosail")
        .icon(
            app.default_window_icon()
                .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?
                .clone(),
        )
        .tooltip("CoSail")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    let registered = app
        .global_shortcut()
        .on_shortcut("CommandOrControl+Alt+Escape", |app, _, event| {
            if event.state == ShortcutState::Pressed {
                if let Some(core) = app.try_state::<crate::core::Core>() {
                    core.host_event("emergencyStop", serde_json::Value::Null);
                }
            }
        })
        .is_ok();
    app.state::<Desktop>()
        .shortcut
        .store(registered, Ordering::Relaxed);
    Ok(())
}
