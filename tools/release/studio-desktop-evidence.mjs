// M03 DP02 Slice A: pure Studio release-evidence primitives. No governed store I/O.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMAS = Object.freeze({
  build: 'h2o.studio.release-evidence.build.v1',
  artifact: 'h2o.studio.release-evidence.artifact.v1',
  decision: 'h2o.studio.release-evidence.decision-reference.v1',
  rc: 'h2o.studio.release-evidence.rc.v1',
  tag: 'h2o.studio.release-evidence.tag-event.v1',
  github: 'h2o.studio.release-evidence.github-event.v1',
  publication: 'h2o.studio.release-evidence.publication-event.v1',
  delivery: 'h2o.studio.release-evidence.delivery-event.v1',
  index: 'h2o.studio.release-evidence.index-entry.v1',
  copy: 'h2o.studio.release-evidence.copy-attestation.v1',
});

const HEX = '[0-9a-f]{64}';
const SHA = new RegExp(`^sha256:${HEX}$`);
const OBJECT_ID = new RegExp(`^obj:sha256:${HEX}$`);
const COMMIT = /^[0-9a-f]{40}$/;
const SEMVER = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const VERSION = new RegExp(`^${SEMVER}$`);
const RELEASE_ID = new RegExp(`^studio-desktop/v(${SEMVER})$`);
const RC_ID = new RegExp(`^studio-desktop/v(${SEMVER})/rc\\.([1-9][0-9]*)$`);
const TAG = new RegExp(`^component/studio-desktop/v(${SEMVER})$`);
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const KINDS = new Map(Object.entries(SCHEMAS).map(([kind, schema]) => [schema, kind]));

function need(condition, message) {
  if (!condition) throw new Error(message);
}

function string(value, label) {
  need(typeof value === 'string' && value.length > 0, `${label}: nonempty string required`);
  return value;
}

function matches(value, pattern, label) {
  need(typeof value === 'string' && pattern.test(value), `${label}: invalid`);
  return value;
}

function object(value, label) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: object required`);
  return value;
}

function keys(value, required, optional = []) {
  for (const key of required) need(Object.hasOwn(value, key), `${key}: missing`);
  for (const key of Object.keys(value)) {
    need(required.includes(key) || optional.includes(key), `${key}: unsupported field`);
  }
}

function utc(value, label) {
  matches(value, UTC, label);
  need(!Number.isNaN(Date.parse(value)), `${label}: invalid UTC time`);
}

function version(value) {
  matches(value, VERSION, 'componentVersion');
  const prerelease = value.split('+')[0].split('-').slice(1).join('-');
  if (prerelease) for (const part of prerelease.split('.')) {
    need(!/^\d+$/.test(part) || part === '0' || !part.startsWith('0'), 'SemVer numeric prerelease has leading zero');
  }
}

function releaseId(value) {
  const match = matches(value, RELEASE_ID, 'releaseId').match(RELEASE_ID);
  version(match[1]);
  return match[1];
}

function rcId(value) {
  const match = matches(value, RC_ID, 'rcId').match(RC_ID);
  version(match[1]);
  return match[1];
}

function checkUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      need(i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff, 'lone high surrogate');
      i += 1;
    } else need(c < 0xdc00 || c > 0xdfff, 'lone low surrogate');
  }
}

// RFC 8785 uses ECMAScript primitive serialization and UTF-16 key ordering.
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') { checkUnicode(value); return JSON.stringify(value); }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    need(Number.isFinite(value), 'non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    need(Object.keys(value).length === value.length &&
      Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean),
    'sparse or extended array');
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  object(value, 'canonical JSON');
  need(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'non-JSON object');
  return `{${Object.keys(value).sort().map((key) => {
    checkUnicode(key);
    return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
  }).join(',')}}`;
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function verifyCanonicalBytes(input) {
  need(Buffer.isBuffer(input) || input instanceof Uint8Array, 'canonical input must be bytes');
  const bytes = Buffer.from(input);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text);
  need(bytes.equals(canonicalBytes(parsed)), 'noncanonical JSON bytes (including duplicate keys)');
  return parsed;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// sha256-file-v1. The caller supplies the path; symlinks are not followed.
export function sha256File(file) {
  need(fs.lstatSync(file).isFile(), 'sha256-file-v1 requires a regular file');
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function codePointCompare(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// Exact adopted M02 bundle-tree-sha256-v1: root '.', POSIX paths, lstat,
// [path,type,mode,value] JSON lines ordered by Unicode code points.
export function bundleTreeSha256(directory) {
  need(fs.lstatSync(directory).isDirectory(), '.app path is not a directory');
  const entries = [];
  function visit(absolute, relative) {
    const stat = fs.lstatSync(absolute);
    let type;
    let value;
    if (stat.isDirectory()) { type = 'd'; value = ''; }
    else if (stat.isFile()) { type = 'f'; value = sha256File(absolute); }
    else if (stat.isSymbolicLink()) { type = 'l'; value = fs.readlinkSync(absolute); }
    else throw new Error(`unsupported bundle entry: ${relative}`);
    entries.push([relative, type, stat.mode & 0o777, value]);
    if (type === 'd') for (const name of fs.readdirSync(absolute)) {
      visit(path.join(absolute, name), relative === '.' ? name : `${relative}/${name}`);
    }
  }
  visit(directory, '.');
  entries.sort((left, right) => codePointCompare(left[0], right[0]));
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${JSON.stringify(entry)}\n`, 'utf8');
  return hash.digest('hex');
}

