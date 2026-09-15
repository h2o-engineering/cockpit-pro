# Saved-Chat filesystem-primitive compile harness (T02)

Compiles exactly `archive_durable_write.rs` (the `confined` facade with its
Unix and Windows back-ends), `archive_filesystem_capability.rs` and
`archive_instance_lock.rs` from `../../src`, with their Tauri command layer
excluded, for targets on which the whole Desktop crate cannot yet be checked.

```bash
cd apps/studio/desktop/src-tauri/harness/saved-chat-fs-primitives
cargo check --target x86_64-unknown-linux-gnu
cargo check --target x86_64-pc-windows-msvc
cargo test            # host only; the unit tests of the included modules
```

This is **compile evidence only** (contract §10: compile-time platform
support ≠ runtime capability ≠ native certification). It proves the arms
exist and type-check on each target; it never proves a primitive's behaviour
on a real filesystem — that is the Mission's T03 / T05 native certification.
