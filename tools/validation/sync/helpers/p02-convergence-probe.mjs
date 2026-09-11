/*
 * Test access to the REAL direction-keyed convergence comparator.
 *
 * `convergenceVerdict` is module-private in the Chrome enumerator, which is
 * correct - nothing outside should be able to reach it. But a test that
 * reimplemented the rule would be testing its own copy, and the copy would
 * drift from production on the first change to either. So the actual function
 * source is extracted from the shipping module and evaluated here.
 *
 * That means these tests fail if production changes, which is the point: the
 * comparator is the single place where cross-representation convergence is
 * decided, and a silent divergence between it and the anti-echo matrix would
 * be exactly the bug the matrix exists to catch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE = path.join(
  root, 'packages/browser-adapters/chrome/sync-object-enumerator-v2.mjs'
);

function extractRealComparator() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('function convergenceVerdict(');
  if (start < 0) throw new Error('p02-convergence-probe-comparator-missing');
  const end = source.indexOf('\nfunction sameRevision(', start);
  if (end < 0) throw new Error('p02-convergence-probe-boundary-missing');
  const body = source.slice(start, end);
  /* The two constants the comparator closes over, restated exactly as the
   * module defines them so the extracted function behaves identically. */
  const prelude = `
    const CHROME_CONVERGED_DIRECTION = Object.freeze({
      PUBLISHED: 'published', APPLIED: 'applied'
    });
    const CHROME_SHA256_RE = /^[0-9a-f]{64}$/;
  `;
  // eslint-disable-next-line no-new-func
  return new Function(`${prelude}\n${body}\nreturn convergenceVerdict;`)();
}

const convergenceVerdict = extractRealComparator();

/*
 * Drive the real comparator from a protocol-state row, in the shape the
 * enumerators assemble it. Canonical is expressed by its payload hash alone,
 * because that is the only thing the P02 regime consults.
 */
export function convergenceVerdictForTest({
  canonicalPayloadSha256 = null,
  canonicalRevisionId = 'canonical',
  canonicalRevisionBlobSha256 = null,
  row = {}
} = {}) {
  const canonical = canonicalPayloadSha256 === null ? null : {
    revisionId: canonicalRevisionId,
    revisionBlobSha256: canonicalRevisionBlobSha256,
    payloadSha256: canonicalPayloadSha256
  };
  const identity = {
    direction: row.last_converged_direction ?? null,
    publishedPayloadSha256: row.last_published_payload_sha256 ?? null,
    appliedPayloadSha256: row.last_applied_payload_sha256 ?? null
  };
  const lastPublished = row.last_published_revision_id ? {
    revisionId: row.last_published_revision_id,
    revisionBlobSha256: row.last_published_revision_blob_sha256
  } : null;
  const lastApplied = row.last_applied_revision_id ? {
    revisionId: row.last_applied_revision_id,
    revisionBlobSha256: row.last_applied_revision_blob_sha256
  } : null;
  return convergenceVerdict(canonical, identity, lastPublished, lastApplied);
}

export { SOURCE as CONVERGENCE_COMPARATOR_SOURCE };
