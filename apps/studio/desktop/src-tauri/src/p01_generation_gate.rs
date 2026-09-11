/*
 * O1-T19 — native P01 writer-generation gate.
 *
 * The JS gate stops every ordinary P01 mutation path. This one stops the rest.
 *
 * A Tauri command is reachable from anything running in the webview, so a JS
 * refusal is a refusal only for callers that go through the JS. Without a gate
 * on this side, "JS denied the write" is a statement about a layer that can
 * simply be skipped.
 *
 * WHICH COMMANDS NEED IT (corrected in O1-B2.1 - an earlier version of this
 * comment claimed the delivery writer was the only one, and it was not):
 *
 *   h2o_item11_prepare_delivery        - P01 delivery bytes
 *   h2o_item11_prepare_local_delivery  - P01 delivery bytes + lineage ledger
 *   h2o_sync_object_publish_transport  - P01 revision blob + head document
 *
 * These are the H2O-authored commands that write P01 bytes, and each consults
 * the gate. The rule that produced the list is worth keeping over the list
 * itself: a native command belongs here when it writes P01 bytes AND no P02
 * path uses it. The P02 command family (h2o_p02_*) is deliberately absent -
 * gating it would refuse the very writer the standdown exists to install.
 *
 * WHAT DOES NOT BELONG HERE. The Desktop exporter and the peer-transport mirror
 * reach disk through the GENERIC `plugin:fs|write_text_file`, not through any
 * P01-specific command. That substrate is shared with unrelated features, so
 * the enforcement boundary for them is the H2O-authored P01 feature entry point
 * (`exportLatestSyncBundle`), which is gated before it writes:
 *
 *   GENERIC_SHARED_TRANSPORT - P01 GATE AT FEATURE ENTRY POINT
 *
 * That is sound only while every H2O-authored route to those writes is gated
 * and no P01-specific native command offers a way around them. The T19
 * validator pins both halves, because the day either stops being true is the
 * day this reasoning silently stops holding.
 *
 * THE FOUR OBSERVATIONS ARE THE SAME FOUR as the JS gate, and they must be, or
 * the two layers would disagree about what a repository's state means:
 *
 *   the query returned no row      -> P01 permitted (the pre-standdown world)
 *   the row says p01               -> P01 permitted
 *   the row says p02               -> refused, P01 has stood down
 *   the row is unparseable         -> refused
 *   the query itself failed        -> refused, because we do not know
 *
 * The last one is the one worth stating plainly: an unreadable store is not an
 * empty store. Treating a failed query as "no record" would re-authorize P01
 * writes into a repository P02 may already own, which is exactly the outcome
 * the standdown exists to prevent.
 *
 * READ ONLY. There is no write path here. The ceremony write belongs to a
 * future governed standdown, and a module that cannot write cannot be the thing
 * that performs one by accident.
 */

use serde_json::Value;
use tauri_plugin_sql::{DbInstances, DbPool};

/* Identical to the JS contract, deliberately duplicated rather than shared:
 * these are two runtimes, and a parity test pins them against each other. */
pub const WRITER_GENERATION_KEY: &str = "h2o:studio:sync:writer-generation:v1";
pub const WRITER_GENERATION_SCHEMA_VERSION: i64 = 1;
pub const GENERATION_P01: &str = "p01";
pub const GENERATION_P02: &str = "p02";

pub const P01_STOOD_DOWN: &str = "p01-writer-stood-down";
pub const GENERATION_UNOBSERVED: &str = "generation-unobserved";
pub const GENERATION_MALFORMED: &str = "generation-record-malformed";

const DB_URL: &str = "sqlite:studio-v1.db";

/// What the store actually said. Kept as four states rather than an
/// `Option<String>` so absence and unreadability cannot be confused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GenerationObservation {
    AbsentObserved,
    Recorded(String),
    Malformed,
    Unobserved,
}

