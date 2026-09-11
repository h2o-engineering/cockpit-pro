/*
 * P02 Wave 1 / Z7 — Desktop product entry for the P02 object runtime.
 *
 * This is the Desktop half of the platform integration: the smallest module
 * bridge that makes the already-implemented P02 composition LOADABLE by the
 * Studio product, while it stays completely inactive behind the Y-10 format
 * gate. It exists so the later governed V7/V8 campaign activates and mutates
 * already-complete, already-proven code rather than carrying implementation.
 *
 * Loading this module is inert by construction:
 *   - it performs no I/O, reads no repository and touches no database;
 *   - it constructs no scheduler (the runtime factory is lazy);
 *   - it initializes nothing and writes nothing;
 *   - it registers no timer, alarm or listener;
 *   - it creates no second scheduler, mode authority or writer authority -
 *     every caller receives the one shared engine from packages/core.
 *
 * The classic Studio scripts keep owning P01 behaviour unchanged. This module
 * only publishes a read-only handle they can consult.
 */

import {
  P02_RUNTIME_STATUS,
  P02_RUNTIME_V2,
  createP02ObjectRuntime
} from '../core/sync-object-runtime-v2.mjs';
import {
  P02_FORMAT_GATE_V2,
  P02_GATE_STATE,
  evaluateFormatGate
} from '../core/sync-format-gate-v2.mjs';
import { P02_CAPACITY_LIMITS } from '../core/sync-evidence-capacity-v2.mjs';

export const P02_DESKTOP_COMPOSITION = Object.freeze({
  schema: 'h2o.studio.syncDesktopComposition.p02.v1',
  runtime: P02_RUNTIME_V2.SCHEMA,
  gate: P02_FORMAT_GATE_V2.SCHEMA,
  capacity: Object.freeze({ ...P02_CAPACITY_LIMITS }),
  drainLimit: P02_RUNTIME_V2.DEFAULT_DRAIN_LIMIT,
  singleEngine: true,
  activatesOnLoad: false,
  mutatesOnLoad: false
});

/*
 * The gate decision that applies before any repository has been observed.
 * Deliberately computed from inert inputs so importing this module never
 * reads a Sync folder: a repository that has not been through the governed
 * V7/V8 activation campaign has no library.info, so P02 may not write.
 */
export function inactiveDesktopGate() {
  return evaluateFormatGate({ libraryInfo: null, repositoryHasContent: true });
}

/*
 * Lazy factory. Nothing is constructed until a caller supplies real platform
 * seams, so module load cannot create a scheduler or reach a store. The gate
 * seam defaults to the inactive decision, which keeps every derived runtime
 * read-only until the activation campaign supplies a real gate reader.
 */
export function createDesktopP02Runtime(seams = {}) {
  const {
    peerId = 'h2o:studio:sync:desktop:p02',
    clock = () => 0,
    enumerate,
    classify,
    reconcileOneObject,
    authority,
    gate = async () => inactiveDesktopGate(),
    retainedEvidenceFor = null,
    p01WriterActive = null,
    /* Dormant by default. Threaded rather than dropped so a caller that has
     * decided to serialize a realm is not silently ignored here. */
    realmLock = null
  } = seams;
  return createP02ObjectRuntime({
    peerId,
    clock,
    enumerate,
    classify,
    reconcileOneObject,
    authority,
    gate,
    retainedEvidenceFor,
    p01WriterActive,
    realmLock
  });
}

/*
 * Publish a read-only handle for the classic Studio scripts. No behaviour is
 * replaced and no P01 path is altered; the coordinator can report P02
 * composition without any ability to activate it from here.
 */
export function installDesktopP02Composition(globalScope = globalThis) {
  const scope = globalScope || {};
  const H2O = scope.H2O = scope.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  if (H2O.Studio.sync.p02) return H2O.Studio.sync.p02;
  const gateAtLoad = inactiveDesktopGate();
  const handle = Object.freeze({
    composition: P02_DESKTOP_COMPOSITION,
    /* Always false at load: activation is a governed state event, not an import. */
    active: false,
    gateAtLoad,
    gateState: gateAtLoad.state,
    mayWriteAtLoad: gateAtLoad.mayWrite,
    createRuntime: createDesktopP02Runtime,
    evaluateFormatGate,
    statuses: P02_RUNTIME_STATUS,
    gateStates: P02_GATE_STATE
  });
  H2O.Studio.sync.p02 = handle;
  return handle;
}

/*
 * Side effect on import is limited to publishing the frozen handle above.
 * It reads nothing, writes nothing and schedules nothing.
 */
installDesktopP02Composition();
