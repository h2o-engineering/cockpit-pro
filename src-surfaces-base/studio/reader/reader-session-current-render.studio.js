/*
 * @module reader-session-current-render.studio.js
 * @owner L-STUDIO-READER
 * @contract h2o.studio.reader-session-current-render.v1
 *
 * Candidate-2 T02: page-lifetime Reader session/current-render authority.
 * Renderer retains render-result/Semantic-Index/DecorationContribution and
 * presentation resolution. Shell retains route/host/container/.wbMain.
 * No durable persistence, MiniMap, Sync, or Authoring ownership is introduced.
 */
(() => {
  "use strict";
  const W = window;
  const H2O = W.H2O = W.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.readerSessionCurrentRender) {
    throw new Error("reader-session-current-render: duplicate admission");
  }

  const OWNED_KEYS = Object.freeze([
    "currentReaderSnapshot",
    "currentReaderRender",
    "currentReaderNavigationTarget",
    "readerResume",
    "readerPresentationUnsubscribe",
  ]);
  const ownedState = {
    currentReaderSnapshot: null,
    currentReaderRender: null,
    currentReaderNavigationTarget: null,
    readerResume: null,
    readerPresentationUnsubscribe: null,
  };
  let shellState = null;
  let ports = null;

  const state = new Proxy(ownedState, {
    get(target, key) {
      if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
      return shellState ? shellState[key] : undefined;
    },
    set(target, key, value) {
      if (Object.prototype.hasOwnProperty.call(target, key)) { target[key] = value; return true; }
      if (!shellState) throw new Error("reader-session-current-render: not configured");
      shellState[key] = value;
      return true;
    },
  });
  const $ = (selector) => document.querySelector(selector);

  function requirePort(name) {
    const fn = ports && ports[name];
    if (typeof fn !== "function") throw new Error(`reader-session-current-render: missing port ${name}`);
    return fn;
  }
  // These are dependency ports, not Reader-owned implementations. Their names
  // intentionally match the retained studio.js seams so extracted behavioral
  // harnesses can continue to provide the same collaborators.
  function getStudioChatRenderer(){ return requirePort("getStudioChatRenderer")(); }
  function haveEquivalentRendererEditOverrides(a, b){ return requirePort("haveEquivalentRendererEditOverrides")(a, b); }
  function getReaderPresentationPreference(){ return requirePort("getReaderPresentationPreference")(); }
  function renderReader(snapshotId){ return requirePort("renderReader")(snapshotId); }

  function configure(input = {}) {
    if (!input.state || typeof input.state !== "object") throw new Error("reader-session-current-render: state port required");
    for (const name of ["getStudioChatRenderer", "haveEquivalentRendererEditOverrides", "getReaderPresentationPreference", "renderReader"]) {
      if (typeof input[name] !== "function") throw new Error(`reader-session-current-render: ${name} port required`);
    }
    if (shellState && shellState !== input.state) throw new Error("reader-session-current-render: already configured");
    shellState = input.state;
    ports = Object.freeze({
      getStudioChatRenderer: input.getStudioChatRenderer,
      haveEquivalentRendererEditOverrides: input.haveEquivalentRendererEditOverrides,
      getReaderPresentationPreference: input.getReaderPresentationPreference,
      renderReader: input.renderReader,
    });
    for (const key of OWNED_KEYS) {
      const existing = Object.getOwnPropertyDescriptor(shellState, key);
      if (existing && !(existing.get && existing.set)) throw new Error(`reader-session-current-render: Shell state already owns ${key}`);
      if (!existing) Object.defineProperty(shellState, key, {
        enumerable: true,
        configurable: false,
        get() { return ownedState[key]; },
        set(value) { ownedState[key] = value; },
      });
    }
    return true;
  }

function bindReaderSemanticIndex(rendererResult){
  state.currentReaderNavigationTarget = null;
  const root = rendererResult?.root;
  const semanticIndex = rendererResult?.semanticIndex;
  const decorationContributions = rendererResult?.decorationContributions;
  const presentation = rendererResult?.presentation;
  state.currentReaderRender = root && semanticIndex && typeof semanticIndex === "object"
    ? Object.freeze({
      root,
      semanticIndex,
      decorationContributions: decorationContributions && typeof decorationContributions === "object" ? decorationContributions : null,
      /* M04 P2 T4: the render's frozen presentation descriptor (effective
       * profile id, profile version, sealed registry token) - the mounted
       * configuration the reuse decision compares against. */
      presentation: presentation && typeof presentation === "object" ? presentation : null,
    })
    : null;
}

function getReaderSemanticIndex(root){
  const current = state.currentReaderRender;
  if (!current) return null;
  if (root !== undefined && root !== current.root) return null;
  return current.semanticIndex;
}

function getReaderDecorationContributions(root){
  const current = state.currentReaderRender;
  if (!current) return null;
  if (root !== undefined && root !== current.root) return null;
  return current.decorationContributions || null;
}

function disposeReaderRenderDecorations(reason){
  const lifecycle = state.currentReaderRender?.decorationContributions;
  if (!lifecycle || typeof lifecycle.disposeAll !== "function") return;
  try {
    lifecycle.disposeAll();
  } catch (error) {
    try { console.warn("[studio] reader decoration cleanup reported a failure", reason, error); } catch {}
  }
}

function createReaderResumeController(){
  const CAPACITY = 16;
  const TOMBSTONE_CAPACITY = 16;
  const READING_LINE_OFFSET_PX = 120;
  const PRE_LEAVE_REASONS = new Set([
    "studio:route-scope:list",
    "studio:route-scope:library",
    "studio:route-scope:migrate",
    "studio:route-scope:settings",
  ]);
  const ledger = new Map();
  const tombstones = new Map();

  const text = value => String(value == null ? "" : value).trim();
  const finite = value => Number.isFinite(Number(value));
  const clampFraction = value => Math.max(0, Math.min(0.9999, Number(value) || 0));
  const freezeValue = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freezeValue(child);
    return Object.freeze(value);
  };

  function currentBinding(){
    const current = state.currentReaderRender;
    const root = current?.root;
    const index = current?.semanticIndex;
    const reader = document.getElementById("viewReader");
    if (state.activeRoute !== "reader"
      || !root?.isConnected
      || !reader?.contains(root)
      || W.H2O?.studioHost?.getReaderRoot?.() !== root
      || !index
      || typeof index.getConversation !== "function"
      || typeof index.turns !== "function") return null;
    const conversation = index.getConversation();
    const chatId = text(conversation?.sourceRef?.chatId);
    const snapshotId = text(conversation?.sourceRef?.snapshotId);
    const turns = index.turns();
    if (!chatId || !snapshotId || !Array.isArray(turns)) return null;
    return { root, index, conversation, chatId, snapshotId, turns };
  }

  function turnRef(binding, turn){
    if (!turn || !binding.turns.includes(turn)) return null;
    const message = binding.index.getMessage?.(turn.messageKey);
    if (!message || message.turnKey !== turn.projectionKey) return null;
    const projectionKey = text(turn.projectionKey);
    const role = text(turn.role);
    const ordinal = Number(turn.ordinal);
    const turnNo = Number(turn.turnNo);
    if (!projectionKey || !role || !Number.isInteger(ordinal) || ordinal < 0 || !finite(turnNo) || turnNo <= 0) return null;
    return freezeValue({
      projectionKey,
      ordinal,
      turnNo,
      role,
      messageId: text(message.sourceRef?.messageId) || null,
      turnId: text(turn.sourceRef?.turnId || message.sourceRef?.turnId) || null,
    });
  }

  function selectedRef(binding){
    const target = state.currentReaderNavigationTarget;
    if (target?.currentRendererRoot !== binding.root) return null;
    const turn = binding.index.getTurn?.(target.projectionKey);
    if (!turn?.target?.isConnected || !binding.root.contains(turn.target)) return null;
    return turnRef(binding, turn);
  }

  function scrollMetrics(binding){
    const scroller = binding.root.closest?.(".wbMain");
    if (!scroller?.isConnected || typeof scroller.getBoundingClientRect !== "function") return null;
    const bounds = scroller.getBoundingClientRect();
    const style = W.getComputedStyle?.(scroller);
    const paddingTop = Number.parseFloat(style?.paddingTop || "0") || 0;
    const paddingBottom = Number.parseFloat(style?.paddingBottom || "0") || 0;
    const contentTop = bounds.top + (Number(scroller.clientTop) || 0) + paddingTop;
    const contentBottom = bounds.top + (Number(scroller.clientTop) || 0)
      + (Number(scroller.clientHeight) || 0) - paddingBottom;
    if (!finite(contentTop) || !finite(contentBottom) || contentBottom <= contentTop) return null;
    return { scroller, contentTop, contentBottom, readingLine: contentTop + READING_LINE_OFFSET_PX };
  }

  function turnGeometry(binding, turn){
    if (!turn?.target?.isConnected || !binding.root.contains(turn.target)) return null;
    const geometry = binding.index.getGeometry?.(turn.projectionKey);
    if (!geometry
      || geometry.coordinateSpace !== "viewport"
      || !finite(geometry.top)
      || !finite(geometry.bottom)
      || !finite(geometry.height)
      || !finite(geometry.width)
      || Number(geometry.height) <= 0
      || Number(geometry.width) <= 0) return null;
    return geometry;
  }

  function visibleTurnGeometry(binding, turn, metrics){
    const geometry = turnGeometry(binding, turn);
    if (!geometry
      || Number(geometry.bottom) <= metrics.contentTop
      || Number(geometry.top) >= metrics.contentBottom) return null;
    return geometry;
  }

  function viewportObservation(binding){
    const metrics = scrollMetrics(binding);
    if (!metrics) return null;
    const visible = [];
    for (const turn of binding.turns) {
      const geometry = visibleTurnGeometry(binding, turn, metrics);
      if (geometry) visible.push({ turn, geometry });
    }
    if (!visible.length) return null;
    let anchor = null;
    for (const row of visible) {
      if (Number(row.geometry.top) <= metrics.readingLine) anchor = row;
    }
    if (!anchor) {
      const ref = turnRef(binding, visible[0].turn);
      return ref ? freezeValue({ ref, fraction: 0 }) : null;
    }
    const ref = turnRef(binding, anchor.turn);
    if (!ref) return null;
    return freezeValue({
      ref,
      fraction: clampFraction((metrics.readingLine - Number(anchor.geometry.top)) / Number(anchor.geometry.height)),
    });
  }

  function capture(reason){
    const normalizedReason = text(reason);
    if (normalizedReason !== "studio:reader-replace" && !PRE_LEAVE_REASONS.has(normalizedReason)) return "NOT_CAPTURED";
    const binding = currentBinding();
    if (!binding || tombstones.has(binding.chatId)) return "NOT_CAPTURED";
    const record = freezeValue({
      content: { chatId: binding.chatId, snapshotId: binding.snapshotId },
      render: { renderMode: text(binding.index.renderMode), turnCount: binding.turns.length },
      selection: selectedRef(binding),
      viewport: viewportObservation(binding),
    });
    ledger.delete(binding.chatId);
    ledger.set(binding.chatId, record);
    while (ledger.size > CAPACITY) ledger.delete(ledger.keys().next().value);
    return "CAPTURED";
  }

  function resolve(record, ref, binding){
    if (!record || !ref || record.content?.chatId !== binding.chatId) return null;
    const storedMessageId = text(ref.messageId);
    const storedTurnId = text(ref.turnId);
    const storedRole = text(ref.role);
    if (storedMessageId || storedTurnId) {
      const primary = storedMessageId ? "messageId" : "turnId";
      const wanted = storedMessageId || storedTurnId;
      let candidates = binding.turns.filter(turn => {
        const current = turnRef(binding, turn);
        if (!current || current.role !== storedRole || text(current[primary]) !== wanted) return false;
        if (storedMessageId && storedTurnId && current.messageId && current.turnId && current.turnId !== storedTurnId) return false;
        return true;
      });
      if (candidates.length > 1) {
        if (record.content?.snapshotId !== binding.snapshotId
          || record.render?.renderMode !== text(binding.index.renderMode)) return null;
        candidates = candidates.filter(turn => turn.projectionKey === ref.projectionKey);
      }
      return candidates.length === 1 ? { outcome: "RESTORED_IDENTITY", turn: candidates[0] } : null;
    }
    if (record.content?.snapshotId !== binding.snapshotId
      || record.render?.renderMode !== text(binding.index.renderMode)
      || record.render?.turnCount !== binding.turns.length
      || !Number.isInteger(ref.ordinal)) return null;
    const turn = binding.turns[ref.ordinal];
    const current = turnRef(binding, turn);
    if (!current
      || current.messageId
      || current.turnId
      || current.projectionKey !== ref.projectionKey
      || current.role !== storedRole
      || current.turnNo !== ref.turnNo) return null;
    return { outcome: "RESTORED_STRUCTURAL", turn };
  }

  function clearSelection(binding){
    for (const turn of binding.root.querySelectorAll?.("[data-turn]") || []) turn.classList.remove("is-ribbon-selected");
    state.currentReaderNavigationTarget = null;
    const ribbon = W.H2O?.Studio?.ribbon;
    if (typeof ribbon?.setContext === "function") {
      ribbon.setContext(Object.assign({}, ribbon.getContext?.() || {}, {
        selectedMessageId: null,
        selectedTurnIdx: null,
      }));
    }
  }

  function restoreViewport(record, binding){
    const resolved = resolve(record, record?.viewport?.ref, binding);
    if (!resolved) return "NOT_RESTORED";
    const metrics = scrollMetrics(binding);
    if (!metrics) return "NOT_RESTORED";
    const geometry = turnGeometry(binding, resolved.turn);
    if (!geometry) return "NOT_RESTORED";
    const fraction = clampFraction(record.viewport.fraction);
    metrics.scroller.scrollTo({
      top: Number(metrics.scroller.scrollTop || 0)
        + Number(geometry.top) + Number(geometry.height) * fraction - metrics.readingLine,
      left: Number(metrics.scroller.scrollLeft || 0),
      behavior: "auto",
    });
    return resolved.outcome;
  }

  function restore(){
    const binding = currentBinding();
    if (!binding) return freezeValue({ selection: "NOT_RESTORED", viewport: "NOT_RESTORED" });
    tombstones.delete(binding.chatId);
    const record = ledger.get(binding.chatId) || null;
    const selection = resolve(record, record?.selection, binding);
    let selectionOutcome = "NOT_RESTORED";
    if (selection) {
      const allTurns = Array.from(binding.root.querySelectorAll("[data-turn]"));
      if (publishReaderTurnSelection(binding.root, selection.turn, allTurns)) selectionOutcome = selection.outcome;
      else clearSelection(binding);
    } else {
      clearSelection(binding);
    }
    const viewportOutcome = restoreViewport(record, binding);
    return freezeValue({ selection: selectionOutcome, viewport: viewportOutcome });
  }

  function forget(chatKey){
    const key = text(chatKey);
    if (!key) return false;
    ledger.delete(key);
    tombstones.delete(key);
    tombstones.set(key, true);
    while (tombstones.size > TOMBSTONE_CAPACITY) tombstones.delete(tombstones.keys().next().value);
    return true;
  }

  return Object.freeze({ remember: capture, restore, forget });
}

