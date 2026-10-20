fn main() {
    println!("cargo:rerun-if-env-changed=TONGZHOU_TAURI_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=TONGZHOU_TAURI_UPDATE_URL");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["core_call", "core_ready", "permission_action"]),
    ))
    .expect("Tauri build configuration failed");
}
