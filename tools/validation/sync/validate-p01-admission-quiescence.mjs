#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import {
  CHROME_P01_MUTATION_ADMISSION,
  createChromeP01MutationAdmission
} from '../../../packages/browser-adapters/chrome/sync-p01-mutation-admission-chrome.mjs';
import { createChromeLocalPublicationWriter } from '../../../packages/browser-adapters/chrome/local-publication-writer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const P01_MUTATION_SINKS = new Set([
  'writeBundleAtomic',
  'writeExactFile',
  'stageLocalPublicationIntent',
  'commitLocalPublicationIntent',
  'markLocalPublicationRetry',
  'createWritable',
  'move',
  'removeEntry'
]);
const P01_GENERATION_GATES = new Set([
  'p01MayMutate',
  'p01MayMutateBoolean',
  'generationPermitsP01Mutation',
  'generationMayMutate',
  'p01GenerationVerdict'
]);
const MUTATION_LIKE = /(?:write|publish|export|commit|stage|mutat|promote|move|remove)/i;
const IGNORABLE_MUTATION_LIKE = new Set([
  'write', 'writeFileSync', 'writeUInt32BE', 'writeUInt32LE',
  'JSON.stringify', 'String', 'Object.assign'
]);
/* This one exact call belongs to the independently gated P02 repository
 * writer, not to a Chrome P01 artifact writer. Keep the exemption on the
 * fully-qualified owner call: an alias, another receiver, or another
 * publication-shaped call still fails closed below. */
const P02_ONLY_MUTATION_CALLS = new Set([
  'p02Publication.publishAutomaticDescendant'
]);

function parseCli(argv) {
  let sourceRoot = root;
  let generatedRoot = null;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--source-root') {
      sourceRoot = path.resolve(argv[++index]);
    } else if (argv[index] === '--generated-root') {
      generatedRoot = path.resolve(argv[++index]);
    } else if (!generatedRoot) {
      generatedRoot = path.resolve(argv[index]);
    } else {
      throw new Error(`unexpected validator argument: ${argv[index]}`);
    }
  }
  return { sourceRoot, generatedRoot };
}

const cli = parseCli(process.argv);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

class FakeWebLocks {
  constructor() {
    this.names = new Map();
  }

  state(name) {
    if (!this.names.has(name)) {
      this.names.set(name, { held: new Set(), queue: [] });
    }
    return this.names.get(name);
  }

  request(name, options, callback) {
    const mode = options?.mode === 'shared' ? 'shared' : 'exclusive';
    const state = this.state(name);
    const immediatelyGrantable = state.queue.length === 0 &&
      (state.held.size === 0 ||
        (mode === 'shared' && [...state.held].every((row) => row.mode === 'shared')));
    if (options?.ifAvailable === true && !immediatelyGrantable) {
      return Promise.resolve().then(() => callback(null));
    }
    const result = deferred();
    const request = { name, mode, callback, result };
    if (immediatelyGrantable) this.grant(state, request);
    else state.queue.push(request);
    return result.promise;
  }

  grant(state, request) {
    const holder = { mode: request.mode, name: request.name };
    state.held.add(holder);
    Promise.resolve().then(() => request.callback(Object.freeze({
      name: request.name,
      mode: request.mode
    }))).then(request.result.resolve, request.result.reject).finally(() => {
      state.held.delete(holder);
      this.process(state);
    });
  }

  process(state) {
    if (state.queue.length === 0) return;
    const first = state.queue[0];
    if (first.mode === 'exclusive') {
      if (state.held.size !== 0) return;
      state.queue.shift();
      this.grant(state, first);
      return;
    }
    if ([...state.held].some((row) => row.mode === 'exclusive')) return;
    while (state.queue[0]?.mode === 'shared') {
      this.grant(state, state.queue.shift());
    }
  }

  async query() {
    const state = this.state(CHROME_P01_MUTATION_ADMISSION.LOCK_NAME);
    return {
      held: [...state.held].map((row) => ({ name: row.name, mode: row.mode })),
      pending: state.queue.map((row) => ({ name: row.name, mode: row.mode }))
    };
  }
}