function isCurrentReaderRoot(root, snap){
  if (!root?.isConnected) return false;
  const readerEl = $("#viewReader");
  if (!readerEl || typeof readerEl.contains !== "function" || !readerEl.contains(root)) return false;

  const currentSnapshotId = String(state.currentReaderSnapshot?.snapshotId || "");
  const expectedSnapshotId = String(snap?.snapshotId || "");
  if (!currentSnapshotId || currentSnapshotId !== expectedSnapshotId) return false;

  const getHostRoot = W.H2O?.studioHost?.getReaderRoot;
  if (typeof getHostRoot === "function" && getHostRoot() !== root) return false;
  return true;
}

function getReusableReaderMount(snap){
  const snapshotId = String(snap?.snapshotId || "").trim();
  const currentSnapshotId = String(state.currentReaderSnapshot?.snapshotId || "").trim();
  if (!snapshotId || snapshotId !== currentSnapshotId) return null;

  const host = W.H2O?.studioHost;
  if (
    typeof host?.getReaderRoot !== "function"
    || typeof host?.getTurnsRoot !== "function"
    || typeof host?.getScrollRoot !== "function"
    || typeof host?.updateSnapshot !== "function"
  ) return null;

  const root = host.getReaderRoot();
  const turnsEl = host.getTurnsRoot();
  const scrollEl = host.getScrollRoot();
  const readerEl = $("#viewReader");
  if (!root?.isConnected || !turnsEl?.isConnected || !scrollEl?.isConnected) return null;
  if (!readerEl || typeof readerEl.contains !== "function" || !readerEl.contains(root)) return null;
  if (typeof root.contains !== "function" || !root.contains(turnsEl) || !root.contains(scrollEl)) return null;
  const selectors = W.H2O?.Studio?.SELECTORS || {};
  const testIdAttr = selectors.ATTR?.TESTID || "data-testid";
  const turnsTestId = selectors.TESTIDS?.CONVERSATION_TURNS || "conversation-turns";
  if (root.getAttribute?.("data-h2o-studio-reader") !== "1") return null;
  if (turnsEl.getAttribute?.(testIdAttr) !== turnsTestId) return null;
  if (scrollEl.getAttribute?.("data-scroll-root") !== "1") return null;
  return { root, turnsEl, scrollEl };
}