/*
 * Interpret a stored value. A partially-valid record is malformed: acting on
 * half a record is acting on a guess, and the guess would be in the dangerous
 * direction.
 */
pub(crate) fn interpret_generation_value(raw: Option<&str>) -> GenerationObservation {
    let Some(text) = raw else {
        return GenerationObservation::AbsentObserved;
    };
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return GenerationObservation::Malformed;
    };
    if value.get("schemaVersion").and_then(Value::as_i64) != Some(WRITER_GENERATION_SCHEMA_VERSION)
    {
        return GenerationObservation::Malformed;
    }
    match value.get("generation").and_then(Value::as_str) {
        Some(GENERATION_P01) => GenerationObservation::Recorded(GENERATION_P01.to_string()),
        Some(GENERATION_P02) => {
            /* A p02 record is a standdown DECISION. Without provenance it is
             * not a decision anyone can audit, and standing P01 down on it
             * would be standing down on hearsay. */
            let dated = value
                .get("standdownAt")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty());
            let decided = value
                .get("decidedByWriterSyncPeerId")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty());
            let reasoned = value
                .get("reason")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty());
            if dated && decided && reasoned {
                GenerationObservation::Recorded(GENERATION_P02.to_string())
            } else {
                GenerationObservation::Malformed
            }
        }
        _ => GenerationObservation::Malformed,
    }
}

/// The verdict every native P01 mutation path consults. Only a proven absence
/// or a well-formed `p01` record permits mutation.
pub(crate) fn permits_p01_mutation(observation: &GenerationObservation) -> Result<(), &'static str> {
    match observation {
        GenerationObservation::AbsentObserved => Ok(()),
        GenerationObservation::Recorded(generation) if generation == GENERATION_P01 => Ok(()),
        GenerationObservation::Recorded(_) => Err(P01_STOOD_DOWN),
        GenerationObservation::Malformed => Err(GENERATION_MALFORMED),
        GenerationObservation::Unobserved => Err(GENERATION_UNOBSERVED),
    }
}

/*
 * Read the record from the generic kv_store the JS gate writes and reads.
 *
 * Every failure to READ - no pool, a query error, a value that is not text -
 * becomes Unobserved rather than AbsentObserved. That asymmetry is the whole
 * point: absence is a fact we observed, and everything else is ignorance.
 */
pub(crate) async fn observe_generation(db_instances: &DbInstances) -> GenerationObservation {
    let pool = {
        let instances = db_instances.0.read().await;
        match instances.get(DB_URL) {
            Some(DbPool::Sqlite(pool)) => pool.clone(),
            _ => return GenerationObservation::Unobserved,
        }
    };
    let rows = sqlx::query_scalar::<_, String>("SELECT value FROM kv_store WHERE key = ? LIMIT 1")
        .bind(WRITER_GENERATION_KEY)
        .fetch_optional(&pool)
        .await;
    match rows {
        Ok(Some(text)) => interpret_generation_value(Some(&text)),
        Ok(None) => GenerationObservation::AbsentObserved,
        Err(_) => GenerationObservation::Unobserved,
    }
}

