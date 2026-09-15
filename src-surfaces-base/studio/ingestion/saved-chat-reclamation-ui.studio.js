/* H2O Studio — Saved Chat Storage / Reclamation overview (M06 P2 T2.4)
 *
 * New UI only. A read-only operator surface mounted as a sibling beneath the
 * Archive Health card, following the same pattern as the inspector, importer
 * and exporter cards.
 *
 * READ-ONLY AND ANALYZE ONLY. This card exposes exactly one action — Analyze —
 * and no destructive control of any kind exists here, not even a disabled one:
 * G02 requires destructive UI to remain invisible until it is activated, and a
 * dormant "Reclaim" button would already be destructive UI.
 *
 * It decides nothing. Every judgement is made by trusted Rust:
 *
 *   - the current-projection verdict comes from the existing
 *     probeCurrentSavedChatProjectionV1 producer (no second contentHash or
 *     projection implementation is added here);
 *   - protection, candidacy, the K=3 floor and the on-disk projection witness
 *     are decided by h2o_archive_reclamation_preview;
 *   - residue evidence comes from the composed T1.3 diagnostics, which covers
 *     BOTH residue families — the durable-temp probe alone is not the whole
 *     residue picture.
 *
 * The renderer's package inventory is used ONLY to decide which chats to ask
 * the projection producer about. It is never reclamation authority: projection
 * facts are enabling-only, so a chat the inventory misses simply fails closed
 * and is protected. Nothing here is truncated to fit a UI limit.
 *
 * Contracts: docs/systems/archive/saved-chat-reclamation.md
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.reclamationUi && H2O.Studio.reclamationUi.__installed) return;

  var MODULE_VERSION = '0.2.0-m06-p4-t4.1';
  var PREVIEW_COMMAND = 'h2o_archive_reclamation_preview';
  var PREVIEW_SCHEMA = 'h2o.m06.reclamationPreview';
  /* M06 P4 T4.1 — the two commands Human Decision Authority approved at G02.
   * There is deliberately no third: stale-quarantine recovery is an internal
   * stage of the reclamation run, not a control, and canonical CAS has no
   * destructive command at all. */
  var EXECUTE_COMMAND = 'h2o_archive_reclamation_execute';
  var OCCUPANT_COMMAND = 'h2o_archive_occupant_quarantine';
  /* This surface owns NO package-name grammar. Whether a row is the governed
   * operator-remedy occupant class, and what chat identity addresses it, are
   * both decided trusted-side and arrive on the Analyze row as
   * `occupant_remedy`. The renderer never parses a basename. */

  var TEXT = {
    reclaimButton: 'Reclaim…',
    reclaimNeedsAnalyze: 'Run Analyze first.',
    reclaimRunning: 'Reclaiming…',
    reclaimHeading: 'Reclamation result',
    occupantButton: 'Quarantine occupant…',
    occupantHeading: 'Occupant result',
    /* Quarantine is not deletion. One-run dwell means the occupant is still
     * physically present, and the operator is told exactly that. */
    occupantQuarantined: 'Quarantined and preserved in the archive quarantine. '
      + 'It is not deleted; a later reclamation run may clear it.',
    title: 'Storage & reclamation',
    subtitle: 'Analyze is read-only. Reclaim removes eligible generations and residue, '
      + 'and always re-checks the archive before acting.',
    idle: 'Analyze the archive to see what is protected and what is currently eligible under the retention policy.',
    loading: 'Analyzing archive…',
    unavailable: 'Archive analysis is available in Desktop Studio only.',
    analyzeButton: 'Analyze archive',
    error: 'Could not complete the analysis.',
    stale: 'Archive state may have changed. Run Analyze again to see current eligibility.',
    incomplete: 'This analysis is incomplete. The results below are not authoritative.',
    completeEmpty: 'Analysis complete. Nothing is currently eligible under the retention policy.',
    noPackages: 'No saved chat packages found yet.',
    candidateNote: 'Eligible means the engine currently considers it within policy. '
      + 'Nothing has been removed by this analysis.',
    casNote: 'Analysis only. Reclaim never removes content-addressed objects.',
    residueIncomplete: 'Residue enumeration was incomplete, so this is not a complete residue count.',
  };

  /* Presentation token for the inline occupant remedy control.
   *
   * `studio.css` resets EVERY button to `border:0;background:none;color:inherit`,
   * so a control with no style of its own is indistinguishable from the plain
   * spans it sits beside — which is exactly how this action shipped unusable.
   * The border / background / radius / `cursor:pointer` set is the same one the
   * sibling Archive Health and Materializer cards already use; only the padding
   * is compacted, because this control is inline in an 11px monospace row
   * rather than a standalone card button.
   *
   * Presentation only. It confers no authority: the control is still created
   * solely for a trusted-hinted row, still carries identity-only data
   * attributes, and the trusted command still re-derives and re-classifies its
   * target under exclusive ownership before acting. */
  var OCCUPANT_BUTTON_STYLE = 'margin-left:8px;padding:2px 8px;border-radius:6px;cursor:pointer;'
    + 'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;';

  function safeObject(value) {
    return (value && typeof value === 'object') ? value : {};
  }
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }
  function cleanString(value) {
    return (typeof value === 'string') ? value.trim() : '';
  }

  /* The trusted Preview command serializes its response with Rust field names,
   * so every multi-word key on the wire is snake_case. Normalize that exact
   * production shape once here; render code below consumes only this camelCase
   * view model and never guesses between wire spellings. Missing completeness
   * evidence remains false rather than being defaulted to apparent success. */
  function normalizePreviewWire(preview) {
    var p = safeObject(preview);
    var sources = safeObject(p.sources);
    var plan = safeObject(p.plan);
    var totals = safeObject(plan.totals);
    var cas = safeObject(plan.cas);
    function count(value) {
      return (typeof value === 'number' && isFinite(value)) ? value : 0;
    }
    return {
      schema: cleanString(p.schema),
      schemaVersion: p.schema_version,
      sources: {
        packageScanComplete: sources.package_scan_complete === true,
        packageScanBlockers: asArray(sources.package_scan_blockers),
        dbProbeComplete: sources.db_probe_complete === true,
        dbProbeBlockers: asArray(sources.db_probe_blockers),
        casInventoryComplete: sources.cas_inventory_complete === true,
        casInventoryBlockers: asArray(sources.cas_inventory_blockers),
      },
      plan: {
        schema: cleanString(plan.schema),
        schemaVersion: plan.schema_version,
        complete: plan.complete === true,
        retentionFloor: count(plan.retention_floor),
        blockers: asArray(plan.blockers),
        totals: {
          occupants: count(totals.occupants),
          protected: count(totals.protected),
          candidates: count(totals.candidates),
          excluded: count(totals.excluded),
          chatsInScope: count(totals.chats_in_scope),
          referencedCasObjects: count(totals.referenced_cas_objects),
        },
        decisions: asArray(plan.decisions).map(function (entry) {
          var d = safeObject(entry);
          var evidence = safeObject(d.evidence);
          var remedy = safeObject(d.occupant_remedy);
          var remedyChatId = cleanString(remedy.chat_id);
          return {
            path: cleanString(d.path),
            name: cleanString(d.name),
            chatId: cleanString(d.chat_id),
            contentHash: cleanString(d.content_hash),
            decision: cleanString(d.decision),
            reasons: asArray(d.reasons),
            reason: cleanString(d.reason),
            evidence: {
              currentProjectionContentHash: cleanString(evidence.current_projection_content_hash),
              contentObsolete: evidence.content_obsolete === true,
              familyRank: count(evidence.family_rank),
              retentionFloor: count(evidence.retention_floor),
              savedAt: cleanString(evidence.saved_at),
            },
            occupantRemedy: remedyChatId ? { chatId: remedyChatId } : null,
          };
        }),
        cas: {
          complete: cas.complete === true,
          observed: asArray(cas.observed),
          referenced: asArray(cas.referenced),
          observedUnreferenced: asArray(cas.observed_unreferenced),
          incompleteReasons: asArray(cas.incomplete_reasons),
        },
      },
    };
  }

  /* Every value that came back from a trusted command is DATA. It is written
   * with textContent, never interpolated into markup, so a path, blocker code
   * or reason string can never become executable. */
  function el(tag, text, style) {
    var node = global.document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (style) node.setAttribute('style', style);
    return node;
  }

  /* ── Analyze input assembly ───────────────────────────────────────────────
   * The chat set comes from the archive inventory purely to know WHICH chats
   * to probe. It is enabling-only: an omitted chat has no verdict and the
   * trusted engine fails it closed. Nothing is capped here — the bound lives
   * in the command, and an over-bound request must surface as a refusal
   * rather than a silent truncation. */
  function chatIdsFromDiagnostics(diagnostics) {
    var seen = {};
    var out = [];
    asArray(safeObject(diagnostics).packages).forEach(function (pkg) {
      var chatId = cleanString(safeObject(pkg).chatId);
      if (!chatId || seen[chatId]) return;
      seen[chatId] = true;
      out.push(chatId);
    });
    out.sort();
    return out;
  }

  async function collectProjections(chatIds, probe) {
    var out = [];
    for (var i = 0; i < chatIds.length; i += 1) {
      var chatId = chatIds[i];
      var verdict = { status: 'indeterminate', contentHash: '' };
      try {
        /* The EXISTING producer. No projection or contentHash logic is
         * implemented in this card. */
        var probed = safeObject(await probe({ chatId: chatId }));
        verdict = {
          status: cleanString(probed.status) || 'indeterminate',
          contentHash: cleanString(probed.contentHash),
        };
      } catch (_) {
        /* A failed probe is reported honestly as indeterminate. It is never
         * upgraded to ok, and never backfilled with a historical package
         * hash — the engine must fail that chat closed. */
        verdict = { status: 'probe-failed', contentHash: '' };
      }
      out.push({ chatId: chatId, status: verdict.status, contentHash: verdict.contentHash });
    }
    return out;
  }

  function getInvoke() {
    var internals = global.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') return internals.invoke.bind(internals);
    var tauri = global.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke.bind(tauri.core);
    if (tauri && typeof tauri.invoke === 'function') return tauri.invoke.bind(tauri);
    return null;
  }

  /* ── Pure presentation model ──────────────────────────────────────────────
   * Derived ONLY from fields the trusted Preview actually returned. No
   * classification, retention or candidacy is recomputed here. */
  function formatPreviewOverview(preview) {
    var p = normalizePreviewWire(preview);
    var plan = safeObject(p.plan);
    var sources = safeObject(p.sources);
    var totals = safeObject(plan.totals);
    var cas = safeObject(plan.cas);
    var blockers = asArray(plan.blockers).map(cleanString).filter(Boolean);

    var sourcesComplete = sources.packageScanComplete === true
      && sources.dbProbeComplete === true;
    var complete = plan.complete === true && sourcesComplete;

    return {
      schema: cleanString(p.schema),
      schemaVersion: p.schemaVersion,
      complete: complete,
      /* An incomplete analysis is NEVER the same statement as "nothing is
       * eligible", so the two are distinct states rather than one message. */
      state: complete ? (totals.candidates ? 'eligible' : 'clean') : 'incomplete',
      retentionFloor: plan.retentionFloor,
      totals: {
        occupants: totals.occupants || 0,
        protected: totals.protected || 0,
        candidates: totals.candidates || 0,
        excluded: totals.excluded || 0,
        chatsInScope: totals.chatsInScope || 0,
      },
      sources: {
        packageScanComplete: sources.packageScanComplete === true,
        dbProbeComplete: sources.dbProbeComplete === true,
        casInventoryComplete: sources.casInventoryComplete === true,
        blockers: []
          .concat(asArray(sources.packageScanBlockers).map(cleanString))
          .concat(asArray(sources.dbProbeBlockers).map(cleanString))
          .concat(asArray(sources.casInventoryBlockers).map(cleanString))
          .filter(Boolean),
      },
      blockers: blockers,
      cas: {
        complete: cas.complete === true,
        observed: asArray(cas.observed).length,
        referenced: asArray(cas.referenced).length,
        observedUnreferenced: asArray(cas.observedUnreferenced),
        incompleteReasons: asArray(cas.incompleteReasons).map(cleanString).filter(Boolean),
      },
    };
  }

  /* One row per decision, preserving EVERY protection reason. Writing +
   * Import + Floor must not collapse into a generic "protected". */
  function formatDecisionRows(preview) {
    var plan = safeObject(normalizePreviewWire(preview).plan);
    return asArray(plan.decisions).map(function (entry) {
      var d = safeObject(entry);
      var evidence = safeObject(d.evidence);
      return {
        path: cleanString(d.path),
        name: cleanString(d.name),
        chatId: cleanString(d.chatId),
        decision: cleanString(d.decision),
        reasons: asArray(d.reasons).map(cleanString).filter(Boolean),
        exclusionReason: cleanString(d.reason),
        savedAt: cleanString(evidence.savedAt),
        familyRank: evidence.familyRank,
        /* Trusted display fact, passed through verbatim. Present only when the
         * trusted engine established this row is a generation-path occupant in
         * the governed remedy class, and it carries the identity the command
         * needs. Absent means: offer nothing. */
        occupantRemedy: (function () {
          var hint = safeObject(d.occupantRemedy);
          var chatId = cleanString(hint.chatId);
          return chatId ? { chatId: chatId } : null;
        }()),
      };
    }).sort(function (a, b) {
      if (a.path === b.path) return 0;
      return a.path < b.path ? -1 : 1;
    });
  }

  /* Residue comes from the COMPOSED T1.3 diagnostics, which covers
   * generation-staging AND durable-temp. The durable-temp probe alone would
   * under-report, so it is never used as the total on its own. */
  function formatResidueOverview(diagnostics) {
    var residue = safeObject(safeObject(diagnostics).residue);
    var entries = asArray(residue.entries).map(function (item) {
      var e = safeObject(item);
      return { path: cleanString(e.path), name: cleanString(e.name), kind: cleanString(e.kind) };
    });
    var kinds = {};
    entries.forEach(function (e) { if (e.kind) kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
    return {
      complete: residue.complete === true,
      count: typeof residue.count === 'number' ? residue.count : entries.length,
      entries: entries,
      kinds: kinds,
      unscanned: asArray(residue.unscanned).map(function (s) {
        var u = safeObject(s);
        return { root: cleanString(u.root), family: cleanString(u.family), reason: cleanString(u.reason) };
      }),
    };
  }

  function renderInto(container, overview, rows, residue, remedyRows, onOccupant) {
    container.textContent = '';
    var sub = el('div', TEXT.subtitle, 'opacity:.75;margin-bottom:8px');
    container.appendChild(sub);

    if (!overview.complete) {
      container.appendChild(el('div', TEXT.incomplete, 'color:#d29922;margin-bottom:6px'));
    } else if (!overview.totals.candidates) {
      container.appendChild(el('div', TEXT.completeEmpty, 'margin-bottom:6px'));
    }

    var counts = el('div', null, 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px');
    [
      ['Protected', overview.totals.protected],
      ['Eligible', overview.totals.candidates],
      ['Excluded', overview.totals.excluded],
      ['Chats analyzed', overview.totals.chatsInScope],
      ['Retention floor', overview.retentionFloor],
    ].forEach(function (pair) {
      var box = el('div', null, 'min-width:96px');
      box.appendChild(el('div', pair[0], 'opacity:.7;font-size:11px'));
      box.appendChild(el('div', pair[1]));
      counts.appendChild(box);
    });
    container.appendChild(counts);
    if (overview.totals.candidates) {
      container.appendChild(el('div', TEXT.candidateNote, 'opacity:.75;margin-bottom:8px'));
    }

    var src = el('div', null, 'margin-bottom:8px');
    src.appendChild(el('div', 'Trusted sources', 'opacity:.7;font-size:11px'));
    [
      ['Package scan', overview.sources.packageScanComplete],
      ['Database probe', overview.sources.dbProbeComplete],
      ['CAS inventory', overview.sources.casInventoryComplete],
    ].forEach(function (pair) {
      src.appendChild(el('div', pair[0] + ': ' + (pair[1] ? 'complete' : 'incomplete')));
    });
    container.appendChild(src);

    overview.blockers.concat(overview.sources.blockers).forEach(function (code) {
      container.appendChild(el('div', 'Blocker: ' + code, 'color:#f85149'));
    });

    var casBox = el('div', null, 'margin-top:8px');
    casBox.appendChild(el('div', 'Read-only CAS analysis', 'opacity:.7;font-size:11px'));
    casBox.appendChild(el('div', 'Observed objects: ' + overview.cas.observed));
    casBox.appendChild(el('div', 'Referenced: ' + overview.cas.referenced));
    casBox.appendChild(el('div', 'Observed unreferenced: ' + overview.cas.observedUnreferenced.length));
    casBox.appendChild(el('div', TEXT.casNote, 'opacity:.75'));
    if (!overview.cas.complete) {
      casBox.appendChild(el('div', 'CAS analysis incomplete.', 'color:#d29922'));
    }
    container.appendChild(casBox);

    var residueBox = el('div', null, 'margin-top:8px');
    residueBox.appendChild(el('div', 'Archive residue', 'opacity:.7;font-size:11px'));
    residueBox.appendChild(el('div', 'Total residue entries: ' + residue.count));
    Object.keys(residue.kinds).sort().forEach(function (kind) {
      residueBox.appendChild(el('div', kind + ': ' + residue.kinds[kind]));
    });
    residue.entries.forEach(function (entry) {
      residueBox.appendChild(el('div', entry.path, 'opacity:.8;font-family:monospace;font-size:11px'));
    });
    if (!residue.complete) {
      residueBox.appendChild(el('div', TEXT.residueIncomplete, 'color:#d29922'));
      residue.unscanned.forEach(function (u) {
        residueBox.appendChild(el('div', 'Not scanned: ' + u.root + ' ' + u.family, 'opacity:.75'));
      });
    }
    container.appendChild(residueBox);

    var details = el('div', null, 'margin-top:8px');
    rows.forEach(function (row) {
      var line = el('div', null, 'font-family:monospace;font-size:11px');
      line.appendChild(el('span', row.path));
      line.appendChild(el('span', '  ' + row.decision));
      var why = row.reasons.length ? row.reasons.join(', ') : row.exclusionReason;
      if (why) line.appendChild(el('span', '  ' + why));
      if (row.savedAt) line.appendChild(el('span', '  ' + row.savedAt));
      /* The governed occupant remedy, offered ONLY on rows the trusted plan
       * excluded as indeterminate at a generation path. */
      if (typeof onOccupant === 'function'
        && asArray(remedyRows).some(function (r) { return r.name === row.name; })) {
        /* PRESENTATION ONLY. The global Studio reset strips every button to
         * `border:0;background:none;color:inherit`, so an unstyled control
         * inlined among these monospace spans reads as ordinary text and
         * offers no affordance at all. This reuses the sibling Archive Health
         * / Materializer card token set — border, background, radius and
         * `cursor:pointer` — at the compact scale this 11px row needs. It
         * grants no authority: gating, identity and the listener below are
         * unchanged. */
        var action = el('button', TEXT.occupantButton, OCCUPANT_BUTTON_STYLE);
        action.setAttribute('type', 'button');
        action.setAttribute('data-h2o-action', 'quarantine-occupant');
        action.setAttribute('data-h2o-occupant', row.name);
        /* The whole trusted row is handed on, so the identity used to address
         * the command is the one the trusted parser proved. */
        action.addEventListener('click', function () { onOccupant(row); });
        line.appendChild(action);
      }
      details.appendChild(line);
    });
    container.appendChild(details);
  }

  /* The trusted run outcome, read as it is emitted. `RunOutcome` serializes
   * with Rust field names; `OccupantOutcome` carries `rename_all = camelCase`.
   * Both spellings are accepted for the few fields shown, so neither type's
   * committed serialization has to change to be displayed.
   *
   * Nothing here infers filesystem state: every number and every state comes
   * from the trusted result, and an unknown state is shown verbatim rather
   * than collapsed into a friendlier word. */
  function formatRunOutcome(outcome) {
    var o = safeObject(outcome);
    var residue = safeObject(o.residue);
    function num(a, b) {
      var v = typeof o[a] === 'number' ? o[a] : o[b];
      return typeof v === 'number' ? v : 0;
    }
    return {
      state: cleanString(o.state),
      runId: cleanString(o.run_id !== undefined ? o.run_id : o.runId),
      quarantined: num('quarantined', 'quarantined'),
      purged: num('purged', 'purged'),
      recovered: num('recovered', 'recovered'),
      residueQuarantined:
        (residue.generation_staging_quarantined || residue.generationStagingQuarantined || 0)
        + (residue.durable_temp_quarantined || residue.durableTempQuarantined || 0)
        + (residue.capability_probe_quarantined || residue.capabilityProbeQuarantined || 0),
      residuePurged:
        (residue.generation_staging_purged || residue.generationStagingPurged || 0)
        + (residue.durable_temp_purged || residue.durableTempPurged || 0)
        + (residue.capability_probe_purged || residue.capabilityProbePurged || 0),
      blockers: asArray(o.blockers).map(cleanString).filter(Boolean),
    };
  }

  function formatOccupantOutcome(outcome) {
    var o = safeObject(outcome);
    return {
      state: cleanString(o.state),
      occupantName: cleanString(o.occupantName !== undefined ? o.occupantName : o.occupant_name),
      classification: cleanString(o.classification),
      quarantined: o.quarantined === true,
      purged: o.purged === true,
      dwell: cleanString(o.dwell),
      blockers: asArray(o.blockers).map(cleanString).filter(Boolean),
    };
  }

  /* Which displayed rows may be offered the governed occupant remedy.
   *
   * Exactly those the TRUSTED engine marked, and nothing else. A VALID
   * generation, a legacy package, reserved infrastructure, staging or temp
   * residue and any foreign basename simply arrive without the hint. There is
   * no filename fallback: no hint, no control. And this remains convenience —
   * the trusted command re-derives and re-classifies before acting. */
  function occupantRemedyRows(rows) {
    return asArray(rows).filter(function (row) {
      return !!safeObject(safeObject(row).occupantRemedy).chatId;
    });
  }

  /* The chat identity the TRUSTED parser proved, carried on the row. */
  function chatIdOfOccupant(row) {
    return cleanString(safeObject(safeObject(row).occupantRemedy).chatId);
  }

  function mountReclamationCard(healthContainer, options) {
    if (!healthContainer || !global.document) return null;
    var container = healthContainer;
    var parent = healthContainer.parentNode;
    if (parent && typeof parent.appendChild === 'function') {
      var mount = (typeof parent.querySelector === 'function')
        ? parent.querySelector('[data-h2o-reclamation-mount="1"]') : null;
      if (!mount) {
        mount = global.document.createElement('div');
        mount.setAttribute('data-h2o-reclamation-mount', '1');
        mount.style.marginTop = '12px';
        parent.appendChild(mount);
      }
      /* Idempotent remount: the stable sibling owns exactly one card and one
       * set of controls/listeners even if the outer Settings mount re-enters. */
      mount.textContent = '';
      container = mount;
    }
    var opts = safeObject(options);
    var ingestion = safeObject(safeObject(H2O.Studio).ingestion);
    var diagnose = typeof opts.diagnose === 'function'
      ? opts.diagnose
      : ingestion.diagnoseSavedChatArchiveV1;
    var probe = typeof opts.probeProjection === 'function'
      ? opts.probeProjection
      : ingestion.probeCurrentSavedChatProjectionV1;
    var invoke = typeof opts.invoke === 'function' ? opts.invoke : getInvoke();
    /* The repository's established New-UI destructive guard is `window.confirm`
     * (Library Organization Modals uses it for every delete). Reused rather
     * than inventing a second modal framework; injectable for tests. */
    var confirmAction = typeof opts.confirm === 'function'
      ? opts.confirm
      : function (message) { return typeof global.confirm === 'function' ? global.confirm(message) : false; };

    var card = global.document.createElement('section');
    card.setAttribute('data-h2o-card', 'saved-chat-reclamation');
    card.appendChild(el('h3', TEXT.title));

    var body = el('div', TEXT.idle);
    var button = el('button', TEXT.analyzeButton);
    button.setAttribute('type', 'button');
    button.setAttribute('data-h2o-action', 'analyze-archive');
    var reclaim = el('button', TEXT.reclaimButton);
    reclaim.setAttribute('type', 'button');
    reclaim.setAttribute('data-h2o-action', 'reclaim-archive');
    /* Disabled until a successful, authoritative Analyze. Analyze never runs
     * this: there is no auto-execute, no timer and no idle callback. */
    reclaim.disabled = true;
    reclaim.title = TEXT.reclaimNeedsAnalyze;
    var result = el('div', '');
    card.appendChild(button);
    card.appendChild(reclaim);
    card.appendChild(body);
    card.appendChild(result);
    container.appendChild(card);

    if (typeof diagnose !== 'function' || typeof probe !== 'function' || !invoke) {
      body.textContent = TEXT.unavailable;
      button.disabled = true;
      reclaim.disabled = true;
      return {
        analyze: function () { return Promise.resolve(null); },
        execute: function () { return Promise.resolve(null); },
        quarantineOccupant: function () { return Promise.resolve(null); },
        getState: function () { return { state: 'unavailable' }; },
      };
    }

    /* One Analyze in flight at a time, and a monotonic token so a slow earlier
     * response can never overwrite a newer one. */
    var inFlight = false;
    var latestToken = 0;
    var state = { state: 'idle', preview: null };
    /* The ENABLING request the last successful Analyze used. Execute resends
     * exactly this: the same chat scope and projection assertions, never the
     * candidate list, never a path, never a plan. */
    var enablingRequest = null;
    var executing = false;

    function disarm(reason) {
      enablingRequest = null;
      reclaim.disabled = true;
      reclaim.title = reason || TEXT.reclaimNeedsAnalyze;
    }

    function invalidateAnalysis() {
      disarm();
      body.textContent = '';
      body.appendChild(el('div', TEXT.stale, 'color:#d29922'));
      state = { state: 'stale', preview: null };
    }

    async function analyze() {
      if (inFlight || executing) return null;
      inFlight = true;
      latestToken += 1;
      var token = latestToken;
      button.disabled = true;
      /* A new Analyze replaces any previous confirmation state. */
      disarm();
      result.textContent = '';
      body.textContent = TEXT.loading;
      state = { state: 'loading', preview: null };
      try {
        var diagnostics = safeObject(await diagnose({ includeDbChecks: false }));
        var chatIds = chatIdsFromDiagnostics(diagnostics);
        var projections = await collectProjections(chatIds, probe);
        /* Exactly the bounded T2.3 contract. No path, no floor, no force. */
        var request = { projections: projections };
        var preview = await invoke(PREVIEW_COMMAND, { request: request });
        if (token !== latestToken) return null;
        var overview = formatPreviewOverview(preview);
        var rows = formatDecisionRows(preview);
        var residue = formatResidueOverview(diagnostics);
        renderInto(body, overview, rows, residue, occupantRemedyRows(rows), quarantineOccupant);
        state = { state: overview.state, preview: preview };
        /* Reclaim is armed ONLY by an Analyze that completed authoritatively.
         * An incomplete analysis is not permission to delete. */
        if (overview.complete === true) {
          enablingRequest = request;
          reclaim.disabled = false;
          reclaim.title = '';
        } else {
          disarm(TEXT.reclaimNeedsAnalyze);
        }
        return preview;
      } catch (err) {
        if (token !== latestToken) return null;
        body.textContent = '';
        body.appendChild(el('div', TEXT.error, 'color:#f85149'));
        body.appendChild(el('div', String((err && err.message) || err), 'opacity:.8'));
        state = { state: 'error', preview: null };
        /* A failed Analyze disables Reclaim. */
        disarm();
        return null;
      } finally {
        if (token === latestToken) {
          inFlight = false;
          button.disabled = false;
        }
      }
    }

    function renderRunResult(outcome) {
      var view = formatRunOutcome(outcome);
      result.textContent = '';
      result.appendChild(el('h4', TEXT.reclaimHeading));
      /* The trusted state vocabulary, verbatim. `refused`, `partial`, `no-op`
       * and `complete` are DIFFERENT answers and are never collapsed into a
       * generic success. */
      result.appendChild(el('div', 'state: ' + (view.state || 'unknown')));
      result.appendChild(el('div',
        'generations quarantined ' + view.quarantined + ', purged ' + view.purged));
      result.appendChild(el('div',
        'residue quarantined ' + view.residueQuarantined + ', purged ' + view.residuePurged));
      result.appendChild(el('div', 'stale entries recovered ' + view.recovered));
      if (view.runId) result.appendChild(el('div', 'run ' + view.runId));
      view.blockers.forEach(function (blocker) {
        result.appendChild(el('div', 'blocker: ' + blocker, 'color:#f85149'));
      });
      return view;
    }

    async function execute() {
      if (executing || inFlight || !enablingRequest) return null;
      var overview = formatPreviewOverview(safeObject(state).preview);
      var confirmed = confirmAction(
        'Reclaim archive storage?\n\n'
        + overview.totals.candidates + ' generation(s) eligible, '
        + overview.totals.protected + ' protected, '
        + overview.totals.occupants + ' occupant(s) reviewed.\n\n'
        + 'The trusted side re-checks everything before acting; this analysis is context only.'
      );
      if (!confirmed) return null;

      executing = true;
      /* The confirmation is CONSUMED. A second run needs a new Analyze, and no
       * second request can be launched from this control while one is in
       * flight. */
      var request = enablingRequest;
      disarm();
      button.disabled = true;
      result.textContent = TEXT.reclaimRunning;
      try {
        var outcome = await invoke(EXECUTE_COMMAND, { request: request });
        var view = renderRunResult(outcome);
        /* A completed state-changing command makes every old Analyze row a
         * historical snapshot. Keep the command result, but remove the stale
         * plan and require a fresh read-only Analyze before showing rows. */
        invalidateAnalysis();
        return view;
      } catch (err) {
        result.textContent = '';
        result.appendChild(el('div', TEXT.error, 'color:#f85149'));
        result.appendChild(el('div', String((err && err.message) || err), 'opacity:.8'));
        return null;
      } finally {
        executing = false;
        button.disabled = false;
      }
    }

    async function quarantineOccupant(row) {
      if (executing || inFlight) return null;
      /* BOTH halves come from the trusted Analyze row: the basename it returned
       * and the chat identity its canonical parser proved. Nothing is derived
       * here, and a row without the trusted hint is not actionable at all. */
      var trusted = safeObject(row);
      var occupantName = cleanString(trusted.name);
      var chatId = chatIdOfOccupant(trusted);
      if (!occupantName || !chatId) return null;
      var confirmed = confirmAction(
        'Quarantine this occupant?\n\n' + occupantName + '\n\n'
        + 'It is moved out of the way and PRESERVED, not deleted. '
        + 'The trusted side re-checks it first and refuses if it is valid.'
      );
      if (!confirmed) return null;

      executing = true;
      button.disabled = true;
      result.textContent = TEXT.reclaimRunning;
      try {
        /* IDENTITY ONLY. No path, no run id, no destination, no classification. */
        var outcome = await invoke(OCCUPANT_COMMAND, {
          request: { chatId: chatId, occupantName: occupantName },
        });
        var view = formatOccupantOutcome(outcome);
        result.textContent = '';
        result.appendChild(el('h4', TEXT.occupantHeading));
        result.appendChild(el('div', occupantName, 'font-family:monospace;font-size:11px'));
        result.appendChild(el('div', 'state: ' + (view.state || 'unknown')));
        if (view.state === 'quarantined') {
          /* Never "deleted": one-run dwell means it is still there. */
          result.appendChild(el('div', TEXT.occupantQuarantined));
          if (view.classification) {
            result.appendChild(el('div', 'classified: ' + view.classification));
          }
        }
        view.blockers.forEach(function (blocker) {
          result.appendChild(el('div', 'blocker: ' + blocker, 'color:#f85149'));
        });
        /* Whether changed or freshly refused, the command observed a newer
         * archive state than the displayed plan. Never leave old rows visible
         * as current truth. */
        invalidateAnalysis();
        return view;
      } catch (err) {
        result.textContent = '';
        result.appendChild(el('div', TEXT.error, 'color:#f85149'));
        result.appendChild(el('div', String((err && err.message) || err), 'opacity:.8'));
        return null;
      } finally {
        executing = false;
        button.disabled = false;
      }
    }

    button.addEventListener('click', function () { analyze(); });
    reclaim.addEventListener('click', function () { execute(); });
    /* NO analyze on mount, no auto-execute, no timer, no interval, no polling. */
    return {
      analyze: analyze,
      execute: execute,
      quarantineOccupant: quarantineOccupant,
      getState: function () { return state; },
      canReclaim: function () { return reclaim.disabled === false; },
    };
  }

  H2O.Studio.reclamationUi = {
    __installed: true,
    __version: MODULE_VERSION,
    PREVIEW_COMMAND: PREVIEW_COMMAND,
    PREVIEW_SCHEMA: PREVIEW_SCHEMA,
    EXECUTE_COMMAND: EXECUTE_COMMAND,
    OCCUPANT_COMMAND: OCCUPANT_COMMAND,
    mountReclamationCard: mountReclamationCard,
    normalizePreviewWire: normalizePreviewWire,
    formatRunOutcome: formatRunOutcome,
    formatOccupantOutcome: formatOccupantOutcome,
    occupantRemedyRows: occupantRemedyRows,
    chatIdOfOccupant: chatIdOfOccupant,
    formatPreviewOverview: formatPreviewOverview,
    formatDecisionRows: formatDecisionRows,
    formatResidueOverview: formatResidueOverview,
    chatIdsFromDiagnostics: chatIdsFromDiagnostics,
  };
})(typeof window !== 'undefined' ? window : globalThis);