function p01Verdict(generation) {
  return async () => generation.value === 'p01'
    ? { permitted: true, generation: 'p01', reason: null }
    : { permitted: false, generation: 'p02', reason: 'p01-writer-stood-down' };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

async function raceFixture() {
  const lockManager = new FakeWebLocks();
  const pageAdmission = createChromeP01MutationAdmission({ lockManager });
  const workerAdmission = createChromeP01MutationAdmission({ lockManager });
  const generation = { value: 'p01' };
  const roles = [
    ['background-auto-reconcile', workerAdmission, false],
    ['foreground-auto-reconcile', pageAdmission, false],
    ['manual-local-publication', pageAdmission, false],
    ['chrome-export-auto-import', pageAdmission, true]
  ].map(([label, admission, throws]) => ({
    label,
    admission,
    throws,
    entered: deferred(),
    release: deferred()
  }));
  let mutations = 0;
  let doubleRelease = null;

  const operations = roles.map((role, index) => role.admission.run({
    label: role.label,
    generationCheck: p01Verdict(generation),
    operation: async (lease) => {
      role.entered.resolve();
      if (index === 0) doubleRelease = [lease.release(), lease.release()];
      await role.release.promise;
      if (role.throws) {
        throw Object.assign(new Error('fixture-writer-failed'), {
          code: 'fixture-writer-failed'
        });
      }
      mutations += 1;
    }
  }));
  await Promise.all(roles.map((role) => role.entered.promise));

  const hold = workerAdmission.beginStanddownHold();
  let drained = false;
  const drain = hold.awaitDrained().then(() => { drained = true; });
  await tick();
  assert.equal(drained, false, 'hold must wait for active writers');

  await expectCode(pageAdmission.run({
    label: 'manual-publication-after-hold',
    generationCheck: p01Verdict(generation),
    operation: async () => { mutations += 100; }
  }), CHROME_P01_MUTATION_ADMISSION.ERROR.HELD);
  assert.equal(mutations, 0, 'held writer must not mutate');

  for (let index = 0; index < roles.length - 1; index += 1) {
    roles[index].release.resolve();
    await operations[index];
    await tick();
    assert.equal(drained, false, 'drain must wait for every writer family');
  }
  roles.at(-1).release.resolve();
  await expectCode(operations.at(-1), 'fixture-writer-failed');
  await drain;
  assert.equal(mutations, 3);
  assert.deepEqual(doubleRelease, [true, false]);
  assert.equal((await pageAdmission.diagnose()).localActiveCount, 0);
  assert.equal((await workerAdmission.diagnose()).localActiveCount, 0);

  assert.equal(hold.releaseStanddownHold(), true);
  assert.equal(hold.releaseStanddownHold(), false);
  await tick();
  await tick();
  await pageAdmission.run({
    label: 'post-failed-standdown-recovery',
    generationCheck: p01Verdict(generation),
    operation: async () => { mutations += 1; }
  });
  assert.equal(mutations, 4, 'pre-commit hold release must restore admission');

  const finalHold = workerAdmission.beginStanddownHold();
  await finalHold.awaitDrained();
  generation.value = 'p02';
  finalHold.releaseStanddownHold();
  await tick();
  await tick();
  await expectCode(pageAdmission.run({
    label: 'post-p02-refusal',
    generationCheck: p01Verdict(generation),
    operation: async () => { mutations += 1000; }
  }), 'p01-writer-stood-down');
  assert.equal(mutations, 4, 'p02 generation remains permanent authority');

  return {
    mutations,
    independentContexts: 2,
    writerFamiliesDrained: roles.map((role) => role.label),
    doubleRelease
  };
}

async function realLocalWriterFixture() {
  const lockManager = new FakeWebLocks();
  const admission = createChromeP01MutationAdmission({ lockManager });
  const generation = { value: 'p01' };
  const planEntered = deferred();
  const releasePlan = deferred();
  let planCalls = 0;

  const projection = {
    canonicalJson: JSON.stringify,
    async planPublication() {
      planCalls += 1;
      planEntered.resolve();
      await releasePlan.promise;
      return {
        disposition: 'remote-applied-current',
        projection: {
          revisionId: 'rev-fixture',
          previousRevisionId: null
        }
      };
    }
  };
  const ledger = {
    async stageLocalPublicationIntent() {},
    async commitLocalPublicationIntent() {},
    async markLocalPublicationRetry() {},
    async readLocalPublicationTip() { return null; }
  };
  const writer = createChromeLocalPublicationWriter({
    projection,
    ledger,
    folderAuthority: { getConnectedDirectoryHandle() { return null; } },
    userActivation: () => true,
    writerGenerationGate: { p01MayMutate: p01Verdict(generation) },
    p01MutationAdmission: admission
  });

  const publication = writer.publishLocalRevision('object-fixture');
  await planEntered.promise;
  const hold = admission.beginStanddownHold();
  let drained = false;
  const drain = hold.awaitDrained().then(() => { drained = true; });
  await tick();
  assert.equal(drained, false);
  await expectCode(
    writer.publishLocalRevision('object-blocked'),
    CHROME_P01_MUTATION_ADMISSION.ERROR.HELD
  );
  assert.equal(planCalls, 1, 'second writer must not reach planning');
  releasePlan.resolve();
  const result = await publication;
  assert.equal(result.visibility, 'suppressed-remote-echo');
  await drain;
  hold.releaseStanddownHold();
  await tick();
  return { planCalls, visibility: result.visibility };
}

function nodeChildren(node) {
  const rows = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') rows.push(child);
      }
    } else if (value && typeof value.type === 'string') {
      rows.push(value);
    }
  }
  return rows;
}

