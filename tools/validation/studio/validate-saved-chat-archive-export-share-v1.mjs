#!/usr/bin/env node
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

const J0_CONTRACT = 'release-evidence/2026-06-24/saved-chat-archive-phase-j0-export-share-contract.md';
const EXPORTER = 'src-surfaces-base/studio/ingestion/saved-chat-archive-exporter.studio.js';
const EXPORT_BUNDLE = 'src-surfaces-base/studio/ingestion/export-bundle.tauri.js';
const ARCHIVE_HEALTH_UI = 'src-surfaces-base/studio/ingestion/archive-health-ui.studio.js';
const STUDIO_HTML = 'src-surfaces-base/studio/studio.html';
const PACK_STUDIO = 'tools/product/studio/pack-studio.mjs';
const RECOVERY_VALIDATOR = 'tools/validation/studio/validate-saved-chat-archive-recovery-import-export-v1.mjs';
const IMPORT_HARNESS = 'tools/validation/studio/validate-saved-chat-archive-import-recovery-harness-v1.mjs';
const STUDIO_ROOT = 'src-surfaces-base/studio';
const ARCHIVE_EXPORT_CAPABILITY = 'apps/studio/desktop/src-tauri/capabilities/archive-export.json';
const PACKAGE_OWNER = 'src-surfaces-base/studio/ingestion/saved-chat-package-v1.tauri.js';
const HTML_SANITIZER = 'src-surfaces-base/studio/platform/html-sanitizer.js';
const CODEC = 'src-surfaces-base/studio/ingestion/saved-chat-package-codec.tauri.js';
const PORTABLE_ZIP = 'src-surfaces-base/studio/ingestion/saved-chat-portable-zip.studio.js';
const DIAGNOSTICS = 'src-surfaces-base/studio/ingestion/saved-chat-archive-diagnostics.tauri.js';
/* M10 P3.5: the Inspector resolves these two at call time. Loading the REAL
 * modules keeps this harness production-faithful — the alternative, stubbing
 * inspectPackage, would stop exercising the very path M08 import depends on. */
const TRUSTED_INTEGRITY = 'src-surfaces-base/studio/ingestion/saved-chat-archive-integrity.tauri.js';
/* M10 P3.6a: the importer verifies portable packages through this client. */
const PORTABLE_VERIFY = 'src-surfaces-base/studio/ingestion/saved-chat-portable-package-verification.tauri.js';
const HEALTH_MAPPING = 'src-surfaces-base/studio/ingestion/saved-chat-archive-health-mapping.js';
const INSPECTOR = 'src-surfaces-base/studio/ingestion/saved-chat-archive-inspector.studio.js';
const IMPORTER = 'src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js';
const FOLDER_PUBLISH_NATIVE = 'apps/studio/desktop/src-tauri/src/saved_chat_folder_publish.rs';
const ZIP_PUBLISH_NATIVE = 'apps/studio/desktop/src-tauri/src/saved_chat_zip_publish.rs';
const EXPORT_ROOT_POLICY_NATIVE = 'apps/studio/desktop/src-tauri/src/saved_chat_export_root_policy.rs';
const ARCHIVE_DURABLE_WRITE_NATIVE = 'apps/studio/desktop/src-tauri/src/archive_durable_write.rs';
const TAURI_LIB = 'apps/studio/desktop/src-tauri/src/lib.rs';
const ZIP_NATIVE_STAGE_ROOT = '.H2O Studio Saved Chat ZIP Staging';
const V3_FIXTURE = 'tools/validation/fixtures/saved-chat-archive/v3/t06-canonical-assets.h2ochat';
const V3_GZIP_FIXTURE = 'tools/validation/fixtures/saved-chat-archive/v3/gzip/t06-canonical-assets.h2ochat';
const CAPABILITY_FILES = [
  'apps/studio/desktop/src-tauri/capabilities/default.json',
  'apps/studio/desktop/src-tauri/capabilities/archive-cas.json',
];

const REQUIRED_STATUS_WORDS = [
  'verified',
  'export-ready',
  'exported',
  'destination-exists',
  'corrupted',
  'rejected',
  'read-error',
  'write-error',
];

const FORBIDDEN_EXPORT_RUNTIME_TOKENS = [
  'exportSavedChatPackage',
  'shareSavedChatPackage',
  'exportSavedChatArchivePackage',
  'archivePackageExporter',
  'savedChatPackageExporter',
  'copySavedChatPackageToExport',
];

const FORBIDDEN_CHROME_PACKAGE_BODY_TOKENS = [
  '.h2ochat',
  'archive/packages',
  'archive/assets',
  'writeSavedChatPackageV1',
  'buildSavedChatPackageV1',
  'materializeSavedChatArchiveRequestV1',
  'assetCas',
  'plugin:fs',
  'plugin:sql',
  'exportSavedChatPackage',
  'shareSavedChatPackage',
];

function repoPath(relPath) {
  return path.join(repoRoot, relPath);
}

function readRepo(relPath) {
  return fs.readFileSync(repoPath(relPath), 'utf8');
}

function existsRepo(relPath) {
  return fs.existsSync(repoPath(relPath));
}

function assertIncludes(haystack, needle, label = needle) {
  assert.ok(haystack.includes(needle), `missing required text: ${label}`);
}

function assertMatches(haystack, pattern, label = String(pattern)) {
  assert.ok(pattern.test(haystack), `missing required pattern: ${label}`);
}

