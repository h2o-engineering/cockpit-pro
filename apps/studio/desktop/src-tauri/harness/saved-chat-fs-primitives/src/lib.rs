//! Bounded compile harness: the Saved-Chat filesystem primitive modules,
//! included by path from the Desktop native crate, with their Tauri command
//! layer excluded through `cfg(h2o_saved_chat_primitive_harness)`.
//!
//! See `Cargo.toml` — compile evidence only, never certification.
#![allow(dead_code)]

#[path = "../../../src/archive_durable_write.rs"]
pub mod archive_durable_write;

#[path = "../../../src/archive_filesystem_capability.rs"]
pub mod archive_filesystem_capability;

#[path = "../../../src/archive_instance_lock.rs"]
pub mod archive_instance_lock;