/// The one call a native P01 mutation command makes before writing anything.
pub(crate) async fn require_p01_mutation_permitted(
    db_instances: &DbInstances,
) -> Result<(), String> {
    permits_p01_mutation(&observe_generation(db_instances).await).map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(generation: &str, complete: bool) -> String {
        if complete {
            serde_json::json!({
                "schemaVersion": 1,
                "generation": generation,
                "standdownAt": "2026-08-26T00:00:00.000Z",
                "decidedByWriterSyncPeerId": "studio-desktop:tauri-desktop:sqlite:ceremony",
                "reason": "governed standdown"
            })
            .to_string()
        } else {
            serde_json::json!({ "schemaVersion": 1, "generation": generation }).to_string()
        }
    }

    /// A proven absence is the pre-standdown world, and P01 must keep working
    /// exactly as it does today.
    #[test]
    fn absence_permits_p01_exactly_as_before() {
        let observation = interpret_generation_value(None);
        assert_eq!(observation, GenerationObservation::AbsentObserved);
        assert!(permits_p01_mutation(&observation).is_ok());
    }

    /// A p01 record permits, and a p02 record refuses.
    #[test]
    fn recorded_generation_decides() {
        let p01 = interpret_generation_value(Some(&record(GENERATION_P01, false)));
        assert_eq!(p01, GenerationObservation::Recorded(GENERATION_P01.into()));
        assert!(permits_p01_mutation(&p01).is_ok());

        let p02 = interpret_generation_value(Some(&record(GENERATION_P02, true)));
        assert_eq!(p02, GenerationObservation::Recorded(GENERATION_P02.into()));
        assert_eq!(permits_p01_mutation(&p02).unwrap_err(), P01_STOOD_DOWN);
    }

    /// A p02 record with no provenance is not an auditable decision.
    #[test]
    fn a_p02_record_without_provenance_is_malformed() {
        let observation = interpret_generation_value(Some(&record(GENERATION_P02, false)));
        assert_eq!(observation, GenerationObservation::Malformed);
        assert_eq!(permits_p01_mutation(&observation).unwrap_err(), GENERATION_MALFORMED);
    }

    /// Malformed input never reads as absence, in any of its shapes.
    #[test]
    fn malformed_records_fail_closed() {
        for raw in [
            "not json at all",
            r#"{"generation":"p01"}"#,
            r#"{"schemaVersion":2,"generation":"p01"}"#,
            r#"{"schemaVersion":1,"generation":"p03"}"#,
            r#"{"schemaVersion":1}"#,
        ] {
            let observation = interpret_generation_value(Some(raw));
            assert_eq!(observation, GenerationObservation::Malformed, "{raw}");
            assert_eq!(
                permits_p01_mutation(&observation).unwrap_err(),
                GENERATION_MALFORMED,
                "{raw}"
            );
        }
    }

    /// An unreadable store is NOT an empty store. This is the asymmetry the
    /// whole gate depends on.
    #[test]
    fn unobserved_is_not_absence() {
        assert_eq!(
            permits_p01_mutation(&GenerationObservation::Unobserved).unwrap_err(),
            GENERATION_UNOBSERVED
        );
        assert!(permits_p01_mutation(&GenerationObservation::AbsentObserved).is_ok());
        assert_ne!(GenerationObservation::Unobserved, GenerationObservation::AbsentObserved);
    }

    /// The native contract matches the JS contract byte for byte, so the two
    /// layers cannot disagree about what a repository's state means.
    #[test]
    fn native_contract_matches_the_js_contract() {
        let js = include_str!("../../../../../packages/core/sync-writer-generation-v2.mjs");
        assert!(js.contains(&format!("KEY: '{WRITER_GENERATION_KEY}'")));
        assert!(js.contains(&format!("SCHEMA_VERSION: {WRITER_GENERATION_SCHEMA_VERSION}")));
        assert!(js.contains(&format!("P01: '{GENERATION_P01}'")));
        assert!(js.contains(&format!("P02: '{GENERATION_P02}'")));
        assert!(js.contains(&format!("STOOD_DOWN: '{P01_STOOD_DOWN}'")));
        assert!(js.contains(&format!("UNOBSERVED: '{GENERATION_UNOBSERVED}'")));
        assert!(js.contains(&format!("MALFORMED: '{GENERATION_MALFORMED}'")));
    }

    /// Nothing here writes. A module that cannot write cannot stand P01 down.
    #[test]
    fn the_native_gate_has_no_write_path() {
        let source = include_str!("p01_generation_gate.rs");
        let production = &source[..source.find("#[cfg(test)]").expect("test module")];
        for forbidden in ["INSERT", "UPDATE", "DELETE", "fs::write", "REPLACE INTO"] {
            assert!(
                !production.contains(forbidden),
                "the native generation gate must not contain {forbidden}"
            );
        }
    }
}
