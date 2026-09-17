//! Immutable Saved-Chat local-backup root policy (Backup v1 T02, contract §3.1).
//!
//! `BACKUP_ROOT = <base>/H2O Studio Backups`, where `<base>` is resolved by
//! the SAME immutable mode enum the export-root policy uses: the home
//! directory in ordinary builds, and the identifier-scoped AppLocalData
//! directory only under the existing debug-only `saved-chat-v3-acceptance`
//! feature. No feature flag, environment variable, renderer input or
//! persisted preference selects the root; the renderer can query this policy
//! for display, but no command or request can select or mutate it.
//!
//! The root is CREATED only by the backup publisher's BEGIN (creating
//! admission, after declaration validation). LIST and VERIFY admit it
//! non-creating. This module resolves the path and nothing else: it performs
//! no filesystem access of its own.

use std::path::PathBuf;

pub const SAVED_CHAT_BACKUP_ROOT_POLICY_SCHEMA: &str =
    "h2o.studio.saved-chat-backup-root-policy.v1";
/// Fixed final component of the governed backup root (contract §3.2).
pub const BACKUP_ROOT_COMPONENT: &str = "H2O Studio Backups";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SavedChatBackupRoot {
    Home,
    AppLocalDataAcceptance,
}

impl SavedChatBackupRoot {
    /// Wire/display spelling of the base directory. Also the manifest's
    /// diagnostic `source.hostRootMode` value.
    pub const fn base_directory(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::AppLocalDataAcceptance => "appLocalData",
        }
    }
}

#[cfg(not(feature = "saved-chat-v3-acceptance"))]
pub const PRODUCTION_SAVED_CHAT_BACKUP_ROOT: SavedChatBackupRoot = SavedChatBackupRoot::Home;

#[cfg(feature = "saved-chat-v3-acceptance")]
pub const PRODUCTION_SAVED_CHAT_BACKUP_ROOT: SavedChatBackupRoot =
    SavedChatBackupRoot::AppLocalDataAcceptance;

pub const fn production_saved_chat_backup_root() -> SavedChatBackupRoot {
    PRODUCTION_SAVED_CHAT_BACKUP_ROOT
}

/// The governed backup root beneath a resolved base directory. Pure path
/// arithmetic: creates and inspects nothing.
pub fn backup_root_from_base(base: &std::path::Path) -> PathBuf {
    base.join(BACKUP_ROOT_COMPONENT)
}

/// Resolves the production backup root for the running app. The base comes
/// from Tauri's own resolver for the immutable mode; the renderer supplies
/// nothing.
pub fn production_backup_root(app: &tauri::AppHandle) -> Result<PathBuf, &'static str> {
    use tauri::Manager;

    let base = match production_saved_chat_backup_root() {
        SavedChatBackupRoot::Home => app.path().home_dir(),
        SavedChatBackupRoot::AppLocalDataAcceptance => app.path().app_local_data_dir(),
    }
    .map_err(|_| "backup-root-unavailable")?;
    Ok(backup_root_from_base(&base))
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatBackupRootPolicyResult {
    schema: &'static str,
    base_directory: &'static str,
    root_component: &'static str,
}

pub const fn production_policy() -> SavedChatBackupRootPolicyResult {
    SavedChatBackupRootPolicyResult {
        schema: SAVED_CHAT_BACKUP_ROOT_POLICY_SCHEMA,
        base_directory: PRODUCTION_SAVED_CHAT_BACKUP_ROOT.base_directory(),
        root_component: BACKUP_ROOT_COMPONENT,
    }
}

/// Read-only policy query (contract §9). Display only: it carries no path
/// authority and there is no setter.
#[tauri::command]
pub async fn h2o_saved_chat_backup_root_policy() -> SavedChatBackupRootPolicyResult {
    production_policy()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[cfg(not(feature = "saved-chat-v3-acceptance"))]
    #[test]
    fn default_build_uses_the_home_backup_root() {
        assert_eq!(
            production_saved_chat_backup_root(),
            SavedChatBackupRoot::Home
        );
        assert_eq!(production_policy().base_directory, "home");
    }

    #[cfg(feature = "saved-chat-v3-acceptance")]
    #[test]
    fn debug_acceptance_build_uses_app_local_data_backup_root() {
        assert!(cfg!(debug_assertions));
        assert_eq!(
            production_saved_chat_backup_root(),
            SavedChatBackupRoot::AppLocalDataAcceptance
        );
        assert_eq!(production_policy().base_directory, "appLocalData");
    }

    #[test]
    fn the_root_is_the_fixed_component_beneath_the_governed_base() {
        assert_eq!(
            backup_root_from_base(Path::new("/governed/home")),
            Path::new("/governed/home/H2O Studio Backups")
        );
        assert_eq!(BACKUP_ROOT_COMPONENT, "H2O Studio Backups");
        // The backup root is a sibling of, never nested inside, the export root.
        assert_ne!(
            BACKUP_ROOT_COMPONENT,
            crate::saved_chat_export_root_policy::EXPORT_ROOT_COMPONENT
        );
    }

    #[test]
    fn the_policy_mirrors_the_export_root_mode_enum() {
        // Both immutable policies must agree on the base directory in every
        // build, so the backup root can never land under a different base
        // than the export root of the same artifact.
        assert_eq!(
            production_saved_chat_backup_root().base_directory(),
            crate::saved_chat_export_root_policy::production_saved_chat_export_root()
                .base_directory()
        );
    }

    #[test]
    fn wire_contract_exposes_only_schema_base_directory_and_root_component() {
        let value = serde_json::to_value(production_policy()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert_eq!(value["schema"], SAVED_CHAT_BACKUP_ROOT_POLICY_SCHEMA);
        assert_eq!(
            value["baseDirectory"],
            PRODUCTION_SAVED_CHAT_BACKUP_ROOT.base_directory()
        );
        assert_eq!(value["rootComponent"], BACKUP_ROOT_COMPONENT);
    }

    #[test]
    fn read_only_command_has_debug_release_registration_parity_and_no_setter() {
        let lib = include_str!("lib.rs");
        assert_eq!(
            lib.matches("saved_chat_backup_root_policy::h2o_saved_chat_backup_root_policy")
                .count(),
            2,
            "one registration is required in each debug/release handler"
        );
        let source = include_str!("saved_chat_backup_root_policy.rs");
        let setter = ["set", "saved", "chat", "backup", "root"].join("_");
        let environment = ["std", "env"].join("::");
        let mutex = ["Mu", "tex"].concat();
        let filesystem = ["std", "fs"].join("::");
        assert!(!source.contains(&setter));
        assert!(!source.contains(&environment));
        assert!(!source.contains(&mutex));
        assert!(!source.contains(&filesystem));
    }
}
