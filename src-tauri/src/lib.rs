use serde::Serialize;
use specta::Type;
use tauri_specta::{Builder, collect_commands};

#[derive(Debug, Clone, Serialize, Type)]
pub struct AppInfo {
    pub core_version: String,
    pub mcp_default_addr: String,
}

#[tauri::command]
#[specta::specta]
fn get_app_info() -> AppInfo {
    AppInfo {
        core_version: saphren_core::VERSION.to_string(),
        mcp_default_addr: format!(
            "http://{}{}",
            saphren_mcp::DEFAULT_BIND_ADDR,
            saphren_mcp::MCP_PATH
        ),
    }
}

fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![get_app_info])
}

#[cfg(any(debug_assertions, test))]
fn export_typescript_bindings(builder: &Builder<tauri::Wry>) {
    use specta_typescript::Typescript;

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.ts");
    builder
        .export(Typescript::default(), path)
        .expect("Failed to export TypeScript bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    export_typescript_bindings(&builder);

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_bindings() {
        let builder = specta_builder();
        export_typescript_bindings(&builder);
    }

    #[test]
    fn app_info_uses_core_and_mcp_defaults() {
        let info = get_app_info();
        assert_eq!(info.core_version, saphren_core::VERSION);
        assert_eq!(info.mcp_default_addr, "http://127.0.0.1:4721/mcp");
    }
}
