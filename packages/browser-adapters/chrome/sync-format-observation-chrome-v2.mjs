/*
 * P02 Unit W - Chrome repository format / generation observation.
 *
 * The Chrome background composition used to hand the runtime a constant:
 * `evaluateFormatGate({ libraryInfo: null, repositoryHasContent: true })`,
 * which can only ever answer mayWrite:false. That was correct while no
 * repository read existed; it is a lie once one does.
 *
 * This adapter is the replacement, and it is deliberately thin. It parses
 * nothing and decides nothing: `evaluateFormatGate` owns the format verdict,
 * `createP02LegacyBaselineObserver` owns N.2, `readWriterGeneration` owns the
 * generation vocabulary, and this module only reads bytes through the confined
 * FSA surfaces and hands them to those contracts.
 *
 * Observed FRESH on every pass. Nothing here is memoized: a grant can be
 * revoked, a repository can be deactivated and a generation can move between
 * two passes, and a cached authority would report the world as it was.
 *
 * READ ONLY. There is no write path, no activation hook and no repair.
 */

import { evaluateFormatGate, P02_FORMAT_GATE_V2 } from '../../core/sync-format-gate-v2.mjs';
import {
  createP02LegacyBaselineObserver,
  legacyBaselineReceiptOf
} from '../../core/sync-p02-legacy-baseline-observer-v2.mjs';
import {
  P02_GENERATION_STATE,
  P02_WRITER_GENERATION,
  readWriterGeneration
} from '../../core/sync-writer-generation-v2.mjs';
import { P02_FSA_READ_ERROR } from './sync-fsa-read-transport-v2.mjs';

export const P02_CHROME_FORMAT_OBSERVATION = Object.freeze({
  SCHEMA: 'h2o.studio.syncFormatObservationChrome.p02.v1',
  AUTHORITY_PATH: 'library.info.json',
  /* Writer-scoped, per require_p02_generation. Not a root-level file. */
  generationPath: (writerKey) => `writers/${writerKey}/generation.json`
});

/* Why a pass could not be admitted. Every one of these fails CLOSED. */
export const P02_CHROME_OBSERVATION_BLOCK = Object.freeze({
  HANDLE_ABSENT: 'handle-absent',
  PERMISSION_ABSENT: 'permission-absent',
  AUTHORITY_UNREADABLE: 'library-info-unreadable',
  GENERATION_UNREADABLE: 'generation-unreadable',
  GENERATION_NOT_P02: 'generation-not-p02',
  WRITER_KEY_INVALID: 'writer-key-invalid'
});

const HEX64 = /^[0-9a-f]{64}$/;
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/*
 * A refusal expressed in the gate's own shape. The runtime reads `mayRead`
 * and `mayWrite`; a blocked observation must present as fail-closed on both,
 * with the reason carried alongside rather than folded into a gate state that
 * would misdescribe the repository.
 */
function blockedGate(blockReason, detail = null) {
  return Object.freeze({
    schema: P02_FORMAT_GATE_V2.SCHEMA,
    state: 'observation-blocked',
    mayRead: false,
    mayWrite: false,
    initializationEligible: false,
    classification: null,
    reason: blockReason,
    ...(detail === null ? {} : { detail })
  });
}

const isPermissionError = (error) =>
  error?.code === P02_FSA_READ_ERROR.PERMISSION_BLOCKED;

/*
 * `repositoryStorage` and `legacyArtifactStorage` are the confined surfaces
 * from `createChromeFsaReadTransport`; `generationStore` is the Chrome
 * chrome.storage.local store. All are injected: this module acquires no
 * handle and reaches no global.
 */