function byteSize(location, kind) {
  if (kind !== 'app') return fs.lstatSync(location).size;
  let total = 0;
  function visit(item) {
    const stat = fs.lstatSync(item);
    if (stat.isFile()) total += stat.size;
    else if (stat.isDirectory()) for (const name of fs.readdirSync(item)) visit(path.join(item, name));
    else need(stat.isSymbolicLink(), 'unsupported bundle entry');
  }
  visit(location);
  return total;
}

export function verifyArtifactBytes(artifact, location) {
  validateEvidence(artifact, { mode: 'synthetic-or-real' });
  need(artifact.schema === SCHEMAS.artifact, 'artifact schema required');
  const actual = artifact.kind === 'app' ? bundleTreeSha256(location) : sha256File(location);
  need(artifact.digest === `sha256:${actual}`, `${artifact.kind} digest mismatch`);
  need(artifact.byteSize === byteSize(location, artifact.kind), `${artifact.kind} byte size mismatch`);
  return true;
}

function base(payload, schema, required, optional = []) {
  object(payload, schema);
  keys(payload, ['schema', 'synthetic', 'authorityEffect', ...required], optional);
  need(payload.schema === schema, 'malformed schema');
  need(typeof payload.synthetic === 'boolean', 'explicit synthetic boolean required');
  need(payload.authorityEffect === 'NONE', 'evidence has no authority effect');
}

