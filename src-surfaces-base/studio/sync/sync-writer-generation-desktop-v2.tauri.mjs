/*
 * O1-T19 — Desktop writer-generation store port.
 *
 * The generic kv_store from migration v1, for the same reasons Y-2 uses it: it
 * already exists, it adds no table and no migration, and it carries no
 * authority semantics of its own. Every other durable Desktop surface P02 or
 * P01 could have used is authority - sync_object_state IS protocol state,
 * sync_branch_evidence_state IS derived evidence - and a generation record
 * inside one of those would eventually be read as part of it.
 *
 * THE THREE OUTCOMES ARE DISTINGUISHED HERE. `read` resolves to the value,
 * resolves to null for a proven absence, and REJECTS when the query failed. A
 * port that swallowed a query error into null would hand the gate an absence it
 * never observed, and P01 would be re-authorized to write into a repository
 * that P02 may already own - the one outcome the standdown exists to prevent.
 *
 * READ ONLY. No write method exists, because the ceremony write belongs to a
 * future governed standdown and nothing in this batch may perform one.
 */
import { P02_WRITER_GENERATION, createP01MutationGate }
  from '../core/sync-writer-generation-v2.mjs';

export const P02_DESKTOP_GENERATION = Object.freeze({
  SCHEMA: 'h2o.studio.syncWriterGenerationDesktop.v1',
  TABLE: 'kv_store',
  SELECT: 'SELECT value FROM kv_store WHERE key = ? LIMIT 1'
});

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createDesktopGenerationStore({ sql } = {}) {
  if (!isPlainObject(sql) || typeof sql.select !== 'function') {
    /* Refuse to construct rather than return a port whose reads would look
     * like proven absences. */
    throw new TypeError('p02-desktop-generation-store-invalid');
  }
  return Object.freeze({
    schema: P02_DESKTOP_GENERATION.SCHEMA,
    table: P02_DESKTOP_GENERATION.TABLE,
    async read(key) {
      /* A throw here propagates, and MUST: the gate turns it into
       * generation-unobserved and fails closed. */
      const rows = await sql.select(P02_DESKTOP_GENERATION.SELECT, [key]);
      const row = Array.isArray(rows) ? rows[0] : null;
      return row?.value ?? null;
    }
  });
}

/* The gate a Desktop P01 mutation seam calls. Desktop observes DESKTOP's
 * record; one platform's readable store must never authorize the other's. */
export function createDesktopP01MutationGate({ sql, seamName } = {}) {
  return createP01MutationGate({ store: createDesktopGenerationStore({ sql }), seamName });
}

export { P02_WRITER_GENERATION };