export function createChromeFormatObservation({
  repositoryStorage = null,
  legacyArtifactStorage = null,
  generationStore = null,
  writerKey = null,
  sha256HexBytes,
  readerProtocolVersion = P02_FORMAT_GATE_V2.PROTOCOL_VERSION,
  requireRepositoryGenerationP02 = false
} = {}) {
  if (typeof sha256HexBytes !== 'function') {
    throw new TypeError('p02-chrome-format-observation-dependency-invalid');
  }

  async function readRepositoryDocument(path) {
    const bytes = await repositoryStorage.read(path);
    if (bytes === null) return { present: false, value: null };
    let value;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
      /* Not a document. Handed on as a malformed value, not as absence: the
       * gate must see it and quarantine, not treat it as an empty repository. */
      return { present: true, value: undefined };
    }
    return { present: true, value };
  }

  async function observe() {
    if (!repositoryStorage || typeof repositoryStorage.read !== 'function') {
      return frozen(blockedGate(P02_CHROME_OBSERVATION_BLOCK.HANDLE_ABSENT), null, null);
    }

    /* 1. The repository authority. */
    let authority;
    try {
      authority = await readRepositoryDocument(P02_CHROME_FORMAT_OBSERVATION.AUTHORITY_PATH);
    } catch (error) {
      return frozen(blockedGate(
        isPermissionError(error)
          ? P02_CHROME_OBSERVATION_BLOCK.PERMISSION_ABSENT
          : P02_CHROME_OBSERVATION_BLOCK.AUTHORITY_UNREADABLE,
        error?.detail ?? error?.code ?? null), null, null);
    }
    /* Absent library.info is a normal state the gate already models. */
    const libraryInfo = authority.present ? authority.value ?? {} : null;

    /* 2. N.2, only meaningful once an activation receipt exists. */
    let legacyMatches = true;
    let legacyObservation = null;
    const receipt = legacyBaselineReceiptOf(libraryInfo);
    if (receipt && legacyArtifactStorage && typeof legacyArtifactStorage.read === 'function') {
      const observer = createP02LegacyBaselineObserver({
        readArtifactBytes: (name) => legacyArtifactStorage.read(name),
        sha256HexBytes
      });
      try {
        legacyObservation = await observer.observe({ legacyBaselineReceipt: receipt });
        legacyMatches = legacyObservation.matches === true;
      } catch (_) {
        /* An observer that could not run has proven nothing. */
        legacyMatches = false;
      }
    }

    /* 3. The format verdict - the accepted contract decides, not this file. */
    const gate = evaluateFormatGate({
      libraryInfo,
      repositoryHasContent: true,
      readerProtocolVersion,
      legacyBaselineMatches: legacyMatches
    });

    /* 4. The generation authorities, observed but never repaired. */
    const generation = await observeGeneration();
    if (generation.blockReason !== null) {
      return frozen(blockedGate(generation.blockReason, generation.detail),
        generation, legacyObservation);
    }
    if (requireRepositoryGenerationP02 &&
        generation.repository !== P02_WRITER_GENERATION.P02) {
      return frozen(blockedGate(P02_CHROME_OBSERVATION_BLOCK.GENERATION_NOT_P02,
        generation.repository), generation, legacyObservation);
    }
    return frozen(gate, generation, legacyObservation);
  }

  async function observeGeneration() {
    const result = {
      local: null, localState: null, repository: null,
      blockReason: null, detail: null
    };

    /* Chrome's own record - the P01 refusal gate's substrate. */
    if (generationStore && typeof generationStore.read === 'function') {
      const observation = await readWriterGeneration({ store: generationStore });
      result.localState = observation.state;
      result.local = observation.generation ?? null;
      if (observation.state === P02_GENERATION_STATE.UNOBSERVED ||
          observation.state === P02_GENERATION_STATE.MALFORMED) {
        result.blockReason = P02_CHROME_OBSERVATION_BLOCK.GENERATION_UNREADABLE;
        result.detail = observation.state;
        return result;
      }
    }

    /* The repository lease record, if a writer key was supplied. */
    if (writerKey !== null) {
      if (typeof writerKey !== 'string' || !HEX64.test(writerKey)) {
        result.blockReason = P02_CHROME_OBSERVATION_BLOCK.WRITER_KEY_INVALID;
        return result;
      }
      let document;
      try {
        document = await readRepositoryDocument(
          P02_CHROME_FORMAT_OBSERVATION.generationPath(writerKey));
      } catch (error) {
        result.blockReason = isPermissionError(error)
          ? P02_CHROME_OBSERVATION_BLOCK.PERMISSION_ABSENT
          : P02_CHROME_OBSERVATION_BLOCK.GENERATION_UNREADABLE;
        result.detail = error?.detail ?? error?.code ?? null;
        return result;
      }
      if (!document.present) {
        result.repository = null;
      } else if (!isPlainObject(document.value)) {
        result.blockReason = P02_CHROME_OBSERVATION_BLOCK.GENERATION_UNREADABLE;
        result.detail = 'malformed';
        return result;
      } else {
        result.repository = typeof document.value.generation === 'string'
          ? document.value.generation
          : null;
        if (result.repository === null) {
          result.blockReason = P02_CHROME_OBSERVATION_BLOCK.GENERATION_UNREADABLE;
          result.detail = 'generation-field-missing';
          return result;
        }
      }
    }
    return result;
  }

  function frozen(gate, generation, legacyObservation) {
    return Object.freeze({
      schema: P02_CHROME_FORMAT_OBSERVATION.SCHEMA,
      gate,
      mayRead: gate.mayRead === true,
      mayWrite: gate.mayWrite === true,
      generation: generation === null ? null : Object.freeze({ ...generation }),
      legacyObservation,
      /* Stated so no consumer can read this surface as an action. */
      readOnly: true,
      repaired: false
    });
  }

  return Object.freeze({
    schema: P02_CHROME_FORMAT_OBSERVATION.SCHEMA,
    readOnly: true,
    observe
  });
}