export function validateEvidence(payload, { mode = 'real' } = {}) {
  object(payload, 'evidence');
  const kind = KINDS.get(payload.schema);
  need(kind && kind !== 'index', 'malformed schema');
  need(['real', 'synthetic', 'synthetic-or-real'].includes(mode), 'invalid validation mode');
  if (mode === 'real') need(payload.synthetic === false, 'synthetic object presented as real');
  if (mode === 'synthetic') need(payload.synthetic === true, 'fixture lacks synthetic marker');
  switch (kind) {
    case 'build':
      base(payload, SCHEMAS.build, ['componentId', 'componentVersion', 'sourceCommit', 'checkpoint', 'builtAtUtc', 'targetOs', 'architecture', 'profile', 'governed', 'sourceDirty', 'executableSha256', 'packagedReadback']);
      need(payload.componentId === 'studio-desktop', 'component mismatch');
      version(payload.componentVersion);
      matches(payload.sourceCommit, COMMIT, 'sourceCommit');
      string(payload.checkpoint, 'checkpoint'); utc(payload.builtAtUtc, 'builtAtUtc');
      string(payload.targetOs, 'targetOs'); string(payload.architecture, 'architecture');
      need(payload.profile === 'release' && payload.governed === true && payload.sourceDirty === false, 'build not RC eligible');
      matches(payload.executableSha256, SHA, 'executableSha256');
      object(payload.packagedReadback, 'packagedReadback');
      keys(payload.packagedReadback, ['schema', 'componentId', 'componentVersion', 'sourceCommit', 'checkpoint', 'builtAtUtc', 'targetOs', 'architecture', 'profile', 'governed', 'sourceDirty', 'executableSha256']);
      need(payload.packagedReadback.schema === 'h2o.studio.release-evidence.packaged-build-identity.v1', 'packaged readback schema mismatch');
      for (const field of ['componentId', 'componentVersion', 'sourceCommit', 'checkpoint', 'builtAtUtc', 'targetOs', 'architecture', 'profile', 'governed', 'sourceDirty', 'executableSha256']) {
        need(payload[field] === payload.packagedReadback[field], `packaged readback ${field} mismatch`);
      }
      break;
    case 'artifact': {
      base(payload, SCHEMAS.artifact, ['artifactId', 'kind', 'digestMethod', 'digest', 'byteSize', 'buildObjectId', 'sourceCommit', 'componentVersion', 'targetOs', 'architecture']);
      need(['executable', 'app', 'dmg'].includes(payload.kind), 'invalid artifact kind');
      version(payload.componentVersion);
      matches(payload.digest, SHA, 'digest');
      need(payload.digestMethod === (payload.kind === 'app' ? 'bundle-tree-sha256-v1' : 'sha256-file-v1'), 'digest method mismatch');
      need(payload.artifactId === `studio-desktop@${payload.componentVersion}/artifact/${payload.kind}/${payload.digest}`, 'artifact ID mismatch');
      need(Number.isSafeInteger(payload.byteSize) && payload.byteSize >= 0, 'byteSize invalid');
      matches(payload.buildObjectId, OBJECT_ID, 'buildObjectId'); matches(payload.sourceCommit, COMMIT, 'sourceCommit');
      string(payload.targetOs, 'targetOs'); string(payload.architecture, 'architecture');
      break;
    }
    case 'decision':
      base(payload, SCHEMAS.decision, ['decisionType', 'decisionAuthority', 'releaseId', 'managementCommit', 'recordPath', 'decisionDigest', 'approvedAssetObjectIds'], ['rcId']);
      need(['rc', 'release', 'publication', 'tag'].includes(payload.decisionType), 'decisionType invalid');
      need(payload.decisionAuthority === 'HDA/Product', 'decision authority mismatch');
      releaseId(payload.releaseId);
      matches(payload.managementCommit, COMMIT, 'managementCommit');
      matches(payload.recordPath, /^(?:missions|plans)\/[A-Za-z0-9._/-]+\.(?:md|yaml)$/, 'Management recordPath');
      need(!payload.recordPath.split('/').includes('..') && !payload.recordPath.includes('//'), 'unsafe Management recordPath');
      matches(payload.decisionDigest, SHA, 'decisionDigest');
      need(Array.isArray(payload.approvedAssetObjectIds), 'approvedAssetObjectIds required');
      payload.approvedAssetObjectIds.forEach((id) => matches(id, OBJECT_ID, 'approved asset'));
      need(new Set(payload.approvedAssetObjectIds).size === payload.approvedAssetObjectIds.length, 'duplicate approved asset');
      if (payload.decisionType === 'rc' || payload.decisionType === 'release') {
        need(rcId(payload.rcId) === releaseId(payload.releaseId), 'approved RC/decision mismatch');
      } else need(!Object.hasOwn(payload, 'rcId'), 'unexpected RC decision binding');
      break;
    case 'rc': {
      base(payload, SCHEMAS.rc, ['rcId', 'releaseId', 'sourceCommit', 'buildObjectId', 'artifactObjectIds', 'decisionObjectId']);
      need(rcId(payload.rcId) === releaseId(payload.releaseId), 'RC identity mismatch');
      matches(payload.sourceCommit, COMMIT, 'sourceCommit'); matches(payload.buildObjectId, OBJECT_ID, 'buildObjectId');
      object(payload.artifactObjectIds, 'artifactObjectIds'); keys(payload.artifactObjectIds, ['executable', 'app', 'dmg']);
      Object.values(payload.artifactObjectIds).forEach((id) => matches(id, OBJECT_ID, 'artifactObjectId'));
      need(new Set(Object.values(payload.artifactObjectIds)).size === 3, 'artifact substitution');
      matches(payload.decisionObjectId, OBJECT_ID, 'decisionObjectId');
      break;
    }
    case 'tag':
      base(payload, SCHEMAS.tag, ['releaseId', 'tag', 'targetCommit', 'refObjectId', 'tagObjectId', 'observedAtUtc', 'operator', 'decisionObjectId', 'releaseDecisionObjectId']);
      need(matches(payload.tag, TAG, 'release tag').match(TAG)[1] === releaseId(payload.releaseId), 'tag/release mismatch');
      matches(payload.targetCommit, COMMIT, 'targetCommit'); matches(payload.refObjectId, COMMIT, 'refObjectId');
      need(payload.tagObjectId === null || COMMIT.test(payload.tagObjectId), 'tagObjectId invalid');
      utc(payload.observedAtUtc, 'observedAtUtc'); string(payload.operator, 'operator');
      matches(payload.decisionObjectId, OBJECT_ID, 'decisionObjectId');
      matches(payload.releaseDecisionObjectId, OBJECT_ID, 'releaseDecisionObjectId');
      break;
    case 'github':
      base(payload, SCHEMAS.github, ['releaseId', 'githubReleaseId', 'githubNodeId', 'state', 'tag', 'targetCommit', 'createdAtUtc', 'publishedAtUtc', 'updatedAtUtc', 'observedAtUtc', 'operator', 'assets', 'decisionObjectId', 'releaseDecisionObjectId']);
      need(Number.isSafeInteger(payload.githubReleaseId) && payload.githubReleaseId > 0, 'githubReleaseId invalid');
      string(payload.githubNodeId, 'githubNodeId');
      need(['draft', 'published', 'withdrawn'].includes(payload.state), 'hosted state invalid');
      need(matches(payload.tag, TAG, 'tag').match(TAG)[1] === releaseId(payload.releaseId), 'tag/release mismatch');
      matches(payload.targetCommit, COMMIT, 'targetCommit');
      utc(payload.createdAtUtc, 'createdAtUtc'); utc(payload.updatedAtUtc, 'updatedAtUtc');
      if (payload.state === 'draft') need(payload.publishedAtUtc === null, 'draft has publication time');
      else utc(payload.publishedAtUtc, 'publishedAtUtc');
      utc(payload.observedAtUtc, 'observedAtUtc'); string(payload.operator, 'operator');
      need(Array.isArray(payload.assets), 'assets required');
      for (const asset of payload.assets) {
        object(asset, 'asset'); keys(asset, ['assetId', 'name', 'byteSize', 'githubDigest', 'approvedDigest', 'artifactObjectId']);
        need(Number.isSafeInteger(asset.assetId) && asset.assetId > 0, 'assetId invalid');
        string(asset.name, 'asset name');
        need(Number.isSafeInteger(asset.byteSize) && asset.byteSize >= 0, 'asset byteSize invalid');
        need(asset.githubDigest === null || SHA.test(asset.githubDigest), 'githubDigest invalid');
        matches(asset.approvedDigest, SHA, 'approvedDigest');
        matches(asset.artifactObjectId, OBJECT_ID, 'asset artifactObjectId');
      }
      need(new Set(payload.assets.map((asset) => asset.assetId)).size === payload.assets.length, 'duplicate hosted asset ID');
      matches(payload.decisionObjectId, OBJECT_ID, 'decisionObjectId');
      matches(payload.releaseDecisionObjectId, OBJECT_ID, 'releaseDecisionObjectId');
      break;
    case 'publication':
      base(payload, SCHEMAS.publication, ['releaseId', 'githubEventObjectId', 'decisionObjectId', 'operator', 'occurredAtUtc']);
      releaseId(payload.releaseId); matches(payload.githubEventObjectId, OBJECT_ID, 'githubEventObjectId');
      matches(payload.decisionObjectId, OBJECT_ID, 'decisionObjectId'); string(payload.operator, 'operator'); utc(payload.occurredAtUtc, 'occurredAtUtc');
      break;
    case 'delivery':
      base(payload, SCHEMAS.delivery, ['eventType', 'releaseId', 'artifactObjectId', 'destination', 'operator', 'occurredAtUtc', 'deploymentId'], ['predecessorObjectId']);
      need(['deployment', 'activation'].includes(payload.eventType), 'delivery event type invalid');
      releaseId(payload.releaseId); matches(payload.artifactObjectId, OBJECT_ID, 'artifactObjectId');
      string(payload.destination, 'destination'); string(payload.operator, 'operator'); utc(payload.occurredAtUtc, 'occurredAtUtc');
      string(payload.deploymentId, 'deploymentId');
      if (payload.eventType === 'activation') matches(payload.predecessorObjectId, OBJECT_ID, 'predecessor deployment');
      else need(!Object.hasOwn(payload, 'predecessorObjectId'), 'deployment has activation predecessor');
      break;
    case 'copy':
      base(payload, SCHEMAS.copy, ['releaseId', 'copyId', 'sourceLocator', 'targetLocator', 'sourceHostId', 'targetHostId', 'copyDigest', 'operator', 'observedAtUtc', 'objectIds']);
      releaseId(payload.releaseId); string(payload.copyId, 'copyId');
      string(payload.sourceLocator, 'sourceLocator'); string(payload.targetLocator, 'targetLocator');
      need(payload.sourceLocator !== payload.targetLocator, 'copy not independent');
      string(payload.sourceHostId, 'sourceHostId'); string(payload.targetHostId, 'targetHostId');
      need(payload.sourceHostId !== payload.targetHostId, 'copy hosts not independent');
      matches(payload.copyDigest, SHA, 'copyDigest'); string(payload.operator, 'operator'); utc(payload.observedAtUtc, 'observedAtUtc');
      need(Array.isArray(payload.objectIds) && payload.objectIds.length > 0, 'copy objectIds required');
      payload.objectIds.forEach((id) => matches(id, OBJECT_ID, 'copy objectId'));
      break;
    default: throw new Error('malformed schema');
  }
  return payload;
}