function staticName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const object = staticName(node.object);
    const property = node.computed && node.property?.type !== 'StringLiteral'
      ? null
      : staticName(node.property);
    if (!property) return object;
    return object ? `${object}.${property}` : property;
  }
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    return staticName(node.callee);
  }
  return null;
}

function baseName(name) {
  return typeof name === 'string' ? name.split('.').at(-1) : null;
}

function unwrapObject(node) {
  if (node?.type === 'ObjectExpression') return node;
  if (node?.type === 'CallExpression' &&
      baseName(staticName(node.callee)) === 'freeze' &&
      node.arguments?.[0]?.type === 'ObjectExpression') {
    return node.arguments[0];
  }
  return null;
}

function functionName(node, parent) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator') return staticName(parent.id);
  if (parent?.type === 'AssignmentExpression') return baseName(staticName(parent.left));
  if (parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod') {
    return staticName(parent.key);
  }
  return null;
}

function walkTree(node, visitor, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node, parent);
  for (const child of nodeChildren(node)) walkTree(child, visitor, node);
}

function productionFiles(analysisRoot, generated) {
  const roots = generated
    ? [
        path.join(analysisRoot, 'surfaces/studio/sync'),
        path.join(analysisRoot, 'surfaces/studio/browser-adapters/chrome'),
        path.join(analysisRoot, 'bg.js')
      ]
    : [
        path.join(analysisRoot, 'packages/browser-adapters/chrome'),
        path.join(analysisRoot, 'src-surfaces-base/studio/sync')
      ];
  const result = [];
  const visit = (entry) => {
    if (!fs.existsSync(entry)) return;
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry).sort()) visit(path.join(entry, name));
      return;
    }
    if (!/\.(?:mjs|js)$/.test(entry) || /(?:\.tauri|\.desktop)\.(?:mjs|js)$/.test(entry)) {
      return;
    }
    result.push(entry);
  };
  for (const entry of roots) visit(entry);
  return result;
}

function familyFor(relative) {
  if (relative === 'bg.js') return 'background-auto-reconcile';
  if (relative.includes('sync-background-reconcile')) return 'background-auto-reconcile';
  if (relative.includes('sync-object-auto-reconcile')) return 'foreground-auto-reconcile';
  if (relative.includes('local-publication')) return 'manual-and-automatic-local-publication';
  if (relative.includes('auto-import')) return 'chrome-export-auto-import';
  return `discovered:${relative}`;
}

function isPublicApiMember(name) {
  return typeof name === 'string' &&
    /(?:^|\.)H2O\.Studio(?:\.|$)/.test(name);
}

function canonicalPublicApiMember(name, aliases) {
  if (!name || isPublicApiMember(name)) return name;
  const parts = name.split('.');
  const resolvedRoot = resolveAlias({ aliases }, parts[0]);
  if (!resolvedRoot || !isPublicApiMember(resolvedRoot)) return name;
  return [resolvedRoot, ...parts.slice(1)].join('.');
}

