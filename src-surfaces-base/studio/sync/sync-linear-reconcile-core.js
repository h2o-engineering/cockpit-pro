/* H2O Studio Sync — one-object linear reconciliation transition core.
 *
 * Pure orchestration only. Callers own scheduling, lifecycle, transport,
 * canonical stores, and durable recovery state. Both the active Studio page
 * and the Chrome service worker execute this exact transition order.
 */
(function (global) {
  'use strict';

  if (global.H2OSyncLinearReconcileCore) return;

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function transitionBlock(stage, result, allowedAbsentCodes) {
    if (!result || typeof result !== 'object') {
      return Object.freeze({
        verdict: 'blocked',
        blockedStage: stage,
        errorCode: 'automatic-transition-result-invalid'
      });
    }
    var verdict = clean(result.verdict).toLowerCase();
    var errorCode = clean(result.errorCode || result.reason);
    if (allowedAbsentCodes && allowedAbsentCodes.has(errorCode)) return null;
    var divergent = result.divergent === true ||
      verdict.indexOf('divergent') !== -1 ||
      verdict.indexOf('conflict') !== -1;
    if (result.ok === false || divergent) {
      return Object.freeze({
        verdict: 'blocked',
        blockedStage: stage,
        errorCode: errorCode || verdict || 'automatic-transition-blocked'
      });
    }
    return null;
  }

  async function reconcileOneObject(options) {
    var input = options && typeof options === 'object' ? options : {};
    var mayMutate = input.mayMutate;
    var receive = input.receive;
    var apply = input.apply;
    var resolveAnchor = input.resolveAnchor;
    var publish = input.publish;
    if (typeof mayMutate !== 'function' || typeof receive !== 'function' ||
        typeof apply !== 'function' || typeof resolveAnchor !== 'function' ||
        typeof publish !== 'function') {
      throw new Error('automatic-runtime-unavailable');
    }

    var objectId = clean(input.objectId);
    if (!await mayMutate()) return Object.freeze({ verdict: 'stale' });
    var received = await receive();
    var receiveBlock = transitionBlock(
      'receive',
      received,
      input.allowedReceiveAbsentCodes || null
    );
    if (receiveBlock) return receiveBlock;
    var receivedObjectId = clean(received && received.objectId);
    if (receivedObjectId && objectId && receivedObjectId !== objectId) {
      return Object.freeze({
        verdict: 'blocked',
        blockedStage: 'object-scope',
        errorCode: 'automatic-object-scope-conflict',
        received: received
      });
    }
    if (receivedObjectId) {
      objectId = receivedObjectId;
    }
    if (!objectId && typeof input.resolveObjectId === 'function') {
      objectId = clean(await input.resolveObjectId(received));
    }
    if (!objectId) {
      return Object.freeze({ verdict: 'no-active-object', received: received });
    }

    if (!await mayMutate()) return Object.freeze({ verdict: 'stale' });
    var applied = await apply(objectId);
    var applyBlock = transitionBlock('apply', applied);
    if (applyBlock) return applyBlock;

    var anchor = await resolveAnchor(objectId);
    if (!anchor) {
      return Object.freeze({
        verdict: 'empty-canonical',
        objectId: objectId,
        received: received,
        applied: applied
      });
    }
    if (anchor.classification === 'CANONICAL_STATE_CONTRADICTION') {
      throw new Error('canonical-state-contradiction');
    }
    if (!anchor.localPublishedMatch && !anchor.remoteAppliedMatch) {
      if (!await mayMutate()) return Object.freeze({ verdict: 'stale' });
      var published = await publish(objectId, anchor.revisionId);
      var publishBlock = transitionBlock('publish', published);
      if (publishBlock) return publishBlock;
      return Object.freeze({
        verdict: 'reconciled',
        objectId: objectId,
        received: received,
        applied: applied,
        published: published,
        anchor: anchor.classification
      });
    }
    return Object.freeze({
      verdict: 'reconciled-no-publication',
      objectId: objectId,
      received: received,
      applied: applied,
      anchor: anchor.classification
    });
  }

  global.H2OSyncLinearReconcileCore = Object.freeze({
    reconcileOneObject: reconcileOneObject,
    transitionBlock: transitionBlock
  });
})(globalThis);