function isReusableReaderMountCurrent(mount, snap){
  if (!mount) return false;
  const current = getReusableReaderMount(snap);
  return !!(
    current
    && current.root === mount.root
    && current.turnsEl === mount.turnsEl
    && current.scrollEl === mount.scrollEl
  );
}

function isReaderPresentationCurrent(request){
  const mounted = state.currentReaderRender?.presentation;
  const renderer = getStudioChatRenderer();
  if (!mounted || typeof renderer.describePresentation !== "function") return false;
  let expected = null;
  try { expected = renderer.describePresentation(request); } catch { return false; }
  /* The mounted descriptor carries the sealed registry token; a pre-seal
   * (null) token can never equal it, so it never justifies reuse. */
  return !!(
    expected
    && typeof mounted.registryDigest === "string"
    && mounted.registryDigest
    && mounted.registryDigest === expected.registryDigest
    && mounted.effectiveId === expected.effectiveId
    && mounted.profileVersion === expected.profileVersion
  );
}

function canReuseReaderDOM(options){
  options = options && typeof options === "object" ? options : {};
  const renderer = getStudioChatRenderer();
  return !!(
    options.mount
    && options.token === state.renderToken
    && state.activeRoute === "reader"
    && state.currentReaderSnapshot === options.previousSnapshot
    && isReusableReaderMountCurrent(options.mount, options.previousSnapshot)
    && renderer.isRenderEquivalent(options.previousSnapshot, options.rendererInput)
    && haveEquivalentRendererEditOverrides(options.previousEditOverrides, options.nextEditOverrides)
    && isReaderPresentationCurrent(options.presentationProfile)
  );
}