function buildSourceModel(file, analysisRoot) {
  const source = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      errorRecovery: false,
      plugins: ['classProperties', 'optionalChaining', 'topLevelAwait']
    });
  } catch (error) {
    error.message = `${path.relative(analysisRoot, file)}: ${error.message}`;
    throw error;
  }
  const relative = path.relative(analysisRoot, file);
  const functions = [];
  const byNode = new Map();
  const byName = new Map();
  const aliases = new Map();
  const apiObjects = new Map();
  const exposed = new Set();
  const exposureRoots = new Map();
  const unresolvedPublicAssignments = [];

  walkTree(ast, (node, parent) => {
    if (node.type === 'ImportSpecifier') {
      aliases.set(node.local.name, staticName(node.imported));
    } else if (node.type === 'ImportDefaultSpecifier') {
      aliases.set(node.local.name, 'default');
    } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      const target = staticName(node.init);
      if (target && target !== node.id.name) aliases.set(node.id.name, target);
      const object = unwrapObject(node.init);
      if (object) apiObjects.set(node.id.name, object);
    }
    if (![
      'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
      'ObjectMethod', 'ClassMethod'
    ].includes(node.type)) return;
    const name = functionName(node, parent) || `<anonymous@${node.loc?.start.line || 0}>`;
    const meta = {
      id: `${relative}:${name}:${node.start}`,
      file,
      relative,
      name,
      node,
      exposed: false
    };
    functions.push(meta);
    byNode.set(node, meta);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(meta);
  });

  const exposeName = (name, rootLabel) => {
    const resolved = baseName(resolveAlias({ aliases }, name));
    if (!resolved) return false;
    const matches = byName.get(resolved) || [];
    if (matches.length === 0) return false;
    exposed.add(resolved);
    if (!exposureRoots.has(resolved)) exposureRoots.set(resolved, new Set());
    exposureRoots.get(resolved).add(rootLabel);
    return true;
  };
  const exposeValue = (value, rootLabel) => {
    if (value?.type === 'Identifier' || value?.type === 'MemberExpression') {
      return exposeName(staticName(value), rootLabel);
    }
    if (byNode.has(value)) {
      const name = byNode.get(value).name;
      exposed.add(name);
      if (!exposureRoots.has(name)) exposureRoots.set(name, new Set());
      exposureRoots.get(name).add(rootLabel);
      return true;
    }
    return false;
  };
  const exposeObject = (object, rootLabel) => {
    for (const property of object?.properties || []) {
      if (property.type === 'SpreadElement') continue;
      const value = property.type === 'ObjectMethod' ? property : property.value;
      const member = staticName(property.key) || '<computed>';
      exposeValue(value, `${rootLabel}.${member}`);
    }
  };
  const returnedApis = [];
  const containingFunction = (node) => functions
    .filter((meta) => meta.node.start < node.start && meta.node.end > node.end)
    .sort((left, right) => (left.node.end - left.node.start) -
      (right.node.end - right.node.start))[0] || null;
  walkTree(ast, (node) => {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration && byNode.has(node.declaration)) {
        const name = byNode.get(node.declaration).name;
        exposeName(name, `export:${name}`);
      }
      for (const specifier of node.specifiers || []) {
        const local = staticName(specifier.local);
        if (local) exposeName(local, `export:${staticName(specifier.exported) || local}`);
      }
    } else if (node.type === 'ExportDefaultDeclaration' && byNode.has(node.declaration)) {
      exposeName(byNode.get(node.declaration).name, 'export:default');
    } else if (node.type === 'ReturnStatement') {
      const object = unwrapObject(node.argument);
      const owner = containingFunction(node);
      if (object && owner) returnedApis.push({ owner, object });
    } else if (node.type === 'AssignmentExpression') {
      const object = unwrapObject(node.right);
      const left = staticName(node.left) || '';
      const publicMember = canonicalPublicApiMember(left, aliases);
      if (object && isPublicApiMember(publicMember)) {
        exposeObject(object, publicMember);
      }
      const right = staticName(node.right);
      if (right && apiObjects.has(right) && isPublicApiMember(publicMember)) {
        exposeObject(apiObjects.get(right), publicMember);
      } else if (isPublicApiMember(publicMember) && !object &&
          !exposeValue(node.right, publicMember) &&
          ['Identifier', 'MemberExpression'].includes(node.right?.type) &&
          (MUTATION_LIKE.test(baseName(right) || '') ||
            (/chrome-latest\.json|local-publication|p01|writer-generation/i.test(source) &&
              MUTATION_LIKE.test(baseName(publicMember) || '')))) {
        unresolvedPublicAssignments.push({
          file: relative,
          publicApiMember: publicMember,
          assigned: right || node.right?.type || null,
          line: node.loc?.start.line || null,
          reason: 'public-api-callable-assignment-unresolved'
        });
      }
    }
  });
  let changed = true;
  while (changed) {
    const before = exposed.size;
    for (const row of returnedApis) {
      if (exposed.has(row.owner.name)) {
        const roots = exposureRoots.get(row.owner.name) ||
          new Set([`factory:${row.owner.name}`]);
        for (const rootLabel of roots) exposeObject(row.object, rootLabel);
      }
    }
    changed = exposed.size !== before;
  }
  for (const name of exposed) {
    for (const meta of byName.get(name) || []) {
      meta.exposed = true;
      meta.publicApiMembers = [...(exposureRoots.get(name) || [])].sort();
    }
  }
  return {
    source,
    ast,
    relative,
    functions,
    byNode,
    byName,
    aliases,
    unresolvedPublicAssignments
  };
}

function resolveAlias(model, name) {
  let current = name;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const direct = model.aliases.get(current);
    const last = baseName(current);
    const byLast = model.aliases.get(last);
    if (!direct && !byLast) break;
    current = direct || byLast;
  }
  return current;
}

function admissionRun(node, model) {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return false;
  const callee = staticName(node.callee) || '';
  if (baseName(callee) !== 'run') return false;
  const owner = callee.split('.').slice(0, -1).join('.');
  if (/p01MutationAdmission|mutationAdmission/.test(owner)) return true;
  const rootName = owner.split('.')[0];
  const resolved = resolveAlias(model, rootName);
  return /p01MutationAdmission|mutationAdmission/.test(resolved || '');
}

