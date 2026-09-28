// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop binary entry point. The actual Tauri builder body lives in
// `lib.rs` so the same `run()` can be reused by future mobile targets.
fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() == 1
        && arguments[0].as_os_str() == std::ffi::OsStr::new("--h2o-build-identity-json")
    {
        let identity = h2o_studio_desktop_lib::build_identity::packaged_release_evidence_identity()
            .and_then(|value| serde_json::to_string(&value).map_err(|error| error.to_string()));
        match identity {
            Ok(json) => {
                println!("{json}");
                return;
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    h2o_studio_desktop_lib::run()
}
