// Sets the harness cfg so the included modules omit their Tauri command layer.
fn main() {
    println!("cargo:rustc-check-cfg=cfg(h2o_saved_chat_primitive_harness)");
    println!("cargo:rustc-cfg=h2o_saved_chat_primitive_harness");
}