function objectProperty(object, name) {
  if (object?.type !== 'ObjectExpression') return null;
  for (const property of object.properties || []) {
    if (property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod') continue;
    if (staticName(property.key) === name) {
      return property.type === 'ObjectMethod' ? property : property.value;
    }
  }
  return null;
}

function analyzeP01MutationCensus(analysisRoot, { generated = false } = {}) {
  const models = productionFiles(analysisRoot, generated)
    .map((file) => buildSourceModel(file, analysisRoot));
  const violations = [];
  const safeRoutes = [];
  const unclassifiable = [];
  const routeKeys = new Set();
  const unresolvedKeys = new Set();
  for (const model of models) {
    for (const row of model.unresolvedPublicAssignments) {
      unclassifiable.push({
        ...row,
        entrypoint: `${row.file}:public:${row.publicApiMember}`,
        function: row.assigned,
        sink: null,
        route: [`${row.file}:public:${row.publicApiMember}`]
      });
    }
  }

  const resolveTargets = (model, called) => {
    const raw = resolveAlias(model, called);
    const name = baseName(raw);
    const local = model.byName.get(name) || [];
    if (local.length > 0) return local.map((meta) => ({ model, meta }));
    return [];
  };

  function inspect(meta, model, state) {
    const stateKey = `${meta.id}|${state.admitted}|${state.generationSeen}`;
    if (state.visited.has(stateKey)) return;
    const visited = new Set(state.visited);
    visited.add(stateKey);
    let generationSeen = state.generationSeen;
    const pathRows = [...state.path, `${meta.relative}:${meta.name}`];

    const inspectNode = (node, admitted, isRoot = false) => {
      if (!node || typeof node.type !== 'string') return;
      if (!isRoot && model.byNode.has(node)) return;
      if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
        if (admissionRun(node, model)) {
          const options = node.arguments?.[0];
          const generationCheck = objectProperty(options, 'generationCheck');
          const operation = objectProperty(options, 'operation');
          if (!operation) {
            const key = `${meta.id}:admission-operation-missing:${node.start}`;
            if (!unresolvedKeys.has(key)) {
              unresolvedKeys.add(key);
              unclassifiable.push({
                file: meta.relative,
                entrypoint: state.entrypoint,
                publicApiMember: state.publicApiMember,
                function: meta.name,
                sink: null,
                line: node.loc?.start.line || null,
                reason: 'admission-run-operation-unclassifiable',
                route: pathRows
              });
            }
          }
          if (generationCheck) inspectCallback(generationCheck, true);
          if (operation) inspectCallback(operation, true);
          return;
        }
        const rawCall = staticName(node.callee);
        const resolvedCall = resolveAlias(model, rawCall);
        const called = baseName(resolvedCall || rawCall);
        if (P01_GENERATION_GATES.has(called) ||
            (/p01/i.test(called || '') && /(?:generation|mutate|writerActive)/i.test(called || ''))) {
          generationSeen = true;
        }
        if (P01_MUTATION_SINKS.has(called)) {
          const row = {
            file: meta.relative,
            entrypoint: state.entrypoint,
            publicApiMember: state.publicApiMember,
            function: meta.name,
            sink: called,
            line: node.loc?.start.line || null,
            generationSeen,
            route: pathRows
          };
          const key = JSON.stringify([row.file, row.entrypoint, row.function, row.sink, row.line, admitted]);
          if (!routeKeys.has(key)) {
            routeKeys.add(key);
            (admitted ? safeRoutes : violations).push({
              ...row,
              reason: admitted ? 'common-admission-dominates-mutation' :
                'p01-mutation-sink-reachable-without-common-admission'
            });
          }
        }
        const targets = resolveTargets(model, rawCall);
        for (const target of targets) {
          inspect(target.meta, target.model, {
            admitted,
            generationSeen,
            entrypoint: state.entrypoint,
            publicApiMember: state.publicApiMember,
            path: pathRows,
            visited
          });
        }
        if (targets.length === 0 && !admitted && generationSeen &&
            !P02_ONLY_MUTATION_CALLS.has(rawCall) && MUTATION_LIKE.test(called || '') &&
            !P01_MUTATION_SINKS.has(called) && !IGNORABLE_MUTATION_LIKE.has(called)) {
          const artifactContext = /chrome-latest\.json|local-publication|p01|writer-generation/i
            .test(model.source);
          if (artifactContext && !/^(?:queryPermission|requestPermission|requirePermission|setTimeout|clearTimeout)$/.test(called || '')) {
            const key = `${meta.id}:${called}:${node.start}`;
            if (!unresolvedKeys.has(key)) {
              unresolvedKeys.add(key);
              unclassifiable.push({
                file: meta.relative,
                entrypoint: state.entrypoint,
                publicApiMember: state.publicApiMember,
                function: meta.name,
                sink: called,
                line: node.loc?.start.line || null,
                reason: 'mutation-capable-call-admission-dominance-unproven',
                route: pathRows
              });
            }
          }
        }
      }
      for (const child of nodeChildren(node)) inspectNode(child, admitted, false);
    };

    const inspectCallback = (callback, admitted) => {
      if (callback?.type === 'Identifier' || callback?.type === 'MemberExpression') {
        for (const target of resolveTargets(model, staticName(callback))) {
          inspect(target.meta, target.model, {
            admitted,
            generationSeen,
            entrypoint: state.entrypoint,
            publicApiMember: state.publicApiMember,
            path: pathRows,
            visited
          });
        }
      } else if (callback && ['FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod'].includes(callback.type)) {
        inspectNode(callback.body, admitted, true);
      }
    };

    inspectNode(meta.node.body || meta.node, state.admitted, true);
  }

  const entrypoints = [];
  for (const model of models) {
    for (const meta of model.functions.filter((row) => row.exposed)) {
      const publicRoots = meta.publicApiMembers?.length > 0
        ? meta.publicApiMembers
        : [null];
      for (const publicApiMember of publicRoots) {
        const entrypoint = publicApiMember
          ? `${meta.relative}:public:${publicApiMember}=>${meta.name}`
          : `${meta.relative}:${meta.name}`;
        entrypoints.push(entrypoint);
        inspect(meta, model, {
          admitted: false,
          generationSeen: false,
          entrypoint,
          publicApiMember,
          path: [],
          visited: new Set()
        });
      }
    }
  }
  const admissionFamilies = [];
  for (const model of models) {
    let found = false;
    walkTree(model.ast, (node) => {
      if (admissionRun(node, model)) found = true;
    });
    if (found) admissionFamilies.push(familyFor(model.relative));
  }
  const families = [...new Set([
    ...safeRoutes.map((row) => familyFor(row.file)),
    ...violations.map((row) => familyFor(row.file)),
    ...admissionFamilies
  ])].sort();
  const coveredPublicMutationMembers = [...new Set(safeRoutes
    .map((row) => row.publicApiMember)
    .filter((name) => isPublicApiMember(name)))].sort();
  return {
    scope: generated ? 'generated' : 'authored',
    filesScanned: models.length,
    entrypointsScanned: entrypoints.length,
    publicApiEntrypoints: entrypoints.filter((row) => row.includes(':public:H2O.')).length,
    coveredPublicMutationMembers,
    families,
    safeRoutes,
    violations,
    unclassifiable
  };
}