export function sealEvidence(payload, options) {
  validateEvidence(payload, options);
  const bytes = canonicalBytes(payload);
  const digest = sha256Bytes(bytes);
  return { payload, bytes, digest, objectId: `obj:sha256:${digest}` };
}

export function verifySealedEvidence(record, options) {
  const payload = verifyCanonicalBytes(record.bytes);
  validateEvidence(payload, options);
  need(canonicalJson(record.payload) === canonicalJson(payload), 'sealed payload/bytes mismatch');
  const digest = sha256Bytes(record.bytes);
  need(record.objectId === `obj:sha256:${digest}` && record.digest === digest, 'object digest mismatch');
  return payload;
}

function semanticId(payload) {
  if (payload.schema === SCHEMAS.build) return `studio-desktop@${payload.componentVersion}`;
  if (payload.schema === SCHEMAS.artifact) return payload.artifactId;
  if (payload.schema === SCHEMAS.rc) return payload.rcId;
  if (payload.schema === SCHEMAS.tag) return payload.tag;
  if (payload.schema === SCHEMAS.copy) return payload.copyId;
  return payload.releaseId;
}

export function createIndexEntry({ releaseId: id, sequence, previousEntryDigest, childSchema, childSemanticId, childObjectId, synthetic, disposition = 'observe', supersedesObjectId }) {
  const releaseVersion = releaseId(id);
  need(Number.isSafeInteger(sequence) && sequence > 0, 'index sequence invalid');
  if (sequence === 1) need(previousEntryDigest === null, 'sequence 1 must have null predecessor');
  else matches(previousEntryDigest, SHA, 'previousEntryDigest');
  need(KINDS.has(childSchema) && childSchema !== SCHEMAS.index, 'child schema invalid');
  string(childSemanticId, 'childSemanticId'); matches(childObjectId, OBJECT_ID, 'childObjectId');
  if (childSchema === SCHEMAS.build) need(childSemanticId === `studio-desktop@${releaseVersion}`, 'build/release identity mismatch');
  if (childSchema === SCHEMAS.artifact) need(childSemanticId.startsWith(`studio-desktop@${releaseVersion}/artifact/`), 'artifact/release identity mismatch');
  if (childSchema === SCHEMAS.rc) need(rcId(childSemanticId) === releaseVersion, 'RC/release identity mismatch');
  if (childSchema === SCHEMAS.tag) need(childSemanticId === `component/${id}`, 'tag/release identity mismatch');
  if ([SCHEMAS.decision, SCHEMAS.github, SCHEMAS.publication, SCHEMAS.delivery].includes(childSchema)) need(childSemanticId === id, 'child/release identity mismatch');
  need(typeof synthetic === 'boolean', 'explicit synthetic state required');
  need(['observe', 'supersede', 'reject', 'withdraw'].includes(disposition), 'disposition invalid');
  if (disposition === 'supersede' || disposition === 'reject') matches(supersedesObjectId, OBJECT_ID, 'supersedesObjectId');
  else need(supersedesObjectId === undefined, 'unexpected supersession target');
  const payload = {
    schema: SCHEMAS.index, synthetic, authorityEffect: 'NONE', releaseId: id,
    sequence, previousEntryDigest, childSchema, childSemanticId, childObjectId, disposition,
    ...(supersedesObjectId === undefined ? {} : { supersedesObjectId }),
  };
  const bytes = canonicalBytes(payload);
  const digest = sha256Bytes(bytes);
  return { payload, bytes, digest, indexId: `${id}/index/${sequence}/sha256:${digest}` };
}