function refreshReaderPresentation(){
  if (state.activeRoute !== "reader" || !state.currentReaderRender) return;
  const snapshotId = String(state.currentReaderSnapshot?.snapshotId || "").trim();
  if (!snapshotId) return;
  if (isReaderPresentationCurrent(getReaderPresentationPreference())) return;
  renderReader(snapshotId).catch(console.error);
}

function subscribeReaderToPresentationPreference(){
  if (typeof state.readerPresentationUnsubscribe === "function") return;
  const appearance = W.H2O?.Studio?.appearance;
  if (typeof appearance?.subscribe !== "function") return;
  const unsubscribe = appearance.subscribe((event) => {
    if (!event) return;
    if (event.type !== "ready" && !(event.type === "change" && event.key === "presentationProfile")) return;
    refreshReaderPresentation();
  });
  state.readerPresentationUnsubscribe = typeof unsubscribe === "function" ? unsubscribe : function () {};
}

function resolveReaderNavigationTarget(target){
  const root = target?.currentRendererRoot;
  if (!root || !isCurrentReaderRoot(root, state.currentReaderSnapshot)) return null;
  const index = getReaderSemanticIndex(root);
  const turn = index?.getTurn(target.projectionKey);
  if (!turn?.target?.isConnected || !root.contains(turn.target)) return null;
  const message = index.getMessage(turn.messageKey);
  if (!message?.target?.isConnected || !root.contains(message.target) || message.turnKey !== turn.projectionKey) return null;
  return { root, index, turn };
}

