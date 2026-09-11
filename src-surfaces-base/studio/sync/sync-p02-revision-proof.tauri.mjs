/*
 * P02 repository revision proof (A1 §5 triage port, §8 proof discipline).
 *
 * The only authority that can decide whether a v1 projection blob and a v2
 * envelope blob wrap the same content is the repository itself, because no
 * column records the payload of an anchor written before the identity
 * amendment. This exposes exactly one question, "what payload does the revision
 * at this immutable address carry?", and nothing else.
 *
 * Proof discipline per A1 §8: reads are lazy, and ONLY verified results are
 * memoized. A missing file or a read error is never cached, because both are
 * transient conditions a later pass must be free to re-ask. Immutable addresses
 * never change, so a verified answer is good forever.
 *
 * Read-only by construction: the storage adapter is built with no capability,
 * so every mutating command it could issue fails closed before reaching native.
 */
import { createLocalWriterTransportPrimitives }
  from '../browser-adapters/chrome/sync-writer-transport-v2.mjs';
import { createDesktopLocalWriterStorage } from './sync-writer-storage-desktop-v2.tauri.mjs';

export const P02_REVISION_PROOF = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02RevisionProof.v1',
  CHAT_OBJECT_DOMAIN: 'studio.chat.saved-state.v1'
});

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const HEX64 = /^[0-9a-f]{64}$/;

export function createP02RevisionProof({
  invoke,
  writerSyncPeerId,
  objectDomain = P02_REVISION_PROOF.CHAT_OBJECT_DOMAIN,
  objectKeyFor,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (typeof invoke !== 'function' || !clean(writerSyncPeerId) ||
      typeof objectKeyFor !== 'function') {
    throw new TypeError('p02-revision-proof-dependency-invalid');
  }
  const transport = createLocalWriterTransportPrimitives({
    storage: createDesktopLocalWriterStorage({ invoke, capability: null }),
    ownedWriterSyncPeerId: writerSyncPeerId
  });
  /* Verified answers only, keyed by the immutable address. */
  const verified = new Map();

  async function readRevisionPayloadSha256({ objectId, revisionId, revisionBlobSha256 }) {
    const blob = clean(revisionBlobSha256);
    const id = clean(objectId);
    if (!HEX64.test(blob) || !id) return null;
    const memoKey = `${id}\u0000${blob}`;
    if (verified.has(memoKey)) return verified.get(memoKey);

    const objectKey = clean(await objectKeyFor(objectDomain, id, cryptoImplementation));
    if (!HEX64.test(objectKey)) return null;
    let revision;
    try {
      revision = await transport.readRevision({
        objectDomain, objectId: id, objectKey, revisionBlobSha256: blob
      });
    } catch (_) {
      /* Read or validation error: not proof, and deliberately not cached. */
      return null;
    }
    if (!revision || revision.status !== 'verified') return null;
    const payloadSha256 = clean(revision.value?.payloadSha256);
    if (!HEX64.test(payloadSha256)) return null;
    /* The caller asked about a specific revisionId; cross-check before trusting
     * the answer, so a proof can never be attributed to the wrong revision. */
    if (clean(revisionId) && clean(revision.value?.revisionId) !== clean(revisionId)) return null;
    /* Verified at an immutable address: true forever. */
    verified.set(memoKey, payloadSha256);
    return payloadSha256;
  }

  return Object.freeze({
    schema: P02_REVISION_PROOF.SCHEMA,
    readRevisionPayloadSha256,
    __test: Object.freeze({ verifiedCount: () => verified.size })
  });
}