export function validateIndexChain(entries, { mode = 'real', objects } = {}) {
  need(Array.isArray(entries) && entries.length > 0, 'empty index chain');
  need(['real', 'synthetic', 'synthetic-or-real'].includes(mode), 'invalid validation mode');
  if (mode === 'real') need(objects instanceof Map, 'real index requires sealed child objects');
  let prior = null;
  let id = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const payload = verifyCanonicalBytes(entry.bytes);
    need(canonicalJson(entry.payload) === canonicalJson(payload), 'index payload/bytes mismatch');
    need(payload.schema === SCHEMAS.index && payload.authorityEffect === 'NONE', 'index schema invalid');
    if (mode === 'real') need(payload.synthetic === false, 'synthetic index presented as real');
    if (mode === 'synthetic') need(payload.synthetic === true, 'index fixture lacks synthetic marker');
    need(payload.sequence === i + 1, 'index sequence gap, duplicate or fork');
    need(payload.previousEntryDigest === prior, 'predecessor mismatch');
    if (id === null) id = payload.releaseId;
    need(payload.releaseId === id, 'release identity mismatch');
    if (objects) {
      const child = objects.get(payload.childObjectId);
      need(child, 'missing sealed child object');
      const childPayload = verifySealedEvidence(child, { mode });
      need(childPayload.schema === payload.childSchema && semanticId(childPayload) === payload.childSemanticId, 'index child binding mismatch');
      if (childPayload.releaseId) need(childPayload.releaseId === id, 'index child release mismatch');
      if (childPayload.componentVersion) need(id === `studio-desktop/v${childPayload.componentVersion}`, 'index child version mismatch');
    }
    const rebuilt = createIndexEntry(payload);
    need(entry.digest === rebuilt.digest && entry.indexId === rebuilt.indexId, 'index digest mismatch');
    prior = `sha256:${entry.digest}`;
  }
  return true;
}