function getReaderNavigationTarget(element){
  const root = state.currentReaderRender?.root;
  if (!element?.isConnected || !root || !root.contains(element)) return null;
  const turn = getReaderSemanticIndex(root)?.turns().find(record => record.target === element || record.target.contains(element));
  const target = turn ? Object.freeze({ currentRendererRoot: root, projectionKey: turn.projectionKey }) : null;
  return resolveReaderNavigationTarget(target) ? target : null;
}

function publishReaderTurnSelection(root, turnRecord, allTurns){
  const target = Object.freeze({ currentRendererRoot: root, projectionKey: turnRecord.projectionKey });
  const resolved = resolveReaderNavigationTarget(target);
  if (!resolved || resolved.turn !== turnRecord) return null;
  const turn = turnRecord.target;
  const turnIdx = allTurns.indexOf(turn) + 1;
  if (turnIdx <= 0) return null;
  const message = resolved.index.getMessage(turnRecord.messageKey);
  const messageId = String(message.sourceRef?.messageId || '').trim();
  const editModeOn = document.querySelector('.wbReader')?.dataset?.editMode === 'on';
  if (!editModeOn) {
    for (const el of allTurns) el.classList.remove('is-ribbon-selected');
    turn.classList.add('is-ribbon-selected');
  }
  state.currentReaderNavigationTarget = target;
  const ribbon = W.H2O?.Studio?.ribbon;
  if (typeof ribbon?.setContext === 'function') {
    ribbon.setContext(Object.assign({}, ribbon.getContext(), {
      selectedMessageId: messageId || null,
      selectedTurnIdx: turnIdx,
    }));
  }
  return { turnIdx, editModeOn };
}

