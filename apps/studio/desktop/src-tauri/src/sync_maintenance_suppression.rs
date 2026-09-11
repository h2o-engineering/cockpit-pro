/*
 * Governed Desktop maintenance suppression.
 *
 * Purpose: let the governed Desktop runtime start for a state-integrity
 * campaign (for example applying a pending SQLite migration) while the
 * accepted P01 automatic writer is incapable of scheduling or performing any
 * mutation - WITHOUT touching the user's persisted Sync configuration.
 *
 * The authority is deliberately ephemeral process state read from the launch
 * environment exactly once. It is never persisted, never written back, and
 * cannot be set from inside the running product: a campaign engages it by
 * launching the binary with the exact token, and it disappears when the
 * process exits. Persisted `mode` keeps its canonical meaning; this only
 * removes mutation capability for the lifetime of one process.
 *
 * Runtime evidence: the command below emits one non-persistent structured
 * line on stderr each time it is dispatched. A `#[tauri::command]` handler is
 * reachable only over the webview IPC, and this command has no in-process Rust
 * caller, so the line is itself proof that the packaged JS gate reached this
 * native authority - the very step a black-box campaign could not otherwise
 * observe. The evidence writes no database row, no file and no configuration.
 */

use std::env;
use std::io::Write;
use std::sync::OnceLock;

use serde::Serialize;

/* Exact opt-in. A generic truthy value is deliberately NOT accepted, so the
 * mechanism cannot be engaged by an accidental or inherited environment. */
pub const MAINTENANCE_SUPPRESSION_ENV: &str = "H2O_STUDIO_SYNC_MAINTENANCE_SUPPRESS";
pub const MAINTENANCE_SUPPRESSION_TOKEN: &str = "governed-maintenance-suppression-v1";

/* Stable prefix a campaign greps for in captured runtime output. */
pub const MAINTENANCE_SUPPRESSION_EVIDENCE_TAG: &str = "H2O_SYNC_MAINTENANCE_SUPPRESSION";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceSuppression {
    pub schema: &'static str,
    /* True only for the exact token. Everything else is false. */
    pub suppressed: bool,
    pub reason: &'static str,
    /* Ephemeral process state: never read from or written to any store. */
    pub ephemeral: bool,
    pub persisted_configuration_changed: bool,
}

fn decide(raw: Option<&str>) -> MaintenanceSuppression {
    let suppressed = raw == Some(MAINTENANCE_SUPPRESSION_TOKEN);
    MaintenanceSuppression {
        schema: "h2o.studio.syncMaintenanceSuppression.v1",
        suppressed,
        reason: if suppressed {
            "governed-maintenance-window"
        } else {
            "not-engaged"
        },
        ephemeral: true,
        persisted_configuration_changed: false,
    }
}

/* Pure decision, exposed for tests. */
pub(crate) fn suppression_from_raw(raw: Option<&str>) -> MaintenanceSuppression {
    decide(raw)
}

/* Resolved once per process at first read, so the answer cannot change
 * mid-session and no scheduling path can race it. */
fn resolved() -> &'static MaintenanceSuppression {
    static RESOLVED: OnceLock<MaintenanceSuppression> = OnceLock::new();
    RESOLVED.get_or_init(|| {
        let raw = env::var(MAINTENANCE_SUPPRESSION_ENV).ok();
        decide(raw.as_deref())
    })
}

/* Only the decision itself plus build/process provenance. Deliberately carries
 * no environment value, no path, no database content and no user data: the
 * launch token is never echoed back, so capturing runtime output cannot leak
 * anything the operator did not already supply. */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InvocationEvidence {
    schema: &'static str,
    engaged: bool,
    reason: &'static str,
    ephemeral: bool,
    persisted_configuration_changed: bool,
    /* Constant, and true by construction: a registered Tauri command runs only
     * when the webview invokes it. */
    invoked_via: &'static str,
    evidence_persisted: bool,
    pid: u32,
    build_checkpoint: &'static str,
    source_commit: &'static str,
}

/* Pure, so the exact bytes a campaign will grep are unit-testable. */
fn evidence_line(decision: &MaintenanceSuppression, pid: u32) -> String {
    let payload = InvocationEvidence {
        schema: decision.schema,
        engaged: decision.suppressed,
        reason: decision.reason,
        ephemeral: decision.ephemeral,
        persisted_configuration_changed: decision.persisted_configuration_changed,
        invoked_via: "webview-ipc",
        evidence_persisted: false,
        pid,
        build_checkpoint: env!("H2O_STUDIO_BUILD_CHECKPOINT"),
        source_commit: env!("H2O_STUDIO_BUILD_SOURCE_COMMIT"),
    };
    format!(
        "{MAINTENANCE_SUPPRESSION_EVIDENCE_TAG} {}",
        serde_json::to_string(&payload)
            .unwrap_or_else(|_| String::from("{\"evidenceSerializationFailed\":true}"))
    )
}