export function resolveIndexState(entries, options) {
  validateIndexChain(entries, options);
  const current = new Set();
  let withdrawn = false;
  for (const { payload } of entries) {
    if (payload.disposition === 'observe') current.add(payload.childObjectId);
    if (payload.disposition === 'supersede') {
      need(current.delete(payload.supersedesObjectId), 'superseded predecessor absent');
      current.add(payload.childObjectId);
    }
    if (payload.disposition === 'reject') need(current.delete(payload.supersedesObjectId), 'rejected predecessor absent');
    if (payload.disposition === 'withdraw') { withdrawn = true; current.clear(); }
  }
  return { current, withdrawn };
}

export function assertCurrentObject(entries, objectId, options) {
  const state = resolveIndexState(entries, options);
  need(!state.withdrawn && state.current.has(objectId), 'historical or withdrawn evidence is not current');
  return true;
}

export function validateReleaseChain({ build, artifacts, decision, rc }, options) {
  for (const record of [build, decision, rc, ...Object.values(artifacts)]) verifySealedEvidence(record, options);
  const b = build.payload;
  const r = rc.payload;
  const d = decision.payload;
  need(r.buildObjectId === build.objectId && r.sourceCommit === b.sourceCommit, 'source/build mismatch');
  need(r.releaseId === `studio-desktop/v${b.componentVersion}`, 'release/version mismatch');
  need(r.decisionObjectId === decision.objectId && d.decisionType === 'rc' && d.rcId === r.rcId && d.releaseId === r.releaseId, 'decision-reference mismatch');
  for (const kind of ['executable', 'app', 'dmg']) {
    const a = artifacts[kind];
    need(a && a.payload.kind === kind && r.artifactObjectIds[kind] === a.objectId, 'artifact substitution');
    need(a.payload.buildObjectId === build.objectId && a.payload.sourceCommit === b.sourceCommit && a.payload.componentVersion === b.componentVersion, 'source/artifact mismatch');
    need(a.payload.targetOs === b.targetOs && a.payload.architecture === b.architecture, 'artifact target mismatch');
  }
  need(artifacts.executable.payload.digest === b.executableSha256, 'executable digest mismatch');
  need(d.approvedAssetObjectIds.includes(artifacts.app.objectId) && d.approvedAssetObjectIds.includes(artifacts.dmg.objectId), 'approved asset set mismatch');
  return true;
}