function readerNearestScrollDelta(start, end, viewportStart, viewportEnd){
  if ((start >= viewportStart && end <= viewportEnd) || (start < viewportStart && end > viewportEnd)) return 0;
  const smaller = end - start <= viewportEnd - viewportStart;
  return (start < viewportStart && smaller) || (end > viewportEnd && !smaller)
    ? start - viewportStart : end - viewportEnd;
}

function goToReaderTarget(target, options){
  const resolved = resolveReaderNavigationTarget(target);
  if (!resolved) return false;
  const { root, turn } = resolved;
  // Shell owns this structural scroll context. The Host's transcript
  // data-scroll-root marker has overflow:visible on the current Reader route.
  const scrollRoot = root.closest('.wbMain');
  if (!scrollRoot?.isConnected) return false;
  const allTurns = Array.from(root.querySelectorAll('[data-turn]'));
  if (!publishReaderTurnSelection(root, turn, allTurns)) return false;
  const element = turn.target;
  if (options?.preserveFocus !== true) {
    const temporary = !element.hasAttribute('tabindex');
    if (temporary) {
      element.setAttribute('tabindex', '-1');
      element.addEventListener('blur', () => {
        if (element.getAttribute('tabindex') === '-1') element.removeAttribute('tabindex');
      }, { once: true });
    }
    element.focus({ preventScroll: true });
  }
  const viewport = scrollRoot.getBoundingClientRect();
  const bounds = element.getBoundingClientRect();
  const top = viewport.top + scrollRoot.clientTop;
  const left = viewport.left + scrollRoot.clientLeft;
  const reducedMotion = W.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  scrollRoot.scrollTo({
    top: scrollRoot.scrollTop + readerNearestScrollDelta(bounds.top, bounds.bottom, top, top + scrollRoot.clientHeight),
    left: scrollRoot.scrollLeft + readerNearestScrollDelta(bounds.left, bounds.right, left, left + scrollRoot.clientWidth),
    behavior: options?.behavior === 'smooth' && !reducedMotion ? 'smooth' : 'auto',
  });
  return true;
}

function stepReaderTarget(direction, options){
  const root = state.currentReaderRender?.root;
  const turns = getReaderSemanticIndex(root)?.turns();
  if (!root || !turns?.length) return false;
  const current = resolveReaderNavigationTarget(state.currentReaderNavigationTarget);
  const position = current ? turns.indexOf(current.turn) : -1;
  const next = position < 0 ? (direction > 0 ? 0 : turns.length - 1) : position + direction;
  const turn = turns[next];
  return turn ? goToReaderTarget({ currentRendererRoot: root, projectionKey: turn.projectionKey }, options) : false;
}

function nextReaderTarget(options){ return stepReaderTarget(1, options); }

function previousReaderTarget(options){ return stepReaderTarget(-1, options); }

  const api = Object.freeze({
    contract: "h2o.studio.reader-session-current-render.v1",
    owner: "L-STUDIO-READER",
    configure,
    bindReaderSemanticIndex,
    getReaderSemanticIndex,
    getReaderDecorationContributions,
    disposeReaderRenderDecorations,
    createReaderResumeController,
    isCurrentReaderRoot,
    getReusableReaderMount,
    isReusableReaderMountCurrent,
    isReaderPresentationCurrent,
    canReuseReaderDOM,
    refreshReaderPresentation,
    subscribeReaderToPresentationPreference,
    resolveReaderNavigationTarget,
    getReaderNavigationTarget,
    publishReaderTurnSelection,
    readerNearestScrollDelta,
    goToReaderTarget,
    stepReaderTarget,
    nextReaderTarget,
    previousReaderTarget,
  });
  H2O.Studio.readerSessionCurrentRender = api;
})();