function walkFiles(dirRel) {
  const root = repoPath(dirRel);
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(abs);
        continue;
      }
      if (entry.isFile()) {
        out.push(path.relative(repoRoot, abs));
      }
    }
  }
  return out.sort();
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function collectWriteLikeCapabilityScopes(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectWriteLikeCapabilityScopes(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  const permissionName = String(
    value.identifier ?? value.permission ?? value.name ?? value.id ?? '',
  );
  const writeLike = /fs:.*(?:write|mkdir|rename|remove|delete)|(?:write|mkdir|rename|remove|delete)/i.test(
    permissionName,
  );

  if (writeLike) {
    out.push(...collectStrings(value.allow));
    out.push(...collectStrings(value.scope));
    out.push(...collectStrings(value.scopes));
  }

  for (const item of Object.values(value)) {
    collectWriteLikeCapabilityScopes(item, out);
  }
  return out;
}

function scanFilesForTokens(files, tokens) {
  const hits = [];
  for (const relPath of files) {
    const text = readRepo(relPath);
    for (const token of tokens) {
      if (text.includes(token)) {
        hits.push(`${relPath}: ${token}`);
      }
    }
  }
  return hits;
}

function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const checks = [];
const asyncChecks = [];
function check(name, fn) {
  checks.push({ name, fn });
}
function checkAsync(name, fn) {
  asyncChecks.push({ name, fn });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) {
  return `sha256-${nodeCrypto.createHash('sha256').update(Buffer.from(value)).digest('hex')}`;
}

function createBehaviorFs(config = {}) {
  const dirs = new Set();
  const files = new Map();
  const APP = 15;
  const HOME = 21;
  const exportBaseDir = config.exportBaseDir === APP ? APP : HOME;
  const folderStageCreateNames = [];
  let beforeFolderPublish = null;
  let folderPublishCalls = 0;
  let beforeZipPublish = null;
  let zipPublishCalls = 0;
  const zipStageNames = [];
  const zipPublishOptions = [];
  let zipIdentityFault = '';
  const key = (baseDir, p) => `${baseDir}:${p}`;
  const splitKey = (entry) => {
    const index = entry.indexOf(':');
    return { baseDir: Number(entry.slice(0, index)), path: entry.slice(index + 1) };
  };
  function parents(baseDir, p) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(key(baseDir, parts.slice(0, i).join('/')));
  }
  function mkdir(baseDir, p) { parents(baseDir, p); dirs.add(key(baseDir, p)); }
  function put(baseDir, p, value) { parents(baseDir, p); files.set(key(baseDir, p), Buffer.from(value)); }
  function exists(baseDir, p) { return dirs.has(key(baseDir, p)) || files.has(key(baseDir, p)); }
  function list(baseDir, p) {
    const prefix = `${p.replace(/\/$/, '')}/`;
    const out = new Map();
    for (const entry of dirs) {
      const parsed = splitKey(entry);
      if (parsed.baseDir !== baseDir || !parsed.path.startsWith(prefix)) continue;
      const rest = parsed.path.slice(prefix.length);
      if (rest && !rest.includes('/')) out.set(rest, { name: rest, isDirectory: true });
    }
    for (const entry of files.keys()) {
      const parsed = splitKey(entry);
      if (parsed.baseDir !== baseDir || !parsed.path.startsWith(prefix)) continue;
      const rest = parsed.path.slice(prefix.length);
      if (rest && !rest.includes('/')) out.set(rest, { name: rest, isFile: true });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function removeTree(baseDir, p) {
    const exact = key(baseDir, p);
    const prefix = `${exact}/`;
    for (const entry of [...files.keys()]) if (entry === exact || entry.startsWith(prefix)) files.delete(entry);
    for (const entry of [...dirs]) if (entry === exact || entry.startsWith(prefix)) dirs.delete(entry);
  }
  function renameTree(oldBaseDir, oldPath, newBaseDir, newPath) {
    if (exists(newBaseDir, newPath)) throw new Error('destination exists');
    const oldKey = key(oldBaseDir, oldPath);
    const oldPrefix = `${oldKey}/`;
    const fileMoves = [...files.entries()].filter(([entry]) => entry === oldKey || entry.startsWith(oldPrefix));
    const dirMoves = [...dirs].filter((entry) => entry === oldKey || entry.startsWith(oldPrefix));
    for (const [entry, bytes] of fileMoves) {
      const suffix = entry.slice(oldKey.length);
      files.set(key(newBaseDir, newPath) + suffix, bytes);
      files.delete(entry);
    }
    for (const entry of dirMoves) {
      const suffix = entry.slice(oldKey.length);
      dirs.add(key(newBaseDir, newPath) + suffix);
      dirs.delete(entry);
    }
  }
  /* M10 P1 trusted archive-integrity envelope, answered from the EXPLICIT
   * fixture facts this suite already installed (the manifest each test wrote),
   * never by running the legacy package verifier and relabelling its output.
   * Classification is honest: a package whose manifest is absent or unparseable
   * is reported indeterminate rather than quietly verified.
   *
   * The wire form for contentHash and assetShas is BARE canonical hex, matching
   * the real Rust command; the Inspector is what re-applies the `sha256-`
   * prefix outwardly. */
  function trustedIntegrityEnvelope() {
    const roots = new Set();
    for (const entry of files.keys()) {
      const { baseDir, path: p } = splitKey(entry);
      if (baseDir !== APP) continue;
      const m = /^(archive\/packages\/[^/]+)\//.exec(p);
      if (m) roots.add(m[1]);
    }
    const bare = (value) => String(value || '').trim().toLowerCase().replace(/^sha256-/, '');
    const occupants = [...roots].sort().map((root) => {
      const name = root.slice('archive/packages/'.length);
      const raw = files.get(key(APP, `${root}/manifest.json`));
      let manifest = null;
      try { manifest = raw ? JSON.parse(raw.toString('utf8')) : null; } catch { manifest = null; }
      if (!manifest || !manifest.chatId || !manifest.contentHash) {
        return {
          path: root,
          name,
          class: 'indeterminate',
          reason: 'corrupt',
          blockers: [{ code: 'generation-manifest-json-invalid' }],
        };
      }
      const schemaVersion = Number(manifest.schemaVersion) || 1;
      const snapshot = (manifest.files && manifest.files.snapshot) || {};
      return {
        path: root,
        name,
        /* `.g<hash>.h2ochat` is the generation basename the publisher writes. */
        class: /\.g[0-9a-f]{64}\.h2ochat$/.test(name) ? 'verified-generation' : 'legacy-package',
        chatId: String(manifest.chatId),
        snapshotId: String(manifest.snapshotId || ''),
        contentHash: bare(manifest.contentHash),
        constructionFamily: `v${schemaVersion}`,
        snapshotEncoding: String(snapshot.encoding || 'identity'),
        snapshotPhysicalByteLength: snapshot.byteLength,
        logicalSnapshotByteLength: snapshot.contentByteLength,
        logicalSnapshotSha256: bare(snapshot.contentSha256),
        assetShas: (manifest.assets || []).map((a) => bare(a && a.sha256)).filter(Boolean).sort(),
        savedAt: (manifest.provenance && manifest.provenance.generatedAt) || '',
        orderable: true,
      };
    });
    return {
      schema: 'h2o.savedChatArchiveIntegrity',
      schemaVersion: 1,
      complete: true,
      blockers: [],
      occupants,
    };
  }

  /* M10 P3.6a portable verification session. The importer now asks trusted
   * native code, so this harness must answer the same five commands.
   *
   * The verdict is derived from the members the session actually received,
   * checked against the manifest's own claims using THIS suite's fixture
   * construction rule (`canonicalJson`/`sha256` above) — the same rule that
   * built the packages. It is not a second verifier: it exists so a fixture
   * that lies about its contentHash is refused here exactly as trusted Rust
   * refuses it in the product. */
  const portableSessions = new Map();
  let portableToken = 1;

  function portableVerdict(session) {
    const refuse = (stage, code) => ({
      schema: 'h2o.savedChatPortablePackageVerification',
      schemaVersion: 1, verified: false, refusal: { stage, code },
    });
    if (session.unexpected.length) {
      return refuse('verifier', 'generation-package-unexpected-member');
    }
    for (const [key, member] of session.members) {
      if (member.received !== member.expected) return refuse('adapter', 'portable-member-incomplete');
      if (key === undefined) return refuse('adapter', 'portable-member-incomplete');
    }
    const manifestBytes = session.members.get('manifest')?.bytes;
    if (!manifestBytes) return refuse('adapter', 'portable-manifest-missing');
    let manifest;
    try { manifest = JSON.parse(Buffer.concat(manifestBytes).toString('utf8')); }
    catch { return refuse('verifier', 'generation-manifest-json-invalid'); }

    const stem = session.basename.replace(/\.h2ochat$/, '');
    const beginChatId = /\.g[0-9a-f]{64}$/.test(stem) ? stem.replace(/\.g[0-9a-f]{64}$/, '') : stem;
    if (manifest.chatId !== beginChatId) return refuse('verifier', 'generation-chat-id-mismatch');

    const stored = session.members.get('snapshot');
    if (!stored) return refuse('verifier', 'generation-snapshot-missing');
    const storedBytes = Buffer.concat(stored.bytes);
    const encoding = manifest.files?.snapshot?.encoding || 'identity';
    let logical = storedBytes;
    if (encoding === 'gzip') {
      try { logical = zlib.gunzipSync(storedBytes); }
      catch { return refuse('verifier', 'generation-v3-gzip-decode-failed'); }
    }
    const logicalSha = sha256(logical);
    if (sha256(storedBytes) !== (manifest.files?.snapshot?.sha256 || '')) {
      return refuse('verifier', 'generation-member-sha-mismatch');
    }
    /* v1/v2 carry persistent renderers whose member hashes the manifest
     * declares; a corrupt renderer must refuse here exactly as it does in the
     * product. */
    for (const [memberKey, descriptorKey] of [['markdown', 'markdown'], ['html', 'html']]) {
      const member = session.members.get(memberKey);
      const descriptor = manifest.files?.[descriptorKey];
      if (member && descriptor && sha256(Buffer.concat(member.bytes)) !== descriptor.sha256) {
        return refuse('verifier', 'generation-member-sha-mismatch');
      }
    }
    const assetShas = [...session.members.entries()]
      .filter(([key]) => key.startsWith('asset:'))
      .map(([, member]) => sha256(Buffer.concat(member.bytes)))
      .sort();
    const schemaVersion = Number(manifest.schemaVersion) || 1;
    const expected = schemaVersion === 3
      ? sha256(canonicalJson({ payloadVersion: 3, snapshot: logicalSha, assets: assetShas }))
      : schemaVersion === 2
        ? sha256(canonicalJson({ snapshot: logicalSha, assets: assetShas }))
        : logicalSha;
    if (expected !== manifest.contentHash) {
      return refuse('verifier', 'generation-content-hash-mismatch');
    }
    const bare = (v) => String(v || '').replace(/^sha256-/, '');
    return {
      schema: 'h2o.savedChatPortablePackageVerification',
      schemaVersion: 1,
      verified: true,
      packageDirName: session.basename,
      chatId: manifest.chatId,
      snapshotId: manifest.snapshotId,
      contentHash: bare(manifest.contentHash),
      constructionFamily: `v${schemaVersion}`,
      nameClassification: /\.g[0-9a-f]{64}$/.test(stem) ? 'generation' : 'legacy',
      assetShas: assetShas.map(bare),
      logicalSnapshotByteLength: logical.length,
    };
  }

  async function invoke(command, body, metadata) {
    if (command === 'h2o_saved_chat_portable_verify_begin') {
      const request = body?.options || {};
      const token = portableToken;
      portableToken += 1;
      portableSessions.set(token, {
        basename: String(request.packageDirName || ''),
        unexpected: Array.isArray(request.unexpectedMembers) ? request.unexpectedMembers : [],
        members: new Map(),
      });
      return { schema: 'h2o.savedChatPortablePackageVerification', schemaVersion: 1, ok: true, token };
    }
    if (command === 'h2o_saved_chat_portable_verify_declare') {
      const request = body?.options || {};
      const session = portableSessions.get(request.token);
      if (!session) return { ok: false, code: 'portable-session-unknown' };
      if (session.members.has(request.member)) return { ok: false, code: 'portable-member-duplicate' };
      session.members.set(request.member, { expected: request.expectedLength, received: 0, bytes: [] });
      return { ok: true };
    }
    if (command === 'h2o_saved_chat_portable_verify_write') {
      const options = JSON.parse(metadata?.headers?.options || '{}');
      const session = portableSessions.get(options.token);
      if (!session) return { ok: false, code: 'portable-session-unknown' };
      const member = session.members.get(options.member);
      if (!member) return { ok: false, code: 'portable-member-undeclared' };
      const chunk = Buffer.from(body);
      if (member.received + chunk.length > member.expected) return { ok: false, code: 'portable-member-overrun' };
      member.received += chunk.length;
      member.bytes.push(chunk);
      return { ok: true };
    }
    if (command === 'h2o_saved_chat_portable_verify_finish') {
      const token = body?.options?.token;
      const session = portableSessions.get(token);
      portableSessions.delete(token);
      if (!session) {
        return {
          schema: 'h2o.savedChatPortablePackageVerification', schemaVersion: 1,
          verified: false, refusal: { stage: 'adapter', code: 'portable-session-unknown' },
        };
      }
      return portableVerdict(session);
    }
    if (command === 'h2o_saved_chat_portable_verify_abort') {
      portableSessions.delete(body?.options?.token);
      return { ok: true };
    }
    if (command === 'h2o_saved_chat_archive_integrity') {
      return trustedIntegrityEnvelope();
    }
    if (command === 'h2o_saved_chat_export_root_policy') {
      if (config.exportPolicyError) throw new Error(String(config.exportPolicyError));
      if (config.exportPolicyWire !== undefined) return config.exportPolicyWire;
      return {
        schema: 'h2o.studio.saved-chat-export-root-policy.v1',
        baseDirectory: exportBaseDir === APP ? 'appLocalData' : 'home',
      };
    }
    if (command === 'plugin:fs|write_file') {
      const p = decodeURIComponent(metadata?.headers?.path || '');
      const options = JSON.parse(metadata?.headers?.options || '{}');
      put(options.baseDir, p, body);
      return null;
    }
    if (command === 'h2o_create_saved_chat_folder_stage') {
      const request = body?.request || {};
      const finalName = String(request.finalName || '');
      const token = String(request.token || '');
      const stagedName = `${finalName}.tmp-${token}`;
      const stagedPath = `H2O Studio Exports/${stagedName}`;
      folderStageCreateNames.push(stagedName);
      if (exists(exportBaseDir, stagedPath)) {
        return { schema: 'h2o.savedChatFolderStage.v1', ok: false, status: 'stage-exists', owned: false, stagedName: null };
      }
      mkdir(exportBaseDir, stagedPath);
      return { schema: 'h2o.savedChatFolderStage.v1', ok: true, status: 'created', owned: true, stagedName };
    }
    if (command === 'h2o_publish_saved_chat_folder_create_only') {
      folderPublishCalls += 1;
      const request = body?.request || {};
      const stagedPath = `H2O Studio Exports/${request.stagedName || ''}`;
      const finalPath = `H2O Studio Exports/${request.finalName || ''}`;
      if (beforeFolderPublish) {
        const hook = beforeFolderPublish;
        beforeFolderPublish = null;
        await hook({ stagedPath, finalPath });
      }
      if (exists(exportBaseDir, finalPath)) {
        return { schema: 'h2o.savedChatFolderPublish.v1', ok: false, status: 'destination-exists', stagingRemoved: false };
      }
      if (!dirs.has(key(exportBaseDir, stagedPath))) {
        return { schema: 'h2o.savedChatFolderPublish.v1', ok: false, status: 'staged-missing', stagingRemoved: false };
      }
      renameTree(exportBaseDir, stagedPath, exportBaseDir, finalPath);
      return { schema: 'h2o.savedChatFolderPublish.v1', ok: true, status: 'published', stagingRemoved: true };
    }
    if (command === 'h2o_publish_saved_chat_zip_bytes_create_only') {
      zipPublishCalls += 1;
      const options = JSON.parse(decodeURIComponent(metadata?.headers?.options || ''));
      const finalName = String(options.finalName || '');
      const token = String(options.token || '');
      const stagedName = `${finalName}.tmp-${token}`;
      const stagedPath = `${ZIP_NATIVE_STAGE_ROOT}/${stagedName}`;
      const finalPath = `H2O Studio Exports/${finalName}`;
      zipStageNames.push(stagedName);
      zipPublishOptions.push({ ...options });
      if (exists(exportBaseDir, stagedPath)) {
        return { schema: 'h2o.savedChatZipPublish.v1', ok: false, status: 'stage-exists', stagingRemoved: false, committed: false, durabilityComplete: false, byteLength: 0, sha256: '', fullFsync: false };
      }
      const ownedBytes = Buffer.from(body);
      put(exportBaseDir, stagedPath, ownedBytes);
      /* Buffer object identity models the retained native descriptor. The
       * final publication selects this object, never a later incarnation of
       * the staging pathname. */
      const ownedEntry = files.get(key(exportBaseDir, stagedPath));
      const actualLength = zipIdentityFault === 'length' ? ownedEntry.length + 1 : ownedEntry.length;
      const actualSha = zipIdentityFault === 'hash'
        ? sha256(Buffer.concat([ownedEntry, Buffer.from('mismatch')]))
        : sha256(ownedEntry);
      if (Number(options.expectedByteLength) !== actualLength) {
        if (files.get(key(exportBaseDir, stagedPath)) === ownedEntry) files.delete(key(exportBaseDir, stagedPath));
        return { schema: 'h2o.savedChatZipPublish.v1', ok: false, status: 'staged-length-mismatch', stagingRemoved: true, committed: false, durabilityComplete: false, byteLength: 0, sha256: '', fullFsync: false };
      }
      if (String(options.expectedSha256 || '') !== actualSha) {
        if (files.get(key(exportBaseDir, stagedPath)) === ownedEntry) files.delete(key(exportBaseDir, stagedPath));
        return { schema: 'h2o.savedChatZipPublish.v1', ok: false, status: 'staged-hash-mismatch', stagingRemoved: true, committed: false, durabilityComplete: false, byteLength: 0, sha256: '', fullFsync: false };
      }
      if (beforeZipPublish) {
        const hook = beforeZipPublish;
        beforeZipPublish = null;
        await hook({ stagedName, stagedPath, finalPath });
      }
      if (exists(exportBaseDir, finalPath)) {
        const stagingRemoved = files.get(key(exportBaseDir, stagedPath)) === ownedEntry;
        if (stagingRemoved) files.delete(key(exportBaseDir, stagedPath));
        return { schema: 'h2o.savedChatZipPublish.v1', ok: false, status: 'destination-exists', stagingRemoved, committed: false, durabilityComplete: false, byteLength: 0, sha256: '', fullFsync: false };
      }
      files.set(key(exportBaseDir, finalPath), Buffer.from(ownedEntry));
      const stagingRemoved = files.get(key(exportBaseDir, stagedPath)) === ownedEntry;
      if (stagingRemoved) files.delete(key(exportBaseDir, stagedPath));
      return { schema: 'h2o.savedChatZipPublish.v1', ok: true, status: 'published', stagingRemoved, committed: true, durabilityComplete: true, byteLength: ownedEntry.length, sha256: actualSha, fullFsync: true };
    }
    const p = body?.path;
    const options = body?.options || {};
    if (command === 'plugin:fs|exists') return exists(options.baseDir, p);
    if (command === 'plugin:fs|mkdir') { mkdir(options.baseDir, p); return null; }
    if (command === 'plugin:fs|remove') { removeTree(options.baseDir, p); return null; }
    if (command === 'plugin:fs|read_dir') {
      if (!exists(options.baseDir, p)) throw new Error(`not found: ${p}`);
      return list(options.baseDir, p);
    }
    if (command === 'plugin:fs|lstat') {
      /* Metadata derived from the same fixture filesystem state that backs
       * exists()/read_file, so the governed bounded reader used by Diagnostics
       * sees the real stored member size. No hard-coded sizes. */
      const value = files.get(key(options.baseDir, p));
      if (value) return { isFile: true, isDirectory: false, isSymlink: false, size: value.length };
      if (dirs.has(key(options.baseDir, p))) return { isFile: false, isDirectory: true, isSymlink: false, size: 0 };
      throw new Error(`not found: ${p}`);
    }
    if (command === 'plugin:fs|read_file') {
      const value = files.get(key(options.baseDir, p));
      if (!value) throw new Error(`not found: ${p}`);
      return Uint8Array.from(value);
    }
    throw new Error(`unexpected fs command: ${command}`);
  }
  function inventory(baseDir, prefix) {
    const marker = `${prefix.replace(/\/$/, '')}/`;
    return [...files.entries()]
      .map(([entry, bytes]) => ({ ...splitKey(entry), bytes }))
      .filter((item) => item.baseDir === baseDir && (item.path === prefix || item.path.startsWith(marker)))
      .map((item) => ({ path: item.path, sha256: sha256(item.bytes), byteLength: item.bytes.length }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  mkdir(APP, 'archive/packages');
  return {
    APP, HOME, exportBaseDir, dirs, files, invoke, mkdir, put, exists, inventory, key,
    folderStageCreateNames() { return folderStageCreateNames.slice(); },
    setBeforeFolderPublish(fn) { beforeFolderPublish = fn; },
    folderPublishCallCount() { return folderPublishCalls; },
    setBeforeZipPublish(fn) { beforeZipPublish = fn; },
    zipPublishCallCount() { return zipPublishCalls; },
    zipStageNames() { return zipStageNames.slice(); },
    zipPublishOptions() { return zipPublishOptions.map((item) => ({ ...item })); },
    setZipIdentityFault(value) { zipIdentityFault = String(value || ''); },
  };
}

function makeBehaviorPackage({ schemaVersion, chatId, withAsset = false, encoding = 'identity' }) {
  const snapshotId = `${chatId}_snapshot`;
  const assetBytes = Buffer.from('t05-governed-image');
  const assetSha = sha256(assetBytes);
  const assetPath = `assets/${assetSha}.png`;
  const htmlOne = `<p>First <strong>typed HTML</strong>${withAsset ? `<img src="${assetPath}">` : ''}</p>`;
  const htmlTwo = '<p>Second <em>typed HTML</em></p>';
  const messages = schemaVersion === 3
    ? [
      { id: 'm0', role: 'user', turnIndex: 0, content: [{ type: 'text', text: 'First typed message' }, { type: 'html', html: htmlOne, sanitized: true }], assetRefs: withAsset ? [assetSha] : [] },
      { id: 'm1', role: 'assistant', turnIndex: 1, content: [{ type: 'text', text: 'Second typed message' }, { type: 'html', html: htmlTwo, sanitized: true }], assetRefs: [] },
    ]
    : [
      { id: 'm0', role: 'user', turnIndex: 0, contentText: 'Legacy first', contentHtml: htmlOne, content: [{ type: 'text', text: 'Legacy first' }, { type: 'html', html: htmlOne, sanitized: true }], assetRefs: withAsset ? [assetSha] : [] },
    ];
  const snapshot = {
    schema: 'h2o.savedChatSnapshot', schemaVersion, chatId, snapshotId,
    title: `Export ${chatId}`, capturedAt: '2026-08-24T00:00:00.000Z', source: {}, messages,
  };
  const snapshotText = canonicalJson(snapshot);
  const snapshotBytes = Buffer.from(snapshotText);
  const snapshotSha = sha256(snapshotBytes);
  const assets = withAsset ? [{ sha256: assetSha, path: assetPath, ext: 'png', mimeType: 'image/png', byteLength: assetBytes.length, source: 'chatgpt-capture' }] : [];
  const files = {};
  if (schemaVersion === 3) {
    files.snapshot = { path: 'snapshot.json', sha256: snapshotSha, byteLength: snapshotBytes.length, encoding };
    if (encoding !== 'identity') {
      files.snapshot.contentSha256 = snapshotSha;
      files.snapshot.contentByteLength = snapshotBytes.length;
    }
  } else {
    const markdownText = `# Legacy ${chatId}\n`;
    const htmlText = `<!doctype html><p>Legacy ${chatId}</p>${withAsset ? `<img src="${assetPath}">` : ''}`;
    files.snapshot = { path: 'snapshot.json', sha256: snapshotSha, byteLength: snapshotBytes.length };
    files.markdown = { path: 'chat.md', sha256: sha256(markdownText), byteLength: Buffer.byteLength(markdownText) };
    files.html = { path: 'chat.html', sha256: sha256(htmlText), byteLength: Buffer.byteLength(htmlText) };
    files.__texts = { markdownText, htmlText };
  }
  const contentHash = schemaVersion === 3
    ? sha256(canonicalJson({ payloadVersion: 3, snapshot: files.snapshot.contentSha256 ?? snapshotSha, assets: assets.map((asset) => asset.sha256).sort() }))
    : schemaVersion === 2
      ? sha256(canonicalJson({ snapshot: snapshotSha, assets: assets.map((asset) => asset.sha256).sort() }))
      : snapshotSha;
  const manifestFiles = { snapshot: files.snapshot };
  if (schemaVersion !== 3) { manifestFiles.markdown = files.markdown; manifestFiles.html = files.html; }
  const manifest = {
    schema: 'h2o.savedChatPackage', schemaVersion, chatId, snapshotId,
    contentHash, files: manifestFiles, assets,
  };
  if (schemaVersion >= 2) manifest.payloadVersion = schemaVersion;
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  return { chatId, snapshotId, snapshot, snapshotText, snapshotBytes, assetBytes, assetSha, assetPath, assets, files, manifest, manifestText };
}

function readCommittedV3Fixture() {
  const root = path.join(repoRoot, V3_FIXTURE);
  const manifestText = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  const snapshotBytes = fs.readFileSync(path.join(root, 'snapshot.json'));
  const manifest = JSON.parse(manifestText);
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  const assetPath = manifest.assets[0].path;
  const assetBytes = fs.readFileSync(path.join(root, assetPath));
  return {
    chatId: manifest.chatId,
    snapshotId: manifest.snapshotId,
    snapshot,
    snapshotBytes,
    assetBytes,
    assetSha: manifest.assets[0].sha256,
    assetPath,
    assets: manifest.assets,
    files: { snapshot: manifest.files.snapshot },
    manifest,
    manifestText,
  };
}

/* M03 T04: a REAL gzip-v3 package built from the committed identity fixture.
 * Logical content is byte-identical to that fixture, so identity and gzip
 * variants are directly comparable; only the physical representation differs.
 * contentHash is logical and therefore unchanged. */
function gzipCommittedV3Fixture({ corrupt = false } = {}) {
  const base = readCommittedV3Fixture();
  /* M03 T05: the valid gzip case reads the PERMANENT committed gzip-v3 fixture,
   * so export assurance exercises the same repository bytes a maintainer can
   * inspect. Corrupt variants are still derived in temporary memory only. */
  let stored = fs.readFileSync(path.join(repoRoot, V3_GZIP_FIXTURE, 'snapshot.json'));
  if (corrupt) { stored = Buffer.from(stored); stored[Math.floor(stored.length / 2)] ^= 0xff; }
  const manifest = JSON.parse(base.manifestText);
  manifest.files.snapshot = {
    path: 'snapshot.json',
    sha256: sha256(stored),
    byteLength: stored.length,
    encoding: 'gzip',
    /* identity fixture stores plaintext, so its sha256 IS the logical sha */
    contentSha256: base.manifest.files.snapshot.sha256,
    contentByteLength: base.snapshotBytes.length,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  return Object.assign({}, base, {
    snapshotBytes: stored,
    manifest,
    manifestText,
    files: { snapshot: manifest.files.snapshot },
  });
}

function installBehaviorPackage(mem, pkg, rootOverride) {
  const root = rootOverride || `archive/packages/${pkg.chatId}.h2ochat`;
  mem.mkdir(mem.APP, root);
  mem.put(mem.APP, `${root}/manifest.json`, pkg.manifestText);
  mem.put(mem.APP, `${root}/snapshot.json`, pkg.snapshotBytes);
  if (pkg.manifest.schemaVersion !== 3) {
    mem.put(mem.APP, `${root}/chat.md`, pkg.files.__texts.markdownText);
    mem.put(mem.APP, `${root}/chat.html`, pkg.files.__texts.htmlText);
  }
  if (pkg.assets.length) {
    mem.mkdir(mem.APP, `${root}/assets`);
    mem.put(mem.APP, `${root}/${pkg.assetPath}`, pkg.assetBytes);
  }
  return root;
}

function loadBehaviorRuntime(mem, storeOverride, cryptoOverride) {
  const defaultStore = {
    chats: {
      get: async (id) => ({ chatId: id }),
      upsert: async (patch) => patch,
    },
    snapshots: {
      get: async (id) => ({ snapshot: { snapshotId: id } }),
      listByChat: async () => [],
      create: async (patch) => ({ snapshot: { snapshotId: 'fixture-created-snapshot', chatId: patch.chatId } }),
    },
    assets: { listBySnapshot: async () => [] },
  };
  const context = {
    console, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    atob: globalThis.atob, crypto: cryptoOverride || globalThis.crypto || nodeCrypto.webcrypto,
    /* Host Web Streams / compression primitives required by the governed codec. */
    ReadableStream, CompressionStream, DecompressionStream,
    __TAURI_INTERNALS__: { invoke: mem.invoke },
    H2O: { Studio: {
      ingestion: { assetCas: { exists: async () => true, describe: async (id) => ({ exists: true, sha256: id }) } },
      store: storeOverride || defaultStore,
    } },
  };
  context.globalThis = context; context.window = context;
  const sandbox = vm.createContext(context);
  /* The governed saved-chat package codec must execute before Diagnostics,
   * mirroring the product load order in studio.html. The REAL codec source is
   * loaded here - never a mock - so this harness exercises the same single
   * gzip/verification authority that product consumers use. */
  for (const relPath of [HTML_SANITIZER, PACKAGE_OWNER, CODEC, PORTABLE_ZIP, DIAGNOSTICS,
    TRUSTED_INTEGRITY, HEALTH_MAPPING, INSPECTOR, IMPORTER, PORTABLE_VERIFY, EXPORTER]) {
    vm.runInContext(readRepo(relPath), sandbox, { filename: relPath });
  }
  return sandbox;
}

check('J.0 export/share contract exists', () => {
  assert.ok(existsRepo(J0_CONTRACT), `${J0_CONTRACT} does not exist`);
});

const j0 = readRepo(J0_CONTRACT);
const exporterSrc = existsRepo(EXPORTER) ? readRepo(EXPORTER) : '';
const exporterCode = stripComments(exporterSrc);

check('J.0 is marked contract-only and not implemented', () => {
  assertMatches(j0, /PHASE J\.0 CONTRACT\s*[—-]\s*NOT IMPLEMENTED/, 'PHASE J.0 CONTRACT - NOT IMPLEMENTED');
  assertIncludes(j0, 'No runtime, validator, capability');
});

check('J.0 recommends Desktop-only folder-copy export first', () => {
  assertIncludes(j0, 'Start with Desktop-only folder-copy export');
  assertIncludes(j0, 'already-verified `.h2ochat`');
  assertIncludes(j0, 'byte-identical copy');
});

check('J.0 defers zip format', () => {
  assertIncludes(j0, 'Do not implement zip first');
  assertIncludes(j0, 'J.4');
  assertIncludes(j0, 'zip / single-file');
});

check('J.0 defers cloud/WebDAV/sync/share integration', () => {
  assertIncludes(j0, 'Do not implement cloud / WebDAV / share-sheet integration first');
  assertIncludes(j0, 'No sync / WebDAV / cloud / native messaging');
});

check('J.0 defers restore/relink', () => {
  assertIncludes(j0, 'Do not implement restore / relink in Phase J');
  assertMatches(j0, /`restore`\s*\/ relink remains \*\*deferred\*\*/, 'restore/relink deferred wording');
});

check('J.0 requires package verification before export', () => {
  for (const text of [
    'inspectPackage',
    'verified',
    'manifest.json',
    'required files',
    'file hashes',
    'contentHash',
    'assets',
    'checked if present',
  ]) {
    assertIncludes(j0, text);
  }
});

check('J.0 defines destination safety', () => {
  for (const text of [
    'Explicit operator-selected destination',
    'No silent overwrite',
    'destination-exists',
    'bounded export root',
    '$HOME/H2O Studio Exports/',
    '$DOWNLOAD/**',
  ]) {
    assertIncludes(j0, text);
  }
});

check('J.0 preserves Desktop authority and Chrome body restrictions', () => {
  for (const text of [
    'Desktop-only',
    'Chrome **cannot** export / share a package body',
    'cannot** read',
    'the package / CAS body',
    'explicit export destination',
  ]) {
    assertIncludes(j0, text);
  }
});

check('J.0 defines export result/status vocabulary', () => {
  for (const status of REQUIRED_STATUS_WORDS) {
    assertIncludes(j0, status);
  }
});

check('J.0 distinguishes .h2ochat export from full-library bundle export', () => {
  for (const text of [
    'Full-bundle export is a DIFFERENT artifact',
    'h2o.studio.fullBundle.v2',
    'export-bundle.tauri.js',
    'single-`.h2ochat`-package',
  ]) {
    assertIncludes(j0, text);
  }
});

check('J.2 exporter module exists and registers H2O.Studio.archiveExporter APIs', () => {
  assert.ok(existsRepo(EXPORTER), `${EXPORTER} does not exist`);
  assertMatches(exporterSrc, /H2O\.Studio\.archiveExporter\s*=/);
  for (const name of [
    'isDesktopCapable',
    'resolveExportDestination',
    'dryRunExportPackage',
    'exportVerifiedPackage',
    'renderArchiveExporterCard',
    'mountArchiveExporterCard',
  ]) {
    assertIncludes(exporterSrc, name);
  }
});

check('M08 portable ZIP codec and round-trip APIs are shipped Desktop-side', () => {
  assert.ok(existsRepo(PORTABLE_ZIP), `${PORTABLE_ZIP} does not exist`);
  const zipSource = readRepo(PORTABLE_ZIP);
  assertIncludes(zipSource, "CompressionStream('deflate-raw')");
  assertIncludes(zipSource, "DecompressionStream('deflate-raw')");
  assertIncludes(zipSource, 'readPortablePackageZip');
  assertIncludes(exporterSrc, 'dryRunExportPackageZip');
  assertIncludes(exporterSrc, 'exportVerifiedPackageZip');
  const importerSource = readRepo(IMPORTER);
  assertIncludes(importerSource, 'dryRunImportZip');
  assertIncludes(importerSource, 'importVerifiedZip');
  assertIncludes(readRepo(STUDIO_HTML), './ingestion/saved-chat-portable-zip.studio.js');
  assertIncludes(readRepo(PACK_STUDIO), 'ingestion/saved-chat-portable-zip.studio.js');
});

check('J.2 exporter is Desktop-only and verification-gated through inspectPackage', () => {
  assertIncludes(exporterCode, 'detectTauri');
  assertIncludes(exporterCode, 'isDesktopCapable');
  assertIncludes(exporterCode, 'archiveInspector');
  assertIncludes(exporterCode, 'inspectPackage');
  assertMatches(exporterCode, /inspectStatus\s*!==\s*['"]verified['"]/);
  assertIncludes(exporterCode, 'dryRunExportPackage');
  assertIncludes(exporterCode, 'exportVerifiedPackage');
});

check('J.2 exporter uses fixed bounded export root and no arbitrary destination root', () => {
  assertIncludes(exporterCode, "EXPORT_ROOT = 'H2O Studio Exports'");
  assertIncludes(exporterCode, 'HOME_BASE_DIR = 21');
  assertIncludes(exporterCode, 'APP_LOCAL_DATA = 15');
  assertIncludes(exporterCode, 'h2o_saved_chat_export_root_policy');
  assertIncludes(exporterCode, 'validateExportRootPolicyWire');
  assertIncludes(exporterCode, 'exportRootOptions');
  assertIncludes(exporterCode, 'resolveExportDestination');
  assert.doesNotMatch(exporterCode, /destinationRoot|rootPath|targetRoot|absoluteDestination|showOpenDialog|showSaveDialog|dialog:/);
  assert.doesNotMatch(exporterCode, /\$DOWNLOAD|\$HOME\/\*\*/);
});

check('J.2 exporter sanitizes exportName as a single .h2ochat leaf', () => {
  assertIncludes(exporterCode, 'sanitizeExportName');
  assertMatches(exporterCode, /PACKAGE_SUFFIX\s*=\s*['"]\.h2ochat['"]/);
  assertMatches(exporterCode, /indexOf\(['"]\.\.['"]\)/);
  assertIncludes(exporterCode, "replace(/[\\\\\\/]+/g, '-')");
  assertIncludes(exporterCode, "/[\\/\\\\]/.test(name)");
});

check('J.2 exporter is manifest-driven and does not recursively blind-copy packages', () => {
  assertIncludes(exporterCode, 'declaredFilesFromManifest');
  assertIncludes(exporterCode, 'manifest.files');
  assertIncludes(exporterCode, 'manifest.assets');
  assertIncludes(exporterCode, 'copyDeclaredFile');
  assert.doesNotMatch(exporterCode, /plugin:fs\|read_dir|readDir|copyDir|recursiveCopy|walkFiles/);
});

check('J.2 exporter guards package-relative paths and asset paths', () => {
  assertIncludes(exporterCode, 'assertSafeRelativePackagePath');
  assertIncludes(exporterCode, 'path must be relative');
  assertIncludes(exporterCode, 'path must not traverse');
  assertIncludes(exporterCode, 'asset path must stay under assets/');
  assertIncludes(exporterCode, 'asset path sha mismatch');
});

check('M09 P0.1 folder final publication uses one bounded native atomic create-only command', () => {
  assert.ok(existsRepo(FOLDER_PUBLISH_NATIVE), `${FOLDER_PUBLISH_NATIVE} does not exist`);
  const native = readRepo(FOLDER_PUBLISH_NATIVE);
  const rootPolicy = readRepo(EXPORT_ROOT_POLICY_NATIVE);
  const tauriLib = readRepo(TAURI_LIB);
  assertIncludes(exporterCode, 'destination-exists');
  assertIncludes(exporterCode, 'fsExists(dest.destinationPath');
  assertIncludes(exporterCode, 'TMP_SUFFIX_PREFIX');
  assertIncludes(exporterCode, 'h2o_publish_saved_chat_folder_create_only');
  assertIncludes(exporterCode, 'publishFolderCreateOnly(tempName, dest.exportName)');
  assertIncludes(native, 'promote_dir_exclusive');
  assertIncludes(native, 'destination-exists');
  assertIncludes(native, 'saved_chat_export_root_policy::production_roots');
  assertIncludes(rootPolicy, 'H2O Studio Exports');
  assertIncludes(tauriLib, 'pub mod saved_chat_folder_publish;');
  assertIncludes(tauriLib, 'saved_chat_folder_publish::h2o_publish_saved_chat_folder_create_only');
  assert.equal(
    (tauriLib.match(/saved_chat_folder_publish::h2o_publish_saved_chat_folder_create_only/g) || []).length,
    2,
    'folder publication command must be registered in debug and release handlers',
  );
  const nativeProduction = native.slice(0, native.indexOf('#[cfg(test)]'));
  const folderBody = exporterCode.slice(
    exporterCode.indexOf('async function exportVerifiedPackage'),
    exporterCode.indexOf('function zipExportResult'),
  );
  assert.doesNotMatch(folderBody, /fsRename|plugin:fs\|rename/);
  assert.doesNotMatch(nativeProduction, /std::fs::rename|rename_within/);
  assert.doesNotMatch(exporterCode, /truncate:\s*true|overwrite:\s*true/);
});

check('M09 P0.1b folder staging uses bounded native exclusive creation and random retries', () => {
  const native = readRepo(FOLDER_PUBLISH_NATIVE);
  const tauriLib = readRepo(TAURI_LIB);
  assertIncludes(exporterCode, 'h2o_create_saved_chat_folder_stage');
  assertIncludes(exporterCode, 'crypto.getRandomValues');
  assertIncludes(exporterCode, 'FOLDER_STAGE_CREATE_ATTEMPTS = 8');
  assertIncludes(exporterCode, 'createOwnedFolderStage(dest.exportName)');
  assertIncludes(native, 'mkdir_child_exclusive');
  assertIncludes(native, 'stage-exists');
  assertIncludes(native, 'STAGE_TOKEN_HEX_LENGTH');
  assertIncludes(tauriLib, 'saved_chat_folder_publish::h2o_create_saved_chat_folder_stage');
  assert.equal(
    (tauriLib.match(/saved_chat_folder_publish::h2o_create_saved_chat_folder_stage/g) || []).length,
    2,
    'folder stage command must be registered in debug and release handlers',
  );
  const folderBody = exporterCode.slice(
    exporterCode.indexOf('async function exportVerifiedPackage'),
    exporterCode.indexOf('function zipExportResult'),
  );
  const folderResolver = exporterCode.slice(
    exporterCode.indexOf('function resolveExportDestination'),
    exporterCode.indexOf('function resolveZipExportDestination'),
  );
  assert.doesNotMatch(folderBody, /fsMkdir\(tempPath/);
  assert.doesNotMatch(folderResolver, /Date\.now|tempPath|tempName/);
  assertIncludes(folderBody, 'if (ownsStage && tempPath)');
});

check('M09 P0.3c ZIP bytes use FD-bound create-only publication from native-owned staging', () => {
  assert.ok(existsRepo(ZIP_PUBLISH_NATIVE), `${ZIP_PUBLISH_NATIVE} does not exist`);
  const native = readRepo(ZIP_PUBLISH_NATIVE);
  const rootPolicy = readRepo(EXPORT_ROOT_POLICY_NATIVE);
  const durableWrite = readRepo(ARCHIVE_DURABLE_WRITE_NATIVE);
  const tauriLib = readRepo(TAURI_LIB);
  assertIncludes(exporterCode, 'h2o_publish_saved_chat_zip_bytes_create_only');
  assertIncludes(exporterCode, 'publishOwnedZipBytes(');
  assertIncludes(exporterCode, 'ZIP_STAGE_CREATE_ATTEMPTS = 8');
  assertIncludes(exporterCode, 'crypto.getRandomValues');
  assertIncludes(native, 'publish_open_file_clone_exclusive');
  assertIncludes(rootPolicy, '.H2O Studio Saved Chat ZIP Staging');
  assertIncludes(native, 'create_new_child');
  assertIncludes(native, 'sync_file_contents');
  assertIncludes(native, 'hash_owned_file');
  assertIncludes(native, 'libc::fstat');
  assertIncludes(native, 'st_dev');
  assertIncludes(native, 'st_ino');
  assertIncludes(native, 'stat_child_nofollow');
  assertIncludes(native, 'required_options');
  assertIncludes(native, 'body_bytes');
  assertIncludes(native, 'destination-exists');
  assertIncludes(native, 'stage-exists');
  assertIncludes(native, 'staging-identity-mismatch');
  assertIncludes(native, 'committed');
  assertIncludes(native, 'durability_complete');
  assertIncludes(native, 'saved_chat_export_root_policy::production_roots');
  assertIncludes(rootPolicy, 'H2O Studio Exports');
  assertIncludes(durableWrite, 'publish_open_file_clone_exclusive');
  assertIncludes(durableWrite, 'libc::fclonefileat');
  assertIncludes(tauriLib, 'saved_chat_zip_publish::h2o_publish_saved_chat_zip_bytes_create_only');
  assert.equal(
    (tauriLib.match(/saved_chat_zip_publish::h2o_publish_saved_chat_zip_bytes_create_only/g) || []).length,
    2,
    'ZIP bytes transaction must be registered in debug and release handlers',
  );
  const nativeProduction = native.slice(0, native.indexOf('#[cfg(test)]'));
  const zipBody = exporterCode.slice(
    exporterCode.indexOf('async function exportVerifiedPackageZip'),
    exporterCode.indexOf('var TEXT =', exporterCode.indexOf('async function exportVerifiedPackageZip')),
  );
  const zipResolver = exporterCode.slice(
    exporterCode.indexOf('function resolveZipExportDestination'),
    exporterCode.indexOf('async function inspectVerifiedPackage'),
  );
  assert.ok(
    zipBody.indexOf('verifyPortableZipReadback(zipBytes, assembled)') < zipBody.indexOf('publishOwnedZipBytes('),
    'in-memory package/ZIP semantic proof must precede native filesystem publication',
  );
  assertIncludes(zipBody, 'expectedZipSha256 = await sha256Prefixed(zipBytes)');
  assertIncludes(zipBody, 'publication.committed !== true');
  assert.doesNotMatch(zipBody, /publication\.stagingRemoved\s*!==\s*true/);
  assert.doesNotMatch(zipBody, /fsWriteFile|fsReadFile|fsRemove|fsRename|plugin:fs\|(?:write_file|read_file|remove|rename)/);
  assert.doesNotMatch(zipResolver, /Date\.now|tempPath|tempName/);
  assert.doesNotMatch(exporterCode, /h2o_publish_saved_chat_zip_create_only/);
  assert.doesNotMatch(tauriLib, /h2o_publish_saved_chat_zip_create_only/);
  assert.doesNotMatch(nativeProduction, /std::fs::rename|rename_within|promote_exclusive\(/);
});

check('J.2 exporter verifies copied bytes, and owns no semantic identity', () => {
  /* Byte-faithfulness of the copy is TRANSPORT assurance and stays. */
  assertIncludes(exporterCode, 'verifyCopiedFiles');
  assertIncludes(exporterCode, 'sha256Prefixed');
  assertIncludes(exporterCode, 'copied file hash mismatch');
  assertIncludes(exporterCode, 'copied file byteLength mismatch');
  /* M10 P3.6c retired the exporter's private semantic contentHash authority.
     Package identity now comes from the trusted Archive Inspector for the
     source and from trusted native verification for the assembled portable
     package; the exporter recomputes neither. */
  const code = exporterCode.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const retired of ['contentHashExpected', 'canonicalJson', 'copied package contentHash mismatch']) {
    assert.ok(!code.includes(retired), `retired exporter identity authority: ${retired}`);
  }
  assertIncludes(exporterCode, 'verifySavedChatPortablePackageV1');
});

check('M02 T05 uses the sanctioned v3 renderer surface and keeps companions outside logical identity', () => {
  const owner = readRepo(PACKAGE_OWNER);
  assertIncludes(owner, 'savedChatPackageRenderers');
  assertIncludes(owner, 'renderV3ExportCompanions');
  assertIncludes(exporterCode, 'writeV3DerivedExportCompanions');
  assertIncludes(exporterSrc, 'Derived v3 companions are intentionally outside manifest.files');
  assertMatches(exporterCode, /schemaVersion\s*===\s*3\s*\?\s*2\s*:\s*0/);
});

check('J.2 exporter does not call store/scanner/materializer/importer/sync paths', () => {
  for (const token of [
    'H2O.Studio.store',
    'scanSavedChatArchiveRequestInboxV1',
    'materializeSavedChatArchiveRequestV1',
    'writeSavedChatPackageV1',
    'buildSavedChatPackageV1',
    'archiveImporter',
    'exportFullBundle',
    'exportLatestSyncBundle',
    'folder-sync',
    'WebDAV',
  ]) {
    assert.ok(!exporterCode.includes(token), `exporter must not reference ${token}`);
  }
});

check('J.2 exporter is loaded and mounted beside Archive Health', () => {
  assertIncludes(readRepo(STUDIO_HTML), './ingestion/saved-chat-archive-exporter.studio.js');
  assertIncludes(readRepo(PACK_STUDIO), 'ingestion/saved-chat-archive-exporter.studio.js');
  const health = readRepo(ARCHIVE_HEALTH_UI);
  assertIncludes(health, 'archiveExporter');
  assertIncludes(health, 'mountArchiveExporterCard');
});

check('placeholder/broad .h2ochat export/share action names remain absent', () => {
  const files = walkFiles(STUDIO_ROOT).filter((relPath) => relPath.endsWith('.js'));
  const hits = scanFilesForTokens(files, FORBIDDEN_EXPORT_RUNTIME_TOKENS);
  assert.deepEqual(hits, [], `unexpected export/share runtime tokens:\n${hits.join('\n')}`);
});

check('export-bundle.tauri.js remains full-library h2o.studio.fullBundle.v2 only', () => {
  const text = readRepo(EXPORT_BUNDLE);
  assertIncludes(text, 'h2o.studio.fullBundle.v2');
  assertIncludes(text, 'exportFullBundle');
  assertIncludes(text, 'exportLatestSyncBundle');
  assert.ok(!text.includes('.h2ochat'), 'export-bundle.tauri.js must not write .h2ochat packages');
  assert.ok(!text.includes('savedChatPackage'), 'export-bundle.tauri.js must not be treated as saved package export');
  assert.ok(!text.includes('archive/packages'), 'export-bundle.tauri.js must not target archive/packages');
});

check('Chrome/MV3 runtime has no package body export/share authority', () => {
  const chromeFiles = walkFiles(STUDIO_ROOT).filter((relPath) => (
    relPath.endsWith('.mv3.js') ||
    /service-worker|background/i.test(path.basename(relPath))
  ));
  const hits = scanFilesForTokens(chromeFiles, FORBIDDEN_CHROME_PACKAGE_BODY_TOKENS);
  assert.deepEqual(hits, [], `unexpected Chrome package-body authority tokens:\n${hits.join('\n')}`);
});

check('scanner/materializer/writer/importer behavior remains export-share unchanged', () => {
  const guardedFiles = [
    'src-surfaces-base/studio/ingestion/saved-chat-archive-request-inbox.tauri.js',
    'src-surfaces-base/studio/ingestion/saved-chat-archive-materializer.tauri.js',
    'src-surfaces-base/studio/ingestion/saved-chat-package-v1.tauri.js',
    'src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js',
  ].filter(existsRepo);
  const hits = scanFilesForTokens(guardedFiles, FORBIDDEN_EXPORT_RUNTIME_TOKENS);
  assert.deepEqual(hits, [], `unexpected export/share tokens in guarded runtime files:\n${hits.join('\n')}`);
});

check('J.2 archive-export capability is dedicated and bounded to H2O Studio Exports', () => {
  assert.ok(existsRepo(ARCHIVE_EXPORT_CAPABILITY), `${ARCHIVE_EXPORT_CAPABILITY} does not exist`);
  const raw = readRepo(ARCHIVE_EXPORT_CAPABILITY);
  const json = JSON.parse(raw);
  assert.equal(json.identifier, 'archive-export');
  for (const permission of [
    'fs:allow-mkdir',
    'fs:allow-exists',
    'fs:allow-read-dir',
    'fs:allow-write-file',
    'fs:allow-remove',
  ]) {
    assert.ok(raw.includes(permission), `${permission} missing from archive-export capability`);
  }
  assert.ok(!raw.includes('fs:allow-rename'), 'folder export no longer needs renderer rename authority');
  const scopes = collectStrings(json);
  const pathScopes = scopes.filter((scope) => scope.startsWith('$'));
  for (const scope of pathScopes) {
    assert.ok(
      scope === '$HOME/H2O Studio Exports' || scope === '$HOME/H2O Studio Exports/**',
      `unexpected archive-export scope: ${scope}`,
    );
  }
  assert.ok(!pathScopes.includes('$HOME/**'), 'archive-export must not grant broad HOME scope');
  assert.ok(!pathScopes.some((scope) => scope.includes('$DOWNLOAD')), 'archive-export must not grant Downloads scope');
  assert.ok(!pathScopes.some((scope) => scope.includes('$APPLOCALDATA/archive')), 'archive-export must not target app archive package root');
});

check('existing capabilities are not broadened for J.2 export/share', () => {
  const writeLikeScopes = [];
  for (const relPath of CAPABILITY_FILES) {
    assert.ok(existsRepo(relPath), `${relPath} does not exist`);
    const raw = readRepo(relPath);
    const json = JSON.parse(raw);
    writeLikeScopes.push(...collectWriteLikeCapabilityScopes(json).map((scope) => `${relPath}: ${scope}`));
    assert.ok(!raw.includes('H2O Studio Exports'), `${relPath} must not add export destination capability in J.2`);
  }
  const broadHomeWrites = writeLikeScopes.filter((scope) => scope.includes('$HOME/**'));
  const downloadWrites = writeLikeScopes.filter((scope) => scope.includes('$DOWNLOAD'));
  const exportRootWrites = writeLikeScopes.filter((scope) => scope.includes('H2O Studio Exports'));
  assert.deepEqual(broadHomeWrites, [], `broad HOME write-like capability found:\n${broadHomeWrites.join('\n')}`);
  assert.deepEqual(downloadWrites, [], `Downloads write-like capability found:\n${downloadWrites.join('\n')}`);
  assert.deepEqual(exportRootWrites, [], `export-root write-like capability found:\n${exportRootWrites.join('\n')}`);
});

check('J.2 remains no watcher/poller/daemon and no sync/WebDAV/cloud/native path', () => {
  for (const text of [
    'No watcher / daemon',
    'No sync / WebDAV / cloud / native messaging',
    'No `S0F0j` / `S0F1j` edits',
  ]) {
    assertIncludes(j0, text);
  }
});

check('existing recovery/import/export validator still preserves deferred export boundary', () => {
  const text = readRepo(RECOVERY_VALIDATOR);
  assertIncludes(text, 'bounded .h2ochat export runtime exists only in archiveExporter');
  assertIncludes(text, 'export-bundle are full-bundle artifacts');
  assertIncludes(text, 'restore/relink deferred');
});

check('existing import recovery harness remains present for regression validation', () => {
  const text = readRepo(IMPORT_HARNESS);
  assertIncludes(text, 'saved-chat-archive-importer');
});

check('no S0F0j/S0F1j files are staged by J.2', () => {
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim().split(/\n+/).filter(Boolean);
  const forbidden = staged.filter((relPath) => /S0F0j|S0F1j/.test(relPath));
  assert.deepEqual(forbidden, [], `S0F0j/S0F1j files staged unexpectedly:\n${forbidden.join('\n')}`);
});

checkAsync('M03 T04: behavior harness executes the real governed codec before Diagnostics', async () => {
  const runtime = loadBehaviorRuntime(createBehaviorFs());
  const codec = runtime.H2O?.Studio?.ingestion?.savedChatPackageCodec;
  assert.ok(codec && codec.__installed === true, 'governed codec must be installed in the behavior sandbox');
  assert.equal(typeof codec.readBoundedPackageMemberBytes, 'function');
  assert.equal(typeof codec.verifyPackageMemberBytes, 'function');
  /* Diagnostics loads after the codec and therefore resolves it rather than
   * failing closed with snapshot-codec-unavailable. M10 P4 retired the legacy
   * verifier, so the surviving facade is what proves the module loaded. */
  assert.equal(typeof runtime.H2O?.Studio?.ingestion?.diagnoseSavedChatArchiveV1, 'function');
  /* The harness must never substitute its own compression path for the codec. */
  assert.doesNotMatch(readRepo(DIAGNOSTICS), /DecompressionStream|CompressionStream/);
});

checkAsync('M09 P3.2 renderer export-root policy accepts only exact governed wire values', async () => {
  const runtime = loadBehaviorRuntime(createBehaviorFs());
  const exporter = runtime.H2O.Studio.archiveExporter;
  const policy = await exporter.readSavedChatExportRootPolicy();
  assert.equal(policy.schema, 'h2o.studio.saved-chat-export-root-policy.v1');
  assert.equal(policy.baseDirectory, 'home');
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(exporter._private.validateExportRootPolicyWire, undefined);

  for (const invalid of [
    null,
    {},
    { schema: 'wrong', baseDirectory: 'home' },
    { schema: 'h2o.studio.saved-chat-export-root-policy.v1' },
    { schema: 'h2o.studio.saved-chat-export-root-policy.v1', baseDirectory: 'unknown' },
    { schema: 'h2o.studio.saved-chat-export-root-policy.v1', baseDirectory: 'home', path: '/tmp' },
  ]) {
    const invalidRuntime = loadBehaviorRuntime(createBehaviorFs({ exportPolicyWire: invalid }));
    await assert.rejects(
      invalidRuntime.H2O.Studio.archiveExporter.readSavedChatExportRootPolicy()
    );
  }
});

checkAsync('M09 P3.2 AppLocalData policy binds renderer staging and native folder publication to one disposable root', async () => {
  const mem = createBehaviorFs({ exportBaseDir: 15 });
  const pkg = readCommittedV3Fixture();
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const runtime = loadBehaviorRuntime(mem);
  const exporter = runtime.H2O.Studio.archiveExporter;

  const policy = await exporter.readSavedChatExportRootPolicy();
  assert.equal(policy.baseDirectory, 'appLocalData');
  const result = await exporter.exportVerifiedPackage({
    packagePath: sourceRoot,
    exportName: 'p3-2-app-local.h2ochat',
  });
  assert.equal(result.status, 'exported');
  assert.ok(mem.inventory(mem.APP, 'H2O Studio Exports/p3-2-app-local.h2ochat').length > 0);
  assert.deepEqual(mem.inventory(mem.HOME, 'H2O Studio Exports'), []);
  assert.equal(mem.folderPublishCallCount(), 1);
});

checkAsync('M09 P3.2 malformed or unavailable export-root policy fails closed before export mutation', async () => {
  for (const options of [
    { exportPolicyWire: { schema: 'wrong', baseDirectory: 'home' } },
    { exportPolicyError: 'policy command unavailable' },
  ]) {
    const mem = createBehaviorFs(options);
    const pkg = readCommittedV3Fixture();
    const sourceRoot = installBehaviorPackage(mem, pkg);
    const runtime = loadBehaviorRuntime(mem);
    const result = await runtime.H2O.Studio.archiveExporter.exportVerifiedPackage({
      packagePath: sourceRoot,
      exportName: 'must-not-write.h2ochat',
    });
    assert.equal(result.status, 'write-error');
    assert.deepEqual(mem.inventory(mem.HOME, 'H2O Studio Exports'), []);
    assert.deepEqual(mem.inventory(mem.APP, 'H2O Studio Exports'), []);
    assert.equal(mem.folderPublishCallCount(), 0);
  }
});

checkAsync('M02 T05 v3 export regenerates deterministic renderers without mutating source identity', async () => {
  const mem = createBehaviorFs();
  const pkg = readCommittedV3Fixture();
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const runtime = loadBehaviorRuntime(mem);
  const ingestion = runtime.H2O.Studio.ingestion;
  const exporter = runtime.H2O.Studio.archiveExporter;

  const before = mem.inventory(mem.APP, sourceRoot);
  assert.ok(!mem.exists(mem.APP, `${sourceRoot}/chat.md`));
  assert.ok(!mem.exists(mem.APP, `${sourceRoot}/chat.html`));
  /* Pre-condition probe through the TRUSTED Inspector; M10 P4 removed the
     legacy JS verifier this used to ask. */
  const inspected = await runtime.H2O.Studio.archiveInspector.inspectPackage({ packagePath: sourceRoot });
  assert.equal(inspected.status, 'verified');
  assert.equal(inspected.identity.contentHashVerified, true);

  const first = await exporter.exportVerifiedPackage({ packagePath: sourceRoot, exportName: 't05-v3-first.h2ochat' });
  const second = await exporter.exportVerifiedPackage({ packagePath: sourceRoot, exportName: 't05-v3-second.h2ochat' });
  assert.equal(first.status, 'exported');
  assert.equal(second.status, 'exported');
  assert.equal(first.contentHash, pkg.manifest.contentHash);
  assert.equal(first.fileCount, 5, 'manifest + snapshot + asset + two derived companions');

  const firstRoot = 'H2O Studio Exports/t05-v3-first.h2ochat';
  const secondRoot = 'H2O Studio Exports/t05-v3-second.h2ochat';
  const firstMd = mem.files.get(mem.key(mem.HOME, `${firstRoot}/chat.md`));
  const firstHtml = mem.files.get(mem.key(mem.HOME, `${firstRoot}/chat.html`));
  const secondMd = mem.files.get(mem.key(mem.HOME, `${secondRoot}/chat.md`));
  const secondHtml = mem.files.get(mem.key(mem.HOME, `${secondRoot}/chat.html`));
  assert.ok(firstMd && firstHtml && secondMd && secondHtml);
  assert.deepEqual(firstMd, secondMd);
  assert.deepEqual(firstHtml, secondHtml);

  const markdown = firstMd.toString('utf8');
  const html = firstHtml.toString('utf8');
  assert.ok(markdown.indexOf('First synthetic fixture turn.') < markdown.indexOf('Second synthetic fixture turn.'));
  assert.ok(html.indexOf('First synthetic fixture turn.') < html.indexOf('Second <strong>synthetic</strong> fixture turn.'));
  assert.ok(html.includes(pkg.assetPath), 'derived HTML keeps governed package-relative asset reference');
  assert.deepEqual(
    mem.files.get(mem.key(mem.HOME, `${firstRoot}/${pkg.assetPath}`)),
    pkg.assetBytes,
    'governed asset body copied byte-identically',
  );

  assert.deepEqual(mem.inventory(mem.APP, sourceRoot), before, 'source inventory and hashes unchanged');
  assert.ok(!mem.exists(mem.APP, `${sourceRoot}/chat.md`));
  assert.ok(!mem.exists(mem.APP, `${sourceRoot}/chat.html`));
  assert.deepEqual(mem.files.get(mem.key(mem.APP, `${sourceRoot}/manifest.json`)), Buffer.from(pkg.manifestText));
  assert.deepEqual(mem.files.get(mem.key(mem.HOME, `${firstRoot}/manifest.json`)), Buffer.from(pkg.manifestText));
  const exportedManifest = JSON.parse(mem.files.get(mem.key(mem.HOME, `${firstRoot}/manifest.json`)).toString('utf8'));
  assert.equal(exportedManifest.contentHash, pkg.manifest.contentHash);
  assert.equal(exportedManifest.files.snapshot.sha256, pkg.manifest.files.snapshot.sha256);
  assert.equal(exportedManifest.files.markdown, undefined);
  assert.equal(exportedManifest.files.html, undefined);
  assert.deepEqual(
    mem.inventory(mem.HOME, firstRoot).map((item) => item.path.slice(firstRoot.length + 1)).sort(),
    before.map((item) => item.path.slice(sourceRoot.length + 1)).concat(['chat.md', 'chat.html']).sort(),
    'v3 folder export inventory must be exactly source members plus governed companions',
  );

  const htmlOnly = JSON.parse(JSON.stringify(pkg.snapshot));
  htmlOnly.messages = [{ id: 'html-only', role: 'assistant', turnIndex: 0, content: [{ type: 'html', html: '<p>Only <strong>governed HTML</strong></p>', sanitized: true }] }];
  const htmlOnlyRendered = ingestion.savedChatPackageRenderers.renderV3ExportCompanions(htmlOnly);
  assert.ok(htmlOnlyRendered.markdownText.includes('Only governed HTML'), 'Markdown uses governed HTML-to-text fallback when no typed text exists');
  const textOnly = JSON.parse(JSON.stringify(pkg.snapshot));
  textOnly.messages = [{ id: 'text-only', role: 'user', turnIndex: 0, content: [{ type: 'text', text: '<unsafe text>' }] }];
  const textOnlyRendered = ingestion.savedChatPackageRenderers.renderV3ExportCompanions(textOnly);
  assert.ok(textOnlyRendered.htmlText.includes('&lt;unsafe text&gt;'), 'HTML text fallback is escaped');
});

checkAsync('M02 T05 preserves v1/v2 byte-copy and collision behavior', async () => {
  const mem = createBehaviorFs();
  const v1 = makeBehaviorPackage({ schemaVersion: 1, chatId: 't05_v1' });
  const v2 = makeBehaviorPackage({ schemaVersion: 2, chatId: 't05_v2', withAsset: true });
  const v1Root = installBehaviorPackage(mem, v1);
  const v2Root = installBehaviorPackage(mem, v2);
  const runtime = loadBehaviorRuntime(mem);
  const exporter = runtime.H2O.Studio.archiveExporter;
  const one = await exporter.exportVerifiedPackage({ packagePath: v1Root, exportName: 'legacy-v1.h2ochat' });
  const two = await exporter.exportVerifiedPackage({ packagePath: v2Root, exportName: 'legacy-v2.h2ochat' });
  assert.equal(one.status, 'exported');
  assert.equal(two.status, 'exported');

  for (const leaf of ['manifest.json', 'snapshot.json', 'chat.md', 'chat.html']) {
    assert.deepEqual(
      mem.files.get(mem.key(mem.HOME, `H2O Studio Exports/legacy-v1.h2ochat/${leaf}`)),
      mem.files.get(mem.key(mem.APP, `${v1Root}/${leaf}`)),
      `v1 ${leaf} copied byte-identically`,
    );
    assert.deepEqual(
      mem.files.get(mem.key(mem.HOME, `H2O Studio Exports/legacy-v2.h2ochat/${leaf}`)),
      mem.files.get(mem.key(mem.APP, `${v2Root}/${leaf}`)),
      `v2 ${leaf} copied byte-identically`,
    );
  }
  assert.deepEqual(
    mem.files.get(mem.key(mem.HOME, `H2O Studio Exports/legacy-v2.h2ochat/${v2.assetPath}`)),
    v2.assetBytes,
  );

  const exportedBeforeCollision = mem.inventory(mem.HOME, 'H2O Studio Exports/legacy-v1.h2ochat');
  const collision = await exporter.exportVerifiedPackage({ packagePath: v1Root, exportName: 'legacy-v1.h2ochat' });
  assert.equal(collision.status, 'destination-exists');
  assert.deepEqual(mem.inventory(mem.HOME, 'H2O Studio Exports/legacy-v1.h2ochat'), exportedBeforeCollision);
});

checkAsync('M09 P0.1b staging collision is never adopted, cleaned or published', async () => {
  const mem = createBehaviorFs();
  const pkg = makeBehaviorPackage({ schemaVersion: 2, chatId: 'm09_stage_ownership', withAsset: true });
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const finalName = 'example.h2ochat';
  const firstToken = '11'.repeat(16);
  const secondToken = '22'.repeat(16);
  const firstStageName = `${finalName}.tmp-${firstToken}`;
  const secondStageName = `${finalName}.tmp-${secondToken}`;
  const firstStagePath = `H2O Studio Exports/${firstStageName}`;
  const secondStagePath = `H2O Studio Exports/${secondStageName}`;
  const finalPath = `H2O Studio Exports/${finalName}`;
  const foreignBytes = Buffer.from('foreign-owner-bytes');
  mem.mkdir(mem.HOME, firstStagePath);
  mem.put(mem.HOME, `${firstStagePath}/foreign.txt`, foreignBytes);

  const tokenBytes = [Buffer.from(firstToken, 'hex'), Buffer.from(secondToken, 'hex')];
  const deterministicCrypto = {
    subtle: nodeCrypto.webcrypto.subtle,
    getRandomValues(target) {
      const bytes = tokenBytes.shift();
      assert.ok(bytes, 'exporter requested more staging tokens than expected');
      target.set(bytes);
      return target;
    },
  };
  const exporter = loadBehaviorRuntime(mem, undefined, deterministicCrypto).H2O.Studio.archiveExporter;

  const result = await exporter.exportVerifiedPackage({ packagePath: sourceRoot, exportName: finalName });

  assert.equal(result.status, 'exported', result.reason);
  assert.deepEqual(mem.folderStageCreateNames(), [firstStageName, secondStageName]);
  assert.equal(mem.exists(mem.HOME, firstStagePath), true, 'foreign stage was removed');
  assert.deepEqual(
    mem.files.get(mem.key(mem.HOME, `${firstStagePath}/foreign.txt`)),
    foreignBytes,
    'foreign staging bytes changed',
  );
  assert.deepEqual(
    mem.inventory(mem.HOME, firstStagePath).map((item) => item.path.slice(firstStagePath.length + 1)),
    ['foreign.txt'],
    'exporter wrote into the colliding stage',
  );
  assert.equal(mem.exists(mem.HOME, secondStagePath), false, 'owned stage was not consumed by publication');
  const expectedInventory = mem.inventory(mem.APP, sourceRoot)
    .map((item) => item.path.slice(sourceRoot.length + 1))
    .sort();
  const finalInventory = mem.inventory(mem.HOME, finalPath)
    .map((item) => item.path.slice(finalPath.length + 1))
    .sort();
  assert.deepEqual(finalInventory, expectedInventory, 'final v2 inventory contains foreign or missing members');
  assert.ok(!finalInventory.includes('foreign.txt'));
});

checkAsync('M09 P0.1 folder publication refuses a race winner after advisory absence and cleans staging', async () => {
  const mem = createBehaviorFs();
  const pkg = makeBehaviorPackage({ schemaVersion: 2, chatId: 'm09_folder_publish_race', withAsset: false });
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const runtime = loadBehaviorRuntime(mem);
  const exporter = runtime.H2O.Studio.archiveExporter;
  const finalPath = 'H2O Studio Exports/m09-race.h2ochat';
  const winnerPath = `${finalPath}/payload`;
  const sentinel = Buffer.from('independent-race-winner');

  assert.equal(mem.exists(mem.HOME, finalPath), false, 'advisory pre-check begins absent');
  mem.setBeforeFolderPublish(({ finalPath: publishingFinal }) => {
    assert.equal(publishingFinal, finalPath);
    mem.mkdir(mem.HOME, publishingFinal);
    mem.put(mem.HOME, `${publishingFinal}/payload`, sentinel);
  });

  const result = await exporter.exportVerifiedPackage({
    packagePath: sourceRoot,
    exportName: 'm09-race.h2ochat',
  });

  assert.equal(mem.folderPublishCallCount(), 1, 'native create-only boundary invoked once');
  assert.equal(result.status, 'destination-exists');
  assert.equal(result.ok, false, 'collision must not be reported successful');
  assert.deepEqual(mem.files.get(mem.key(mem.HOME, winnerPath)), sentinel, 'race winner bytes changed');
  assert.equal(
    [...mem.dirs].some((entry) => entry.includes('m09-race.h2ochat.tmp-')),
    false,
    'private staging folder was not cleaned',
  );
  assert.equal(
    [...mem.files.keys()].some((entry) => entry.includes('m09-race.h2ochat.tmp-')),
    false,
    'private staging members were not cleaned',
  );
});

checkAsync('M03 T04 exports a valid gzip-v3 package, preserving the durable member byte-identically', async () => {
  const mem = createBehaviorFs();
  const pkg = gzipCommittedV3Fixture();
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const runtime = loadBehaviorRuntime(mem);
  const sourceBefore = mem.inventory(mem.APP, sourceRoot);

  /* Pre-condition probe through the TRUSTED envelope; M10 P4 removed the
     legacy JS verifier this used to ask. */
  const envelope = await runtime.H2O.Studio.ingestion.readSavedChatArchiveIntegrityV1();
  const occupant = envelope.occupants.find((o) => o.path === sourceRoot);
  assert.equal(occupant.class, 'legacy-package', JSON.stringify(occupant));
  assert.equal(occupant.snapshotEncoding, 'gzip');

  const result = await runtime.H2O.Studio.archiveExporter.exportVerifiedPackage({ packagePath: sourceRoot, exportName: 't04-v3-gzip.h2ochat' });
  assert.equal(result.status, 'exported', result.reason);
  assert.equal(result.contentHash, pkg.manifest.contentHash, 'logical contentHash is encoding-independent');
  assert.equal(result.fileCount, 5, 'manifest + snapshot + asset + two derived companions');

  const outRoot = 'H2O Studio Exports/t04-v3-gzip.h2ochat';
  const out = Object.fromEntries(mem.inventory(mem.HOME, outRoot).map((f) => [f.path, f]));
  /* The durable snapshot member is preserved byte-identically: no decode, no
   * recompression, no gzip-header normalisation. Its stored SHA still equals the
   * gzip physical descriptor, and its length is the gzip length, not the logical one. */
  assert.equal(out[`${outRoot}/snapshot.json`].sha256, pkg.manifest.files.snapshot.sha256);
  assert.equal(out[`${outRoot}/snapshot.json`].byteLength, pkg.snapshotBytes.length);
  assert.equal(out[`${outRoot}/snapshot.json`].sha256, sha256(pkg.snapshotBytes));
  assert.notEqual(out[`${outRoot}/snapshot.json`].byteLength, pkg.manifest.files.snapshot.contentByteLength);
  /* manifest stays plaintext and byte-identical; the asset is untouched. */
  assert.equal(out[`${outRoot}/manifest.json`].sha256, sha256(pkg.manifestText));
  assert.equal(out[`${outRoot}/${pkg.assetPath}`].sha256, pkg.assetSha);
  /* Human-readable companions were regenerated from verified logical content. */
  assert.ok(mem.exists(mem.HOME, `${outRoot}/chat.md`));
  assert.ok(mem.exists(mem.HOME, `${outRoot}/chat.html`));
  /* Source archive package is unchanged by export. */
  assert.deepEqual(mem.inventory(mem.APP, sourceRoot), sourceBefore);
  /* Exporter still owns no compression implementation of its own. */
  assert.doesNotMatch(readRepo(EXPORTER), /CompressionStream|DecompressionStream|gunzip|inflate|zlib/);
});

checkAsync('M03 T04 gzip-v3 and identity-v3 produce identical human-readable companions', async () => {
  /* Separate fixture filesystems so both variants can carry the SAME chatId and
   * therefore byte-identical logical content. */
  const idMem = createBehaviorFs();
  const gzMem = createBehaviorFs();
  const idPkg = readCommittedV3Fixture();
  const gzPkg = gzipCommittedV3Fixture();
  const idRoot = installBehaviorPackage(idMem, idPkg);
  const gzRoot = installBehaviorPackage(gzMem, gzPkg);

  const idOut = await loadBehaviorRuntime(idMem).H2O.Studio.archiveExporter.exportVerifiedPackage({ packagePath: idRoot, exportName: 'eq-identity.h2ochat' });
  const gzOut = await loadBehaviorRuntime(gzMem).H2O.Studio.archiveExporter.exportVerifiedPackage({ packagePath: gzRoot, exportName: 'eq-gzip.h2ochat' });
  assert.equal(idOut.status, 'exported');
  assert.equal(gzOut.status, 'exported');
  assert.equal(idOut.contentHash, gzOut.contentHash, 'logical identity must not depend on encoding');

  const idInv = Object.fromEntries(idMem.inventory(idMem.HOME, 'H2O Studio Exports/eq-identity.h2ochat').map((f) => [f.path.split('/').pop(), f]));
  const gzInv = Object.fromEntries(gzMem.inventory(gzMem.HOME, 'H2O Studio Exports/eq-gzip.h2ochat').map((f) => [f.path.split('/').pop(), f]));
  assert.equal(gzInv['chat.md'].sha256, idInv['chat.md'].sha256, 'chat.md must be byte-identical across encodings');
  assert.equal(gzInv['chat.html'].sha256, idInv['chat.html'].sha256, 'chat.html must be byte-identical across encodings');
  assert.equal(gzInv['chat.md'].byteLength, idInv['chat.md'].byteLength);
  assert.equal(gzInv['chat.html'].byteLength, idInv['chat.html'].byteLength);
  /* The durable snapshot members legitimately differ physically. */
  assert.notEqual(gzInv['snapshot.json'].sha256, idInv['snapshot.json'].sha256);
  /* Physical durable members legitimately differ. */
  assert.notEqual(gzPkg.manifest.files.snapshot.sha256, idPkg.manifest.files.snapshot.sha256);
});

checkAsync('M03 T04 corrupt gzip-v3 fails closed and creates no export', async () => {
  const mem = createBehaviorFs();
  const pkg = gzipCommittedV3Fixture({ corrupt: true });
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const runtime = loadBehaviorRuntime(mem);
  const sourceBefore = mem.inventory(mem.APP, sourceRoot);
  const result = await runtime.H2O.Studio.archiveExporter.exportVerifiedPackage({ packagePath: sourceRoot, exportName: 'must-not-export.h2ochat' });
  assert.equal(result.ok, false, 'corrupt gzip must not export');
  assert.notEqual(result.status, 'exported');
  /* No completed export and no staged leftovers were published. */
  assert.equal(mem.exists(mem.HOME, 'H2O Studio Exports/must-not-export.h2ochat'), false);
  assert.deepEqual(mem.inventory(mem.HOME, 'H2O Studio Exports'), []);
  /* Source archive package remains untouched. */
  assert.deepEqual(mem.inventory(mem.APP, sourceRoot), sourceBefore);
});

checkAsync('M08 method-8 codec emits deterministic canonical ZIP records and round-trips bytes', async () => {
  const runtime = loadBehaviorRuntime(createBehaviorFs());
  const portable = runtime.H2O.Studio.ingestion.savedChatPortableZip;
  const entries = [
    { name: 'probe.h2ochat/chat.html', bytes: Buffer.from('<p>portable</p>') },
    { name: 'probe.h2ochat/manifest.json', bytes: Buffer.from('{"probe":true}') },
    { name: 'probe.h2ochat/snapshot.json', bytes: Buffer.from('portable snapshot '.repeat(512)) },
    { name: 'probe.h2ochat/chat.md', bytes: Buffer.from('# Portable\n') },
  ];
  const first = await portable.buildPortableZip(entries, { method: portable.METHOD_DEFLATE });
  const second = await portable.buildPortableZip(entries.slice().reverse(), { method: portable.METHOD_DEFLATE });
  assert.deepEqual(Buffer.from(first), Buffer.from(second), 'canonical order + fixed metadata must be deterministic in one runtime');
  const decoded = await portable.readPortableZip(first);
  assert.deepEqual(Array.from(decoded.entries, (entry) => entry.name), [
    'probe.h2ochat/manifest.json',
    'probe.h2ochat/snapshot.json',
    'probe.h2ochat/chat.md',
    'probe.h2ochat/chat.html',
  ]);
  assert.ok(decoded.entries.every((entry) => entry.method === 8));
  const expected = Object.fromEntries(entries.map((entry) => [entry.name, Buffer.from(entry.bytes)]));
  for (const entry of decoded.entries) assert.deepEqual(Buffer.from(entry.bytes), expected[entry.name]);

  const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
  const eocd = first.byteLength - 22;
  const centralOffset = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(8, true), 8, 'local method');
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
  assert.equal(view.getUint16(centralOffset + 10, true), 8, 'central method');
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint32(eocd + 16, true), centralOffset);

  const firstNameLength = view.getUint16(26, true);
  const compressedSize = view.getUint32(18, true);
  const compressed = Buffer.from(first.slice(30 + firstNameLength, 30 + firstNameLength + compressedSize));
  assert.deepEqual(zlib.inflateRawSync(compressed), expected['probe.h2ochat/manifest.json']);
});

checkAsync('M08 verified v1/v2 ZIP export is method-8, byte-faithful, deterministic and no-overwrite', async () => {
  const mem = createBehaviorFs();
  const pkg = makeBehaviorPackage({ schemaVersion: 2, chatId: 'm08_zip_export', withAsset: true });
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const sourceBefore = mem.inventory(mem.APP, sourceRoot);
  const runtime = loadBehaviorRuntime(mem);
  const exporter = runtime.H2O.Studio.archiveExporter;
  const portable = runtime.H2O.Studio.ingestion.savedChatPortableZip;

  const one = await exporter.exportVerifiedPackageZip({ packagePath: sourceRoot, exportName: 'm08-one.h2ochat.zip' });
  const two = await exporter.exportVerifiedPackageZip({ packagePath: sourceRoot, exportName: 'm08-two.h2ochat.zip' });
  assert.equal(one.status, 'exported', one.reason);
  assert.equal(two.status, 'exported', two.reason);
  assert.equal(one.contentHash, pkg.manifest.contentHash);
  assert.equal(one.entryCount, 5);
  const oneBytes = mem.files.get(mem.key(mem.HOME, 'H2O Studio Exports/m08-one.h2ochat.zip'));
  const twoBytes = mem.files.get(mem.key(mem.HOME, 'H2O Studio Exports/m08-two.h2ochat.zip'));
  const publicationOptions = mem.zipPublishOptions();
  assert.equal(publicationOptions.length, 2, 'each successful ZIP used one native bytes transaction');
  assert.equal(publicationOptions[0].expectedByteLength, oneBytes.length);
  assert.equal(publicationOptions[0].expectedSha256, sha256(oneBytes));
  assert.equal(publicationOptions[1].expectedByteLength, twoBytes.length);
  assert.equal(publicationOptions[1].expectedSha256, sha256(twoBytes));
  assert.deepEqual(oneBytes, twoBytes, 'destination leaf must not participate in ZIP bytes');
  const decoded = await portable.readPortablePackageZip(oneBytes);
  assert.equal(decoded.packageDirName, 'm08_zip_export.h2ochat');
  const sourceByLeaf = Object.fromEntries(sourceBefore.map((item) => [item.path.slice(sourceRoot.length + 1), item]));
  for (const entry of decoded.entries) {
    assert.ok(sourceByLeaf[entry.name], `unexpected ZIP entry ${entry.name}`);
    assert.equal(sha256(entry.bytes), sourceByLeaf[entry.name].sha256, `${entry.name} changed in ZIP`);
    assert.equal(entry.bytes.byteLength, sourceByLeaf[entry.name].byteLength);
  }
  assert.deepEqual(mem.inventory(mem.APP, sourceRoot), sourceBefore, 'source package changed during ZIP export');
  const beforeCollision = Buffer.from(oneBytes);
  const collision = await exporter.exportVerifiedPackageZip({ packagePath: sourceRoot, exportName: 'm08-one.h2ochat.zip' });
  assert.equal(collision.status, 'destination-exists');
  assert.deepEqual(mem.files.get(mem.key(mem.HOME, 'H2O Studio Exports/m08-one.h2ochat.zip')), beforeCollision);
});

checkAsync('M09 P0.3c ZIP staging collision preserves the foreign stage and retries with fresh ownership', async () => {
  const mem = createBehaviorFs();
  const pkg = makeBehaviorPackage({ schemaVersion: 2, chatId: 'm09_zip_stage_ownership', withAsset: true });
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const finalName = 'm09-stage.h2ochat.zip';
  const firstToken = '33'.repeat(16);
  const secondToken = '44'.repeat(16);
  const firstStageName = `${finalName}.tmp-${firstToken}`;
  const secondStageName = `${finalName}.tmp-${secondToken}`;
  const firstStagePath = `${ZIP_NATIVE_STAGE_ROOT}/${firstStageName}`;
  const secondStagePath = `${ZIP_NATIVE_STAGE_ROOT}/${secondStageName}`;
  const finalPath = `H2O Studio Exports/${finalName}`;
  const foreignBytes = Buffer.from('foreign-zip-stage-owner-bytes');
  mem.put(mem.HOME, firstStagePath, foreignBytes);

  const tokenBytes = [Buffer.from(firstToken, 'hex'), Buffer.from(secondToken, 'hex')];
  const deterministicCrypto = {
    subtle: nodeCrypto.webcrypto.subtle,
    getRandomValues(target) {
      const bytes = tokenBytes.shift();
      assert.ok(bytes, 'exporter requested more ZIP staging tokens than expected');
      target.set(bytes);
      return target;
    },
  };
  const exporter = loadBehaviorRuntime(mem, undefined, deterministicCrypto).H2O.Studio.archiveExporter;
  const result = await exporter.exportVerifiedPackageZip({ packagePath: sourceRoot, exportName: finalName });

  assert.equal(result.status, 'exported', result.reason);
  assert.equal(mem.zipPublishCallCount(), 2, 'stage collision was not retried exactly once');
  assert.deepEqual(mem.zipStageNames(), [firstStageName, secondStageName]);
  assert.deepEqual(mem.files.get(mem.key(mem.HOME, firstStagePath)), foreignBytes, 'foreign stage bytes changed');
  assert.equal(mem.exists(mem.HOME, firstStagePath), true, 'foreign stage was removed');
  assert.equal(mem.exists(mem.HOME, secondStagePath), false, 'owned retry stage was not consumed');
  const finalBytes = mem.files.get(mem.key(mem.HOME, finalPath));
  assert.ok(finalBytes, 'fresh owned stage was not published');
  assert.equal(sha256(finalBytes), mem.zipPublishOptions()[1].expectedSha256);
  assert.equal(finalBytes.length, mem.zipPublishOptions()[1].expectedByteLength);
});

checkAsync('M08 ZIP publication refuses a race winner after advisory absence and cleans staging', async () => {
  const mem = createBehaviorFs();
  const pkg = makeBehaviorPackage({ schemaVersion: 2, chatId: 'm08_zip_publish_race', withAsset: false });
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const runtime = loadBehaviorRuntime(mem);
  const exporter = runtime.H2O.Studio.archiveExporter;
  const finalPath = 'H2O Studio Exports/m08-race.h2ochat.zip';
  const sentinel = Buffer.from('independent-race-winner');

  assert.equal(mem.exists(mem.HOME, finalPath), false, 'advisory pre-check begins absent');
  mem.setBeforeZipPublish(({ finalPath: publishingFinal }) => {
    assert.equal(publishingFinal, finalPath);
    mem.put(mem.HOME, publishingFinal, sentinel);
  });

  const result = await exporter.exportVerifiedPackageZip({
    packagePath: sourceRoot,
    exportName: 'm08-race.h2ochat.zip',
  });

  assert.equal(mem.zipPublishCallCount(), 1, 'native create-only boundary invoked once');
  assert.equal(result.status, 'destination-exists');
  assert.equal(result.ok, false);
  assert.deepEqual(mem.files.get(mem.key(mem.HOME, finalPath)), sentinel, 'race winner bytes changed');
  assert.equal(
    [...mem.files.keys()].some((entry) => entry.includes('m08-race.h2ochat.zip.tmp-')),
    false,
    'private staging artifact was not cleaned',
  );
});

checkAsync('M09 P0.3c ZIP post-check pathname substitution cannot redirect FD-bound publication', async () => {
  const mem = createBehaviorFs();
  const pkg = makeBehaviorPackage({ schemaVersion: 2, chatId: 'm09_zip_identity_binding', withAsset: false });
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const finalPath = 'H2O Studio Exports/m09-substitution.h2ochat.zip';
  const substitutedBytes = Buffer.from('foreign-substituted-stage-bytes');
  let substitutedStagePath = '';
  mem.setBeforeZipPublish(({ stagedPath }) => {
    substitutedStagePath = stagedPath;
    mem.put(mem.HOME, stagedPath, substitutedBytes);
  });
  const exporter = loadBehaviorRuntime(mem).H2O.Studio.archiveExporter;
  const result = await exporter.exportVerifiedPackageZip({
    packagePath: sourceRoot,
    exportName: 'm09-substitution.h2ochat.zip',
  });

  assert.equal(result.status, 'exported');
  assert.equal(result.ok, true);
  const finalBytes = mem.files.get(mem.key(mem.HOME, finalPath));
  assert.ok(finalBytes, 'verified owned bytes were not published');
  assert.notDeepEqual(finalBytes, substitutedBytes, 'substituted pathname bytes reached final');
  assert.equal(sha256(finalBytes), mem.zipPublishOptions()[0].expectedSha256);
  assert.equal(finalBytes.length, mem.zipPublishOptions()[0].expectedByteLength);
  assert.deepEqual(
    mem.files.get(mem.key(mem.HOME, substitutedStagePath)),
    substitutedBytes,
    'foreign substituted pathname was cleaned or modified',
  );
});

checkAsync('M09 P0.3c ZIP staged hash and length mismatches both fail closed', async () => {
  for (const fault of ['hash', 'length']) {
    const mem = createBehaviorFs();
    const pkg = makeBehaviorPackage({ schemaVersion: 2, chatId: `m09_zip_${fault}_binding`, withAsset: false });
    const sourceRoot = installBehaviorPackage(mem, pkg);
    const finalName = `m09-${fault}.h2ochat.zip`;
    const finalPath = `H2O Studio Exports/${finalName}`;
    mem.setZipIdentityFault(fault);
    const exporter = loadBehaviorRuntime(mem).H2O.Studio.archiveExporter;
    const result = await exporter.exportVerifiedPackageZip({ packagePath: sourceRoot, exportName: finalName });

    assert.equal(result.status, 'write-error', `${fault} mismatch reported success`);
    assert.match(result.reason, new RegExp(`staged-${fault}-mismatch`));
    assert.equal(mem.exists(mem.HOME, finalPath), false, `${fault} mismatch created a final ZIP`);
    assert.equal(
      [...mem.files.keys()].some((entry) => entry.includes(`${finalName}.tmp-`)),
      false,
      `${fault} mismatch left an owned staging file`,
    );
  }
});

checkAsync('M08 portable ZIP reaches the shared import-as-new core; failures and dry-run write nothing', async () => {
  const mem = createBehaviorFs();
  const pkg = makeBehaviorPackage({ schemaVersion: 2, chatId: 'm08_zip_import', withAsset: true });
  const sourceRoot = installBehaviorPackage(mem, pkg);
  const chats = new Map();
  const snapshots = new Map();
  const writes = { chats: 0, snapshots: 0 };
  const store = {
    chats: {
      get: async (id) => chats.get(id) || null,
      upsert: async (patch) => { writes.chats += 1; chats.set(patch.chatId, JSON.parse(JSON.stringify(patch))); return patch; },
    },
    snapshots: {
      get: async (id) => snapshots.has(id) ? { snapshot: snapshots.get(id) } : null,
      listByChat: async (chatId) => [...snapshots.values()].filter((row) => row.chatId === chatId),
      create: async (patch) => {
        writes.snapshots += 1;
        const row = { ...JSON.parse(JSON.stringify(patch)), snapshotId: `m08-created-${writes.snapshots}` };
        snapshots.set(row.snapshotId, row);
        return { snapshot: row };
      },
    },
    assets: { listBySnapshot: async () => [] },
  };
  const runtime = loadBehaviorRuntime(mem, store);
  const exported = await runtime.H2O.Studio.archiveExporter.exportVerifiedPackageZip({
    packagePath: sourceRoot,
    exportName: 'm08-roundtrip.h2ochat.zip',
  });
  assert.equal(exported.status, 'exported', exported.reason);
  const zipBytes = mem.files.get(mem.key(mem.HOME, 'H2O Studio Exports/m08-roundtrip.h2ochat.zip'));
  const zipBefore = Buffer.from(zipBytes);
  const importer = runtime.H2O.Studio.archiveImporter;

  const dry = await importer.dryRunImportZip({ zipBytes, sourceName: 'm08-roundtrip.h2ochat.zip' });
  assert.equal(dry.decision, 'import-ready', dry.reason);
  assert.deepEqual(writes, { chats: 0, snapshots: 0 }, 'ZIP dry-run mutated the store');
  const decodedForStored = await runtime.H2O.Studio.ingestion.savedChatPortableZip.readPortablePackageZip(zipBytes);
  const storedZip = await runtime.H2O.Studio.ingestion.savedChatPortableZip.buildPortableZip(
    decodedForStored.entries.map((entry) => ({ name: `${decodedForStored.packageDirName}/${entry.name}`, bytes: entry.bytes })),
    { method: runtime.H2O.Studio.ingestion.savedChatPortableZip.METHOD_STORED },
  );
  const storedDry = await importer.dryRunImportZip({ zipBytes: storedZip, sourceName: 'm08-stored.h2ochat.zip' });
  assert.equal(storedDry.decision, 'import-ready', storedDry.reason);
  assert.deepEqual(writes, { chats: 0, snapshots: 0 }, 'method-0 compatibility dry-run mutated the store');
  const imported = await importer.importVerifiedZip({ zipBytes, sourceName: 'm08-roundtrip.h2ochat.zip', mode: 'import-as-new' });
  assert.equal(imported.status, 'imported', imported.reason);
  assert.deepEqual(writes, { chats: 1, snapshots: 1 });
  assert.notEqual(imported.recovered.newChatId, pkg.chatId);
  assert.notEqual(imported.recovered.newSnapshotId, pkg.snapshotId);
  const recoveredChat = chats.get(imported.recovered.newChatId);
  const recoveredSnapshot = snapshots.get(imported.recovered.newSnapshotId);
  assert.equal(recoveredChat.meta.recovered.source, 'h2ochat-zip-recovery');
  assert.equal(recoveredChat.meta.recovered.portableZipName, 'm08-roundtrip.h2ochat.zip');
  assert.equal(recoveredChat.meta.recovered.packagePath, undefined, 'ZIP provenance must not invent an archive path');
  assert.equal(recoveredSnapshot.turns.length, pkg.snapshot.messages.length);
  assert.deepEqual(mem.files.get(mem.key(mem.HOME, 'H2O Studio Exports/m08-roundtrip.h2ochat.zip')), zipBefore, 'source ZIP changed during import');

  const corrupt = Uint8Array.from(zipBytes);
  corrupt[0] ^= 0xff;
  const refused = await importer.importVerifiedZip({ zipBytes: corrupt, sourceName: 'bad.h2ochat.zip' });
  assert.equal(refused.status, 'rejected');
  assert.deepEqual(writes, { chats: 1, snapshots: 1 }, 'bad ZIP caused persistent writes');

  const badManifest = JSON.parse(pkg.manifestText);
  badManifest.contentHash = `sha256-${'0'.repeat(64)}`;
  const validPackageEntries = [
    { name: `${pkg.chatId}.h2ochat/manifest.json`, bytes: Buffer.from(pkg.manifestText) },
    { name: `${pkg.chatId}.h2ochat/snapshot.json`, bytes: pkg.snapshotBytes },
    { name: `${pkg.chatId}.h2ochat/chat.md`, bytes: Buffer.from(pkg.files.__texts.markdownText) },
    { name: `${pkg.chatId}.h2ochat/chat.html`, bytes: Buffer.from(pkg.files.__texts.htmlText) },
    { name: `${pkg.chatId}.h2ochat/${pkg.assetPath}`, bytes: pkg.assetBytes },
  ];
  const packageEntries = validPackageEntries.map((entry) => ({ name: entry.name, bytes: Buffer.from(entry.bytes) }));
  packageEntries.find((entry) => entry.name.endsWith('/manifest.json')).bytes = Buffer.from(`${JSON.stringify(badManifest)}\n`);
  const invalidPackageZip = await runtime.H2O.Studio.ingestion.savedChatPortableZip.buildPortableZip(packageEntries);
  const packageRefused = await importer.importVerifiedZip({ zipBytes: invalidPackageZip, sourceName: 'bad-package.h2ochat.zip' });
  assert.equal(packageRefused.status, 'rejected');
  assert.deepEqual(writes, { chats: 1, snapshots: 1 }, 'corrupt contained package caused persistent writes');

  const corruptAssetEntries = validPackageEntries.map((entry) => ({ name: entry.name, bytes: Buffer.from(entry.bytes) }));
  const corruptAsset = corruptAssetEntries.find((entry) => entry.name.endsWith(pkg.assetPath));
  corruptAsset.bytes[0] ^= 0xff;
  const corruptAssetZip = await runtime.H2O.Studio.ingestion.savedChatPortableZip.buildPortableZip(corruptAssetEntries);
  const assetRefused = await importer.importVerifiedZip({ zipBytes: corruptAssetZip, sourceName: 'bad-asset.h2ochat.zip' });
  assert.equal(assetRefused.status, 'rejected');
  assert.deepEqual(writes, { chats: 1, snapshots: 1 }, 'corrupt contained asset caused persistent writes');

  const corruptRendererEntries = validPackageEntries.map((entry) => ({ name: entry.name, bytes: Buffer.from(entry.bytes) }));
  const corruptRenderer = corruptRendererEntries.find((entry) => entry.name.endsWith('/chat.md'));
  corruptRenderer.bytes[0] ^= 0xff;
  const corruptRendererZip = await runtime.H2O.Studio.ingestion.savedChatPortableZip.buildPortableZip(corruptRendererEntries);
  const rendererRefused = await importer.importVerifiedZip({ zipBytes: corruptRendererZip, sourceName: 'bad-renderer.h2ochat.zip' });
  assert.equal(rendererRefused.status, 'rejected');
  assert.deepEqual(writes, { chats: 1, snapshots: 1 }, 'corrupt contained renderer caused persistent writes');
});

checkAsync('M08 hostile ZIP structure, paths and resource declarations fail closed', async () => {
  const portable = loadBehaviorRuntime(createBehaviorFs()).H2O.Studio.ingestion.savedChatPortableZip;
  const encoder = new TextEncoder();
  const validName = 'a.h2ochat/manifest.json';
  const valid = await portable.buildPortableZip([{ name: validName, bytes: encoder.encode('{}') }]);
  const readU16 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
  const readU32 = (bytes, offset) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  const writeU16 = (bytes, offset, value) => { bytes[offset] = value & 255; bytes[offset + 1] = (value >>> 8) & 255; };
  const writeU32 = (bytes, offset, value) => {
    bytes[offset] = value & 255; bytes[offset + 1] = (value >>> 8) & 255;
    bytes[offset + 2] = (value >>> 16) & 255; bytes[offset + 3] = (value >>> 24) & 255;
  };
  const centralOffsetOf = (bytes) => readU32(bytes, bytes.byteLength - 22 + 16);

  for (const name of ['../x', 'a/../../x', '/absolute', '\\absolute', 'C:\\escape', 'a//b', 'a/./b']) {
    await assert.rejects(() => portable.buildPortableZip([{ name, bytes: encoder.encode('x') }]), /unsafe|absolute|path|segment/i, name);
  }
  await assert.rejects(() => portable.buildPortableZip([
    { name: validName, bytes: encoder.encode('a') },
    { name: validName, bytes: encoder.encode('b') },
  ]), /duplicate/i);
  await assert.rejects(() => portable.buildPortableZip([
    { name: `${'a'.repeat(portable.ZIP_FILENAME_BYTE_CAP + 1)}`, bytes: encoder.encode('x') },
  ]), /byte cap|too long/i);

  const badSignature = Uint8Array.from(valid); badSignature[0] ^= 0xff;
  await assert.rejects(() => portable.readPortableZip(badSignature), /signature/i);
  await assert.rejects(() => portable.readPortableZip(valid.slice(0, valid.byteLength - 1)), /End of Central Directory|EOCD/i);

  const methodMismatch = Uint8Array.from(valid); writeU16(methodMismatch, 8, 0);
  await assert.rejects(() => portable.readPortableZip(methodMismatch), /disagree/i);

  const compressedSizeMismatch = Uint8Array.from(valid);
  writeU32(compressedSizeMismatch, 18, readU32(compressedSizeMismatch, 18) + 1);
  await assert.rejects(() => portable.readPortableZip(compressedSizeMismatch), /disagree/i);

  const uncompressedSizeMismatch = Uint8Array.from(valid);
  writeU32(uncompressedSizeMismatch, 22, readU32(uncompressedSizeMismatch, 22) + 1);
  await assert.rejects(() => portable.readPortableZip(uncompressedSizeMismatch), /disagree/i);

  const unsupportedMethod = Uint8Array.from(valid);
  const unsupportedCentral = centralOffsetOf(unsupportedMethod);
  writeU16(unsupportedMethod, 8, 99);
  writeU16(unsupportedMethod, unsupportedCentral + 10, 99);
  await assert.rejects(() => portable.readPortableZip(unsupportedMethod), /unsupported feature|compression method/i);

  const encrypted = Uint8Array.from(valid);
  const encryptedCentral = centralOffsetOf(encrypted);
  writeU16(encrypted, 6, readU16(encrypted, 6) | 1);
  writeU16(encrypted, encryptedCentral + 8, readU16(encrypted, encryptedCentral + 8) | 1);
  await assert.rejects(() => portable.readPortableZip(encrypted), /Encrypted/i);

  const dataDescriptor = Uint8Array.from(valid);
  const descriptorCentral = centralOffsetOf(dataDescriptor);
  writeU16(dataDescriptor, 6, readU16(dataDescriptor, 6) | 8);
  writeU16(dataDescriptor, descriptorCentral + 8, readU16(dataDescriptor, descriptorCentral + 8) | 8);
  await assert.rejects(() => portable.readPortableZip(dataDescriptor), /data descriptor/i);

  const zip64 = Uint8Array.from(valid);
  writeU32(zip64, centralOffsetOf(zip64) + 20, 0xffffffff);
  await assert.rejects(() => portable.readPortableZip(zip64), /ZIP64/i);

  const symlink = Uint8Array.from(valid);
  const symlinkCentral = centralOffsetOf(symlink);
  writeU16(symlink, symlinkCentral + 4, (3 << 8) | 20);
  writeU32(symlink, symlinkCentral + 38, 0xa0000000);
  await assert.rejects(() => portable.readPortableZip(symlink), /symlink/i);

  const unixDirectory = Uint8Array.from(valid);
  const unixDirectoryCentral = centralOffsetOf(unixDirectory);
  writeU16(unixDirectory, unixDirectoryCentral + 4, (3 << 8) | 20);
  writeU32(unixDirectory, unixDirectoryCentral + 38, 0x40000000);
  await assert.rejects(() => portable.readPortableZip(unixDirectory), /directory|special-file/i);

  const dosDirectory = Uint8Array.from(valid);
  writeU32(dosDirectory, centralOffsetOf(dosDirectory) + 38, 0x10);
  await assert.rejects(() => portable.readPortableZip(dosDirectory), /directory|special-file/i);

  const unsafe = Uint8Array.from(valid);
  const unsafeCentral = centralOffsetOf(unsafe);
  const slashIndex = validName.indexOf('/');
  unsafe[30 + slashIndex] = '\\'.charCodeAt(0);
  unsafe[unsafeCentral + 46 + slashIndex] = '\\'.charCodeAt(0);
  await assert.rejects(() => portable.readPortableZip(unsafe), /path-ambiguous|unsafe/i);

  const nameMismatch = Uint8Array.from(valid);
  nameMismatch[30] = 'b'.charCodeAt(0);
  await assert.rejects(() => portable.readPortableZip(nameMismatch), /names|disagree/i);

  const duplicate = Uint8Array.from(await portable.buildPortableZip([
    { name: 'a.h2ochat/one.json', bytes: encoder.encode('one') },
    { name: 'a.h2ochat/two.json', bytes: encoder.encode('two') },
  ]));
  const duplicateCentral = centralOffsetOf(duplicate);
  const duplicateCentralSecond = duplicateCentral + 46 + readU16(duplicate, duplicateCentral + 28);
  const duplicateSecondLocal = readU32(duplicate, duplicateCentralSecond + 42);
  const duplicateFirstName = duplicate.slice(duplicateCentral + 46,
    duplicateCentral + 46 + readU16(duplicate, duplicateCentral + 28));
  duplicate.set(duplicateFirstName, duplicateCentralSecond + 46);
  duplicate.set(duplicateFirstName, duplicateSecondLocal + 30);
  await assert.rejects(() => portable.readPortableZip(duplicate), /duplicate/i);

  const truncatedCentral = Uint8Array.from(valid);
  const truncatedCentralOffset = centralOffsetOf(truncatedCentral);
  writeU16(truncatedCentral, truncatedCentralOffset + 28,
    readU16(truncatedCentral, truncatedCentralOffset + 28) + 1);
  await assert.rejects(() => portable.readPortableZip(truncatedCentral), /central entry is truncated/i);

  const outOfRange = Uint8Array.from(valid);
  writeU32(outOfRange, centralOffsetOf(outOfRange) + 42, 1);
  await assert.rejects(() => portable.readPortableZip(outOfRange), /overlap|gaps|range/i);

  const stored = await portable.buildPortableZip([{ name: validName, bytes: encoder.encode('{}') }], { method: portable.METHOD_STORED });
  const crcMismatch = Uint8Array.from(stored);
  crcMismatch[30 + readU16(crcMismatch, 26)] ^= 0xff;
  await assert.rejects(() => portable.readPortableZip(crcMismatch), /CRC/i);

  const declaredHuge = Uint8Array.from(valid);
  const declaredCentral = centralOffsetOf(declaredHuge);
  const tooLarge = portable.ZIP_UNCOMPRESSED_ENTRY_CAP_BYTES + 1;
  writeU32(declaredHuge, 22, tooLarge);
  writeU32(declaredHuge, declaredCentral + 24, tooLarge);
  await assert.rejects(() => portable.readPortableZip(declaredHuge), /output exceeds|uncompressed cap/i);

  const compressedHuge = Uint8Array.from(valid);
  writeU32(compressedHuge, centralOffsetOf(compressedHuge) + 20, portable.ZIP_COMPRESSED_ENTRY_CAP_BYTES + 1);
  await assert.rejects(() => portable.readPortableZip(compressedHuge), /compressed size exceeds|compressed cap/i);

  const excessiveCount = Uint8Array.from(valid);
  const excessiveCountEocd = excessiveCount.byteLength - 22;
  writeU16(excessiveCount, excessiveCountEocd + 8, portable.ZIP_ENTRY_COUNT_CAP + 1);
  writeU16(excessiveCount, excessiveCountEocd + 10, portable.ZIP_ENTRY_COUNT_CAP + 1);
  await assert.rejects(() => portable.readPortableZip(excessiveCount), /entry count/i);

  const cumulative = Uint8Array.from(await portable.buildPortableZip(
    Array.from({ length: 5 }, (_, index) => ({ name: `a.h2ochat/file-${index}.json`, bytes: encoder.encode('{}') })),
  ));
  let cumulativeCentral = centralOffsetOf(cumulative);
  for (let index = 0; index < 5; index += 1) {
    const localOffset = readU32(cumulative, cumulativeCentral + 42);
    writeU32(cumulative, localOffset + 22, portable.ZIP_UNCOMPRESSED_ENTRY_CAP_BYTES);
    writeU32(cumulative, cumulativeCentral + 24, portable.ZIP_UNCOMPRESSED_ENTRY_CAP_BYTES);
    cumulativeCentral += 46 + readU16(cumulative, cumulativeCentral + 28)
      + readU16(cumulative, cumulativeCentral + 30) + readU16(cumulative, cumulativeCentral + 32);
  }
  await assert.rejects(() => portable.readPortableZip(cumulative), /cumulative declared output/i);

  const smallDeclared = Uint8Array.from(await portable.buildPortableZip([
    { name: validName, bytes: encoder.encode('decompression-bound '.repeat(200)) },
  ]));
  const smallCentral = centralOffsetOf(smallDeclared);
  writeU32(smallDeclared, 22, 8);
  writeU32(smallDeclared, smallCentral + 24, 8);
  await assert.rejects(() => portable.readPortableZip(smallDeclared), /exceeds|size/i);

  const multipleRoots = await portable.buildPortableZip([
    { name: 'a.h2ochat/manifest.json', bytes: encoder.encode('{}') },
    { name: 'b.h2ochat/snapshot.json', bytes: encoder.encode('{}') },
  ]);
  await assert.rejects(() => portable.readPortablePackageZip(multipleRoots), /exactly one/i);

  const missingMember = await portable.buildPortableZip([
    { name: 'a.h2ochat/manifest.json', bytes: encoder.encode(JSON.stringify({ schemaVersion: 1, files: {} })) },
  ]);
  await assert.rejects(() => portable.readPortablePackageZip(missingMember), /inventory/i);
});

let failures = 0;
/* ── M05 Phase 4 — zero-asset v2 identity ──────────────────────────────────
 * A v2 package with NO assets is ordinary: any chat without images produces
 * one. Its identity is the canonical preservation descriptor with an empty
 * assets array — the same rule every other v2 package uses. The exporter used
 * to treat an empty array as "not really v2" and verify the copy against the
 * v1 bare-snapshot hash instead, so export rejected packages the governed
 * builder and validator both accept. This proves the three authorities agree. */
checkAsync('M05 P4 zero-asset v2 exports: governed identity holds without assets', async () => {
  const mem = createBehaviorFs();
  const pkg = makeBehaviorPackage({ schemaVersion: 2, chatId: 'p4_v2_zero_asset' });
  assert.equal(pkg.assets.length, 0, 'fixture error: this package must have zero assets');
  assert.equal(pkg.manifest.assets.length, 0, 'fixture error: manifest.assets must be empty');

  /* The fixture's contentHash is built by the governed v2 construction, and it
   * must NOT coincide with the bare snapshot hash — otherwise the old and new
   * exporter branches would agree and this proof would be vacuous. */
  const snapshotSha = pkg.manifest.files.snapshot.sha256;
  assert.notEqual(pkg.manifest.contentHash, snapshotSha,
    'fixture error: governed v2 identity must differ from the v1 bare snapshot hash');

  // Install under a real §D generation basename derived from its own hash.
  const genHex = String(pkg.manifest.contentHash).match(/[0-9a-f]{64}/)[0];
  const root = installBehaviorPackage(mem, pkg, `archive/packages/p4_v2_zero_asset.g${genHex}.h2ochat`);
  const runtime = loadBehaviorRuntime(mem);

  // 1. Governed inspection accepts the package.
  const inspection = await runtime.H2O.Studio.archiveInspector.inspectPackage({ packagePath: root });
  assert.equal(inspection.status, 'verified', `governed inspection rejected a valid zero-asset v2 package: ${JSON.stringify(inspection.blockers || [])}`);
  assert.equal(inspection.checks.contentHashOk, true, 'governed recomputation disagreed with the manifest');
  assert.equal(inspection.identity.contentHash, pkg.manifest.contentHash);

  const exporter = runtime.H2O.Studio.archiveExporter;

  // 2. Export dry-run accepts it.
  const dry = await exporter.dryRunExportPackage({ packagePath: root, exportName: 'p4-v2-zero.h2ochat' });
  assert.equal(dry.status, 'export-ready', `dry-run rejected a governed-valid package: ${dry.reason}`);

  // 3/4. Export succeeds, preserves the explicit path, and reports the
  //      governed recomputed identity — not the v1 fallback.
  const out = await exporter.exportVerifiedPackage({ packagePath: root, exportName: 'p4-v2-zero.h2ochat' });
  assert.equal(out.status, 'exported', `export self-verification rejected a governed-valid package: ${out.reason}`);
  assert.equal(out.packagePath, root, 'export retargeted a different package');
  assert.equal(out.contentHash, pkg.manifest.contentHash, 'exported identity is not the governed v2 contentHash');
  assert.notEqual(out.contentHash, snapshotSha, 'exported identity fell back to the v1 bare snapshot hash');
  assert.equal(out.contentHashVerified, true);

  // The copy is byte-faithful.
  for (const leaf of ['manifest.json', 'snapshot.json', 'chat.md', 'chat.html']) {
    assert.deepEqual(
      mem.files.get(mem.key(mem.HOME, `H2O Studio Exports/p4-v2-zero.h2ochat/${leaf}`)),
      mem.files.get(mem.key(mem.APP, `${root}/${leaf}`)),
      `${leaf} was not copied byte-identically`,
    );
  }
});

/* ── M05 Phase 4 proof 10 — export preserves the explicitly selected generation ──
 * Two valid sibling generations of ONE chat, differing in content. Export is
 * handed one path; it must copy THAT package. An exporter that resolved
 * "the newest sibling" or re-derived a path from the chat id would hand the
 * operator an archive they did not choose — silently, and with a plausible
 * name on it. */
checkAsync('M05 P4.10 export copies the explicitly selected generation, not a sibling', async () => {
  const mem = createBehaviorFs();
  const CHAT = 'p4_export_sel';
  const genOld = makeBehaviorPackage({ schemaVersion: 1, chatId: CHAT });
  const genNew = makeBehaviorPackage({ schemaVersion: 2, chatId: CHAT });
  assert.notEqual(genOld.manifest.contentHash, genNew.manifest.contentHash,
    'fixture error: siblings must differ in content');

  const oldRoot = installBehaviorPackage(mem, genOld, `archive/packages/${CHAT}.h2ochat`);
  /* The sibling wears a real §D generation basename — derived from its own
   * contentHash, since a basename claiming any other hash is a `mismatch` and
   * would be rejected before selection is ever tested. It is the newer-format
   * package of the pair, so an exporter that preferred "the newest generation"
   * over the path it was handed would take it instead. */
  const newGenHex = String(genNew.manifest.contentHash).match(/[0-9a-f]{64}/)[0];
  const newRoot = installBehaviorPackage(mem, genNew, `archive/packages/${CHAT}.g${newGenHex}.h2ochat`);
  assert.notEqual(newRoot, oldRoot, 'fixture error: siblings must occupy distinct paths');

  const exporter = loadBehaviorRuntime(mem).H2O.Studio.archiveExporter;
  const out = await exporter.exportVerifiedPackage({ packagePath: oldRoot, exportName: 'p4-selected.h2ochat' });
  assert.equal(out.status, 'exported');

  // 1. The result names the selected package, not the sibling.
  assert.equal(out.packagePath, oldRoot, 'export retargeted a sibling generation');

  // 2. The BYTES that landed are the selected generation's. Two generations of
  //    one chat share their rendered views when only the snapshot format moved,
  //    so divergence is asserted exactly where the sources actually diverge —
  //    demanding it everywhere would be a fixture assumption, not a proof.
  let discriminated = 0;
  for (const leaf of ['manifest.json', 'snapshot.json', 'chat.md', 'chat.html']) {
    const exported = mem.files.get(mem.key(mem.HOME, `H2O Studio Exports/p4-selected.h2ochat/${leaf}`));
    const selectedBytes = mem.files.get(mem.key(mem.APP, `${oldRoot}/${leaf}`));
    const siblingBytes = mem.files.get(mem.key(mem.APP, `${newRoot}/${leaf}`));
    assert.deepEqual(exported, selectedBytes, `${leaf} is not the selected generation`);
    if (!selectedBytes.equals(siblingBytes)) {
      discriminated += 1;
      assert.notDeepEqual(exported, siblingBytes, `${leaf} came from the sibling generation`);
    }
  }
  assert.ok(discriminated >= 2, `fixture error: siblings differ in only ${discriminated} file(s) — too weak to discriminate`);

  // 3. The reported identity is the selected generation's verified hash.
  assert.equal(out.contentHash, genOld.manifest.contentHash, 'reported contentHash is not the selected generation');
  assert.notEqual(out.contentHash, genNew.manifest.contentHash);
  assert.equal(out.contentHashVerified, true, 'export did not report a verified identity');

  // 4. Exporting the sibling explicitly yields the sibling — selection is honoured
  //    in both directions, so this is not passing by always picking the first.
  const out2 = await exporter.exportVerifiedPackage({ packagePath: newRoot, exportName: 'p4-selected-2.h2ochat' });
  assert.equal(out2.status, 'exported');
  assert.equal(out2.packagePath, newRoot);
  assert.equal(out2.contentHash, genNew.manifest.contentHash);
});

for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || String(error));
  }
}

for (const { name, fn } of asyncChecks) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || String(error));
  }
}

if (failures > 0) {
  console.error(`\n${failures} saved chat archive export/share validation check(s) failed.`);
  process.exit(1);
}

console.log(`\nPASS saved chat archive export/share J.2/M02 T05 implementation validation (${checks.length + asyncChecks.length} checks)`);