function syntheticModel(source, name) {
  const fixtureRoot = fs.mkdtempSync(path.join('/tmp', 'h2o-p01-admission-census-'));
  const syncRoot = path.join(fixtureRoot, 'src-surfaces-base/studio/sync');
  fs.mkdirSync(syncRoot, { recursive: true });
  fs.writeFileSync(path.join(syncRoot, `${name}.js`), source);
  try {
    return analyzeP01MutationCensus(fixtureRoot);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function negativeControls() {
  const prefix = `
    async function p01MayMutate() { return { permitted: true }; }
    async function writeBundleAtomic() { return { ok: true }; }
  `;
  const direct = syntheticModel(`${prefix}
    async function verificationBypassWriter() {
      const verdict = await p01MayMutate();
      if (verdict.permitted) return writeBundleAtomic('chrome-latest.json');
    }
    var api = { verificationBypassWriter };
    H2O.Studio.sync.fixture = api;
  `, 'direct-bypass');
  const helper = syntheticModel(`${prefix}
    async function unsafeHelper() { return writeBundleAtomic('chrome-latest.json'); }
    async function verificationHelperBypass() {
      const verdict = await p01MayMutate();
      if (verdict.permitted) return unsafeHelper();
    }
    var api = { verificationHelperBypass };
    H2O.Studio.sync.fixture = api;
  `, 'helper-bypass');
  const alias = syntheticModel(`${prefix}
    const atomicAlias = writeBundleAtomic;
    async function aliasHelper() { return atomicAlias('chrome-latest.json'); }
    const helperAlias = aliasHelper;
    async function verificationAliasBypass() {
      const verdict = await p01MayMutate();
      if (verdict.permitted) return helperAlias();
    }
    var api = { verificationAliasBypass };
    H2O.Studio.sync.fixture = api;
  `, 'alias-bypass');
  const publicReassignment = syntheticModel(`${prefix}
    async function exportNow() {
      const verdict = await p01MayMutate();
      if (verdict.permitted) return writeBundleAtomic('chrome-latest.json');
    }
    H2O.Studio.sync.autoImport.exportNow = exportNow;
  `, 'public-reassignment-bypass');
  const inlinePublic = syntheticModel(`${prefix}
    H2O.Studio.sync.autoImport.exportNow = async function () {
      const verdict = await p01MayMutate();
      if (verdict.permitted) return writeBundleAtomic('chrome-latest.json');
    };
  `, 'inline-public-bypass');
  const arrowPublic = syntheticModel(`${prefix}
    H2O.Studio.sync.autoImport.exportNow = async () => {
      const verdict = await p01MayMutate();
      if (verdict.permitted) return writeBundleAtomic('chrome-latest.json');
    };
  `, 'arrow-public-bypass');
  const publicAlias = syntheticModel(`${prefix}
    async function unsafeExport() {
      const verdict = await p01MayMutate();
      if (verdict.permitted) return writeBundleAtomic('chrome-latest.json');
    }
    const assignedExport = unsafeExport;
    const SyncNamespace = H2O['Studio']['sync'];
    SyncNamespace['autoImport']['exportNow'] = assignedExport;
  `, 'public-alias-bypass');
  const safeThenUnsafe = syntheticModel(`${prefix}
    const p01MutationAdmission = {
      run({ operation }) { return operation(); }
    };
    async function rawExportNow() {
      const verdict = await p01MayMutate();
      if (verdict.permitted) return writeBundleAtomic('chrome-latest.json');
    }
    async function admittedExportNow() {
      return p01MutationAdmission.run({
        generationCheck: p01MayMutate,
        operation: rawExportNow
      });
    }
    H2O.Studio.sync.autoImport.exportNow = admittedExportNow;
    H2O.Studio.sync.autoImport.exportNow = rawExportNow;
  `, 'safe-then-unsafe-reassignment');
  const unclassifiable = syntheticModel(`
    async function p01MayMutate() { return { permitted: true }; }
    async function verificationUnknownWriter() {
      const verdict = await p01MayMutate();
      if (verdict.permitted) return commitP01Artifact('chrome-latest.json');
    }
    var api = { verificationUnknownWriter };
    H2O.Studio.sync.fixture = api;
  `, 'unclassifiable-writer');
  const unclassifiablePublic = syntheticModel(`
    H2O.Studio.sync.autoImport.p01ArtifactWriter = unresolvedP01ArtifactWriter;
  `, 'unclassifiable-public-assignment');
  const currentAutoImport = fs.readFileSync(path.join(
    cli.sourceRoot,
    'src-surfaces-base/studio/sync/auto-import.mv3.js'
  ), 'utf8');
  const existingFamilySource = currentAutoImport.replace(
    'exportNow: exportNowWithP01Admission',
    'exportNow: exportNow'
  );
  assert.notEqual(existingFamilySource, currentAutoImport,
    'existing auto-import admission bypass fixture must alter its API route');
  const existingFamily = syntheticModel(existingFamilySource, 'existing-family-bypass');
  for (const [label, census] of Object.entries({
    direct,
    helper,
    alias,
    publicReassignment,
    inlinePublic,
    arrowPublic,
    publicAlias,
    safeThenUnsafe,
    existingFamily
  })) {
    assert.ok(census.violations.length > 0,
      `${label} bypass must make the permanent census RED`);
  }
  assert.ok(unclassifiable.unclassifiable.length > 0,
    'unknown mutation-capable route must fail closed as unclassifiable');
  assert.ok(unclassifiablePublic.unclassifiable.length > 0,
    'unknown public callable assignment must fail closed as unclassifiable');
  return {
    direct: direct.violations[0],
    helper: helper.violations[0],
    alias: alias.violations[0],
    publicReassignment: publicReassignment.violations[0],
    inlinePublic: inlinePublic.violations[0],
    arrowPublic: arrowPublic.violations[0],
    publicAlias: publicAlias.violations[0],
    safeThenUnsafe: safeThenUnsafe.violations[0],
    existingFamily: existingFamily.violations[0],
    unclassifiable: unclassifiable.unclassifiable[0],
    unclassifiablePublic: unclassifiablePublic.unclassifiable[0]
  };
}

function requireSafeCensus(census, scope) {
  if (census.violations.length > 0) {
    const error = new Error(`${scope} Chrome P01 mutation bypass detected`);
    error.code = 'p01-admission-bypass-detected';
    error.diagnostic = census.violations;
    throw error;
  }
  if (census.unclassifiable.length > 0) {
    const error = new Error(`${scope} Chrome P01 mutation route is unclassifiable`);
    error.code = 'p01-admission-route-unclassifiable';
    error.diagnostic = census.unclassifiable;
    throw error;
  }
}

function sourceAssertions() {
  const read = (relative) => fs.readFileSync(path.join(cli.sourceRoot, relative), 'utf8');
  const admission = read(
    'packages/browser-adapters/chrome/sync-p01-mutation-admission-chrome.mjs'
  );
  const background = read(
    'packages/browser-adapters/chrome/sync-background-reconcile.mjs'
  );
  const foreground = read(
    'src-surfaces-base/studio/sync/sync-object-auto-reconcile.js'
  );
  const publicationWriter = read(
    'packages/browser-adapters/chrome/local-publication-writer.mjs'
  );
  const publicationSurface = read(
    'src-surfaces-base/studio/sync/local-publication.mv3.js'
  );
  const autoImport = read('src-surfaces-base/studio/sync/auto-import.mv3.js');
  const studio = read('src-surfaces-base/studio/studio.html');
  const packer = read('tools/product/studio/pack-studio.mjs');

  assert.match(admission, /mode: 'shared', ifAvailable: true/);
  assert.match(admission, /mode: 'exclusive'/);
  assert.doesNotMatch(admission, /storage\.local|indexedDB|repository|WebDAV/i);
  assert.match(background, /mutationAdmission\.run\(/);
  assert.match(background, /admissionLease\s*\)/);
  assert.match(foreground, /p01MutationAdmissionSurface\(\)\.run\(/);
  assert.match(foreground, /admissionLease/);
  assert.match(publicationWriter, /p01MutationAdmission\.run\(/);
  assert.match(publicationSurface, /p01MutationAdmission: p01MutationAdmissionSurface\(\)/);
  assert.match(autoImport, /admission\.run\(\{/);
  assert.match(autoImport, /exportNowWithP01Admission/);
  assert.match(studio, /p01-mutation-admission\.mv3\.js/);
  assert.match(packer, /sync-p01-mutation-admission-chrome\.mjs/);
  assert.equal(
    (studio.match(/p01-mutation-admission\.mv3\.js/g) || []).length,
    1
  );

  if (cli.generatedRoot) {
    const generatedFiles = [
      'surfaces/studio/sync/p01-mutation-admission.mv3.js',
      'surfaces/studio/sync/auto-import.mv3.js',
      'surfaces/studio/sync/local-publication.mv3.js',
      'surfaces/studio/sync/sync-object-auto-reconcile.js',
      'surfaces/studio/browser-adapters/chrome/sync-p01-mutation-admission-chrome.mjs'
    ];
    for (const relative of generatedFiles) {
      assert.equal(fs.existsSync(path.join(cli.generatedRoot, relative)), true,
        `generated P01 admission input missing: ${relative}`);
    }
    assert.match(
      fs.readFileSync(path.join(cli.generatedRoot, 'surfaces/studio/studio.html'), 'utf8'),
      /p01-mutation-admission\.mv3\.js/
    );
  }

  const authoredCensus = analyzeP01MutationCensus(cli.sourceRoot);
  const generatedCensus = cli.generatedRoot
    ? analyzeP01MutationCensus(cli.generatedRoot, { generated: true })
    : null;
  const requiredCurrentFamilies = [
    'background-auto-reconcile',
    'chrome-export-auto-import',
    'foreground-auto-reconcile',
    'manual-and-automatic-local-publication'
  ];
  requireSafeCensus(authoredCensus, 'authored');
  for (const family of requiredCurrentFamilies) {
    assert.ok(authoredCensus.families.includes(family),
      `authored P01 writer-family census missing: ${family}`);
  }
  if (generatedCensus) {
    requireSafeCensus(generatedCensus, 'generated');
    assert.deepEqual(generatedCensus.families, authoredCensus.families,
      'generated P01 writer-family census must match authored discovery');
    assert.deepEqual(
      generatedCensus.coveredPublicMutationMembers,
      authoredCensus.coveredPublicMutationMembers,
      'generated public P01 mutation API members must match authored discovery'
    );
  }

  return {
    writerFamilies: authoredCensus.families,
    authoredCensus: {
      filesScanned: authoredCensus.filesScanned,
      entrypointsScanned: authoredCensus.entrypointsScanned,
      publicApiEntrypoints: authoredCensus.publicApiEntrypoints,
      coveredPublicMutationMembers: authoredCensus.coveredPublicMutationMembers,
      families: authoredCensus.families,
      coveredMutationRoutes: authoredCensus.safeRoutes.length,
      uncoveredWriters: authoredCensus.violations.length,
      unclassifiableMutationRoutes: authoredCensus.unclassifiable.length
    },
    generatedCensus: generatedCensus ? {
      filesScanned: generatedCensus.filesScanned,
      entrypointsScanned: generatedCensus.entrypointsScanned,
      publicApiEntrypoints: generatedCensus.publicApiEntrypoints,
      coveredPublicMutationMembers: generatedCensus.coveredPublicMutationMembers,
      families: generatedCensus.families,
      coveredMutationRoutes: generatedCensus.safeRoutes.length,
      uncoveredWriters: generatedCensus.violations.length,
      unclassifiableMutationRoutes: generatedCensus.unclassifiable.length
    } : null,
    generatedChecked: Boolean(cli.generatedRoot)
  };
}

try {
  const race = await raceFixture();
  const localWriter = await realLocalWriterFixture();
  const bypassControls = negativeControls();
  const source = sourceAssertions();

  console.log(JSON.stringify({
    ok: true,
    validator: 'p01-admission-quiescence',
    lockName: CHROME_P01_MUTATION_ADMISSION.LOCK_NAME,
    race,
    localWriter,
    bypassControls,
    source
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    validator: 'p01-admission-quiescence',
    code: error?.code || 'p01-admission-assurance-failed',
    message: String(error?.message || error),
    diagnostic: error?.diagnostic || null
  }, null, 2));
  process.exitCode = 1;
}