export function validateReleaseEvents({ build, artifacts, rc, releaseDecision, tagDecision, publicationDecision, tag, github, publication }, options) {
  for (const record of [build, rc, releaseDecision, ...Object.values(artifacts)]) verifySealedEvidence(record, options);
  const releaseIdValue = rc.payload.releaseId;
  const approved = [artifacts.app.objectId, artifacts.dmg.objectId];
  need(releaseDecision.payload.decisionType === 'release' &&
    releaseDecision.payload.releaseId === releaseIdValue &&
    releaseDecision.payload.rcId === rc.payload.rcId &&
    releaseDecision.payload.approvedAssetObjectIds.length === approved.length &&
    approved.every((id) => releaseDecision.payload.approvedAssetObjectIds.includes(id)),
  'Release decision/approved RC mismatch');
  if (tag) {
    need(tagDecision, 'tag decision reference missing');
    verifySealedEvidence(tagDecision, options); verifySealedEvidence(tag, options);
    need(tagDecision.payload.decisionType === 'tag' && tagDecision.payload.releaseId === releaseIdValue &&
      tag.payload.decisionObjectId === tagDecision.objectId &&
      tag.payload.releaseDecisionObjectId === releaseDecision.objectId &&
      tag.payload.tag === `component/${releaseIdValue}` &&
      tag.payload.targetCommit === build.payload.sourceCommit, 'tag authority/source mismatch');
  }
  if (github) {
    need(publicationDecision && tag, 'hosted state needs publication decision and tag observation');
    verifySealedEvidence(publicationDecision, options); verifySealedEvidence(github, options);
    need(publicationDecision.payload.decisionType === 'publication' && publicationDecision.payload.releaseId === releaseIdValue &&
      publicationDecision.payload.approvedAssetObjectIds.length === approved.length &&
      approved.every((id) => publicationDecision.payload.approvedAssetObjectIds.includes(id)) &&
      github.payload.decisionObjectId === publicationDecision.objectId &&
      github.payload.releaseDecisionObjectId === releaseDecision.objectId &&
      github.payload.releaseId === releaseIdValue && github.payload.tag === tag.payload.tag &&
      github.payload.targetCommit === build.payload.sourceCommit &&
      github.payload.assets.length === approved.length &&
      [artifacts.app, artifacts.dmg].every((artifact) => github.payload.assets.some((asset) =>
        asset.artifactObjectId === artifact.objectId && asset.approvedDigest === artifact.payload.digest)),
    'hosted authority/asset mismatch');
  }
  if (publication) {
    need(github && github.payload.state === 'published', 'publication needs published hosted state');
    verifySealedEvidence(publication, options);
    need(publication.payload.githubEventObjectId === github.objectId &&
      publication.payload.decisionObjectId === publicationDecision.objectId &&
      publication.payload.releaseId === releaseIdValue, 'publication predecessor/authority mismatch');
  }
  return true;
}

export function validateReleaseId(id) { return releaseId(id); }
export function validateRcId(id) { return rcId(id); }
export function validateReleaseTag(tag) {
  const match = matches(tag, TAG, 'release tag').match(TAG);
  version(match[1]);
  return tag;
}
