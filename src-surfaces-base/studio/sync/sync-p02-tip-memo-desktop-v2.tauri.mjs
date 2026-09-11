/*
 * O1-T07 — Desktop durable store port for the Y-2 memo.
 *
 * WHY kv_store IS THE SAFE CHOICE.
 *
 * It already exists. It arrived in migration v1 as a generic key/value backing
 * for the chrome.storage.local shim, so using it adds no table and no
 * migration - the ladder still tops out at v22 untouched.
 *
 * It has no authority semantics to conflict with. Every other durable surface
 * P02 could have used carries meaning: sync_object_state IS protocol state,
 * sync_branch_evidence_state IS derived evidence, the observation tables ARE
 * admission records. Writing a memo into any of them would put a non-authority
 * record inside a store whose whole purpose is authority, and something would
 * eventually read it as such. kv_store means nothing by itself, which is
 * exactly the property a memo needs.
 *
 * It does not require anything else to exist. A memo for a (peer, object) pair
 * can be written whether or not that object has observations, admission
 * evidence or an apply state - which matters because the memo describes what a
 * PEER advertised, and a peer can advertise an object we hold nothing for.
 *
 * The key namespaces both halves of the pair explicitly, so a memo can never
 * be confused with another subsystem's key or with a memo for a different peer
 * of the same object.
 *
 * READ AND WRITE ONLY. There is no delete: a memo is superseded by writing the
 * next verified snapshot over it, and nothing about a failed read may remove
 * one. Retention on pointer failure is therefore structural rather than a rule
 * someone has to remember.
 */
import { P02_TIP_MEMO_V2, createP02VerifiedTipMemo }
  from '../core/sync-p02-verified-tip-memo-v2.mjs';

export const P02_DESKTOP_TIP_MEMO = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02TipMemoDesktop.v1',
  TABLE: 'kv_store',
  SELECT: 'SELECT value FROM kv_store WHERE key = ? LIMIT 1',
  UPSERT: 'INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, '
    + 'updated_at = excluded.updated_at'
});

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createDesktopTipMemoStore({ sql, clock = () => Date.now() } = {}) {
  if (!isPlainObject(sql) || typeof sql.select !== 'function' ||
      typeof sql.execute !== 'function') {
    throw new TypeError('p02-desktop-tip-memo-dependency-invalid');
  }
  return Object.freeze({
    schema: P02_DESKTOP_TIP_MEMO.SCHEMA,
    table: P02_DESKTOP_TIP_MEMO.TABLE,
    async read(key) {
      const rows = await sql.select(P02_DESKTOP_TIP_MEMO.SELECT, [key]);
      const row = Array.isArray(rows) ? rows[0] : null;
      /* Absent is null, not an error: a pair we have never seen is normal. */
      return row?.value ?? null;
    },
    async write(key, value) {
      await sql.execute(P02_DESKTOP_TIP_MEMO.UPSERT, [key, value, clock()]);
    }
  });
}

export function createDesktopVerifiedTipMemo({ sql, clock } = {}) {
  return createP02VerifiedTipMemo({
    store: createDesktopTipMemoStore({ sql, clock })
  });
}

export { P02_TIP_MEMO_V2 };