/* `writeln!` rather than `eprintln!` on purpose: `eprintln!` panics if stderr
 * is closed, and a panicking command handler would change control flow. The
 * write result is dropped so the evidence surface can never influence, delay or
 * fail the suppression decision it reports. */
fn emit_invocation_evidence(decision: &MaintenanceSuppression) {
    let _ = writeln!(
        std::io::stderr(),
        "{}",
        evidence_line(decision, std::process::id())
    );
}

#[tauri::command]
pub fn h2o_sync_maintenance_suppression() -> MaintenanceSuppression {
    let decision = resolved().clone();
    emit_invocation_evidence(&decision);
    decision
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn parsed(decision: &MaintenanceSuppression, pid: u32) -> Value {
        let line = evidence_line(decision, pid);
        let (tag, json) = line
            .split_once(' ')
            .expect("evidence line is a tag followed by one JSON document");
        assert_eq!(tag, MAINTENANCE_SUPPRESSION_EVIDENCE_TAG);
        serde_json::from_str(json).expect("evidence payload must be machine-readable JSON")
    }

    #[test]
    fn only_the_exact_token_suppresses() {
        assert!(suppression_from_raw(Some(MAINTENANCE_SUPPRESSION_TOKEN)).suppressed);
        for raw in [
            None,
            Some(""),
            Some("1"),
            Some("true"),
            Some("yes"),
            Some("governed-maintenance"),
            Some("GOVERNED-MAINTENANCE-SUPPRESSION-V1"),
            Some(" governed-maintenance-suppression-v1 "),
        ] {
            assert!(
                !suppression_from_raw(raw).suppressed,
                "must not be engaged by {raw:?}"
            );
        }
    }

    #[test]
    fn suppression_never_reports_persisted_change() {
        for raw in [None, Some(MAINTENANCE_SUPPRESSION_TOKEN)] {
            let decision = suppression_from_raw(raw);
            assert!(decision.ephemeral);
            assert!(!decision.persisted_configuration_changed);
        }
    }

    #[test]
    fn not_engaged_is_the_default() {
        let decision = suppression_from_raw(None);
        assert!(!decision.suppressed);
        assert_eq!(decision.reason, "not-engaged");
    }

    #[test]
    fn evidence_reports_exactly_the_returned_decision() {
        for raw in [None, Some("bogus"), Some(MAINTENANCE_SUPPRESSION_TOKEN)] {
            let decision = suppression_from_raw(raw);
            let payload = parsed(&decision, 4242);
            assert_eq!(payload["engaged"], Value::Bool(decision.suppressed));
            assert_eq!(payload["reason"], Value::String(decision.reason.into()));
            assert_eq!(payload["schema"], Value::String(decision.schema.into()));
            assert_eq!(payload["ephemeral"], Value::Bool(true));
            assert_eq!(payload["persistedConfigurationChanged"], Value::Bool(false));
            assert_eq!(payload["evidencePersisted"], Value::Bool(false));
            assert_eq!(payload["invokedVia"], Value::String("webview-ipc".into()));
        }
    }

    #[test]
    fn evidence_is_one_line_and_attributable_to_this_process() {
        let engaged = suppression_from_raw(Some(MAINTENANCE_SUPPRESSION_TOKEN));
        let line = evidence_line(&engaged, 4242);
        assert!(!line.contains('\n'), "evidence must be a single line");
        assert!(line.starts_with(MAINTENANCE_SUPPRESSION_EVIDENCE_TAG));
        let payload = parsed(&engaged, 4242);
        assert_eq!(payload["pid"], Value::from(4242));
        assert_eq!(
            payload["sourceCommit"],
            Value::String(env!("H2O_STUDIO_BUILD_SOURCE_COMMIT").into())
        );
        assert_eq!(
            payload["buildCheckpoint"],
            Value::String(env!("H2O_STUDIO_BUILD_CHECKPOINT").into())
        );
    }

    #[test]
    fn evidence_carries_no_secret_environment_or_user_content() {
        for raw in [None, Some(MAINTENANCE_SUPPRESSION_TOKEN)] {
            let line = evidence_line(&suppression_from_raw(raw), 4242);
            /* The launch token and its variable name are never echoed back, and
             * nothing filesystem-shaped can appear in a fixed-key payload. */
            assert!(!line.contains(MAINTENANCE_SUPPRESSION_TOKEN));
            assert!(!line.contains(MAINTENANCE_SUPPRESSION_ENV));
            assert!(!line.contains('/'), "evidence must not carry any path");
        }
    }

    #[test]
    fn evidence_emission_is_deterministic_for_a_fixed_decision_and_process() {
        let decision = suppression_from_raw(Some(MAINTENANCE_SUPPRESSION_TOKEN));
        assert_eq!(evidence_line(&decision, 7), evidence_line(&decision, 7));
        assert_ne!(evidence_line(&decision, 7), evidence_line(&decision, 8));
    }
}
