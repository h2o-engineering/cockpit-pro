import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const mobileStorageMock = createMobileStorageMock();

const cacheSource = readRepoFile('apps/studio/mobile/src/features/sync/readonly-bundle-cache.ts');
const mobileStorageSource = readRepoFile('apps/studio/mobile/src/identity/mobileStorage.ts');
assert.doesNotMatch(cacheSource, /@react-native-async-storage\/async-storage/);
assert.match(cacheSource, /from ["']\.\.\/\.\.\/identity\/mobileStorage["']/);
assert.match(mobileStorageSource, /export async function writeMobileStorageJson\(key: string, value: unknown\): Promise<void> \{\s*await writeJson\(key, value\);\s*\}/);

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function loadReadonlyCacheModule() {
  return loadTypescriptModuleWithMocks(
    'apps/studio/mobile/src/features/sync/readonly-bundle-cache.ts',
    {
      '../../identity/mobileStorage': mobileStorageMock.api,
    },
  );
}

function loadTypescriptModuleWithMocks(relativePath, mocks) {
  const helperPath = path.join(repoRoot, relativePath);
  const source = readRepoFile(relativePath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      strict: true,
      esModuleInterop: true,
    },
    fileName: helperPath,
  });

  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const helperModule = new Module(helperPath);
    helperModule.filename = helperPath;
    helperModule.paths = Module._nodeModulePaths(path.dirname(helperPath));
    helperModule._compile(transpiled.outputText, helperPath);
    return helperModule.exports;
  } finally {
    Module._load = originalLoad;
  }
}

function createMobileStorageMock() {
  const state = {
    values: new Map(),
    setCalls: [],
    removeCalls: [],
  };
  return {
    state,
    api: {
      async readMobileStorageItem(key) {
        return state.values.has(key) ? state.values.get(key) : null;
      },
      async writeMobileStorageJson(key, value) {
        state.setCalls.push(key);
        state.values.set(key, JSON.stringify(value));
      },
      async removeMobileStorageItem(key) {
        state.removeCalls.push(key);
        state.values.delete(key);
      },
    },
  };
}

function makeDiagnostic() {
  return {
    schema: 'h2o.mobile.bundle-reader.diagnostic.v1',
    ok: true,
    redacted: true,
    readOnly: true,
    source: {
      kind: 'pasted-json',
      schemaPresent: true,
      checksumPresent: true,
      checksumVerified: false,
      sourcePeerPresent: true,
      exportedAtPresent: true,
    },
    counts: {
      chats: 7,
      snapshots: 4,
      folders: 12,
      folderMemberships: 7,
      labels: 15,
      categories: 12,
      conflicts: 0,
      tombstones: 11,
      applyEvents: 0,
    },
    capabilities: ['read-only'],
    blockers: [],
    warnings: [{ code: 'bundle-checksum-mismatch' }],
    rawBundleText: 'RAW_BUNDLE_TEXT_SHOULD_NOT_BE_STORED',
    snapshotMessageText: 'SNAPSHOT_MESSAGE_TEXT_SHOULD_NOT_BE_STORED',
    folderName: 'FOLDER_NAME_SHOULD_NOT_BE_STORED',
    rawId: 'raw-id-should-not-be-stored',
    peerId: 'peer-id-should-not-be-stored',
    rawHash: 'raw-hash-should-not-be-stored',
    auditJson: '{"secret":"audit-json-should-not-be-stored"}',
    metadataBlob: { secret: 'metadata-blob-should-not-be-stored' },
  };
}

function assertWarning(result, code) {
  assert.equal(
    result.warnings.some((warning) => warning.code === code),
    true,
    `expected warning ${code}`,
  );
}

function assertStoredValueRedacted(storedValue) {
  const forbidden = [
    'RAW_BUNDLE_TEXT_SHOULD_NOT_BE_STORED',
    'SNAPSHOT_MESSAGE_TEXT_SHOULD_NOT_BE_STORED',
    'FOLDER_NAME_SHOULD_NOT_BE_STORED',
    'raw-id-should-not-be-stored',
    'peer-id-should-not-be-stored',
    'raw-hash-should-not-be-stored',
    'audit-json-should-not-be-stored',
    'metadata-blob-should-not-be-stored',
    'contentSha256',
    'eventDigest',
    'resultJson',
    'messages',
    'snapshotsText',
  ];
  for (const value of forbidden) {
    assert.equal(storedValue.includes(value), false, `stored metadata leaked ${value}`);
  }
}

const cache = loadReadonlyCacheModule();
const {
  READ_ONLY_BUNDLE_CACHE_KEY,
  READ_ONLY_BUNDLE_CACHE_SCHEMA,
  buildReadOnlyBundleCacheMetadata,
  saveReadOnlyBundleCacheMetadata,
  loadReadOnlyBundleCacheMetadata,
  clearReadOnlyBundleCacheMetadata,
} = cache;

assert.equal(READ_ONLY_BUNDLE_CACHE_KEY, 'h2o.mobile.readonly.bundle-cache.v1');
assert.equal(READ_ONLY_BUNDLE_CACHE_SCHEMA, 'h2o.mobile.readonly.bundle-cache.v1');

mobileStorageMock.state.values.set('h2o_chat_archive_v1.json', 'archive-state-sentinel');
mobileStorageMock.state.values.set('h2o_webdav_settings_v1.json', 'webdav-settings-sentinel');
mobileStorageMock.state.values.set('h2o.identity.snapshot.v1', 'identity-sentinel');

const missing = await loadReadOnlyBundleCacheMetadata();
assert.equal(missing.ok, true);
assert.equal(missing.found, false);
assert.equal(missing.metadata, null);
assert.deepEqual(missing.warnings, []);

const metadata = buildReadOnlyBundleCacheMetadata({
  diagnostic: makeDiagnostic(),
  sourceKind: 'pasted-json',
  cachedAt: '2026-05-25T00:00:00.000Z',
});
assert.equal(metadata.schema, READ_ONLY_BUNDLE_CACHE_SCHEMA);
assert.equal(metadata.readOnly, true);
assert.equal(metadata.nonAuthoritative, true);
assert.equal(metadata.sourceKind, 'pasted-json');
assert.deepEqual(metadata.counts, makeDiagnostic().counts);
assert.deepEqual(metadata.warnings, [{ code: 'bundle-checksum-mismatch' }]);

const metadataWithExtraFields = {
  ...metadata,
  fullBundleText: 'RAW_BUNDLE_TEXT_SHOULD_NOT_BE_STORED',
  snapshotMessages: ['SNAPSHOT_MESSAGE_TEXT_SHOULD_NOT_BE_STORED'],
  rawId: 'raw-id-should-not-be-stored',
  counts: {
    ...metadata.counts,
    rawHash: 'raw-hash-should-not-be-stored',
  },
};

const saveResult = await saveReadOnlyBundleCacheMetadata(metadataWithExtraFields);
assert.equal(saveResult.ok, true);
assert.deepEqual(saveResult.warnings, []);
assert.deepEqual(mobileStorageMock.state.setCalls, [READ_ONLY_BUNDLE_CACHE_KEY]);

const storedValue = mobileStorageMock.state.values.get(READ_ONLY_BUNDLE_CACHE_KEY);
assert.equal(typeof storedValue, 'string');
assertStoredValueRedacted(storedValue);

const storedParsed = JSON.parse(storedValue);
assert.deepEqual(Object.keys(storedParsed).sort(), [
  'cachedAt',
  'checksumPresent',
  'checksumVerified',
  'counts',
  'exportedAtPresent',
  'nonAuthoritative',
  'readOnly',
  'schema',
  'sourceKind',
  'sourcePeerPresent',
  'sourceSchemaPresent',
  'warnings',
].sort());
assert.deepEqual(Object.keys(storedParsed.counts).sort(), [
  'applyEvents',
  'categories',
  'chats',
  'conflicts',
  'folderMemberships',
  'folders',
  'labels',
  'snapshots',
  'tombstones',
].sort());

const loaded = await loadReadOnlyBundleCacheMetadata();
assert.equal(loaded.ok, true);
assert.equal(loaded.found, true);
assert.deepEqual(loaded.metadata, metadata);
assert.deepEqual(loaded.warnings, []);

mobileStorageMock.state.values.set(READ_ONLY_BUNDLE_CACHE_KEY, '{ bad json');
const malformed = await loadReadOnlyBundleCacheMetadata();
assert.equal(malformed.ok, false);
assert.equal(malformed.found, false);
assert.equal(malformed.metadata, null);
assertWarning(malformed, 'readonly-cache-malformed');

mobileStorageMock.state.values.set(
  READ_ONLY_BUNDLE_CACHE_KEY,
  JSON.stringify({ ...metadata, schema: 'h2o.mobile.readonly.bundle-cache.v0' }),
);
const unsupported = await loadReadOnlyBundleCacheMetadata();
assert.equal(unsupported.ok, false);
assert.equal(unsupported.found, false);
assert.equal(unsupported.metadata, null);
assertWarning(unsupported, 'readonly-cache-schema-unsupported');

mobileStorageMock.state.values.set(READ_ONLY_BUNDLE_CACHE_KEY, storedValue);
const clearResult = await clearReadOnlyBundleCacheMetadata();
assert.equal(clearResult.ok, true);
assert.deepEqual(clearResult.warnings, []);
assert.deepEqual(mobileStorageMock.state.removeCalls, [READ_ONLY_BUNDLE_CACHE_KEY]);
assert.equal(mobileStorageMock.state.values.has(READ_ONLY_BUNDLE_CACHE_KEY), false);
assert.equal(mobileStorageMock.state.values.get('h2o_chat_archive_v1.json'), 'archive-state-sentinel');
assert.equal(mobileStorageMock.state.values.get('h2o_webdav_settings_v1.json'), 'webdav-settings-sentinel');
assert.equal(mobileStorageMock.state.values.get('h2o.identity.snapshot.v1'), 'identity-sentinel');

console.log(
  JSON.stringify(
    {
      schema: 'h2o.mobile.readonly-cache.validation.v1',
      ok: true,
      cacheKey: READ_ONLY_BUNDLE_CACHE_KEY,
      missingLoad: {
        ok: missing.ok,
        found: missing.found,
        warnings: missing.warnings,
      },
      buildMetadata: {
        schema: metadata.schema,
        readOnly: metadata.readOnly,
        nonAuthoritative: metadata.nonAuthoritative,
        counts: metadata.counts,
        warnings: metadata.warnings,
      },
      save: {
        onlyIsolatedKeyWritten: true,
      },
      loadValid: {
        ok: loaded.ok,
        found: loaded.found,
        metadataShapeMatched: true,
      },
      malformed: {
        ok: malformed.ok,
        warnings: malformed.warnings,
      },
      unsupportedSchema: {
        ok: unsupported.ok,
        warnings: unsupported.warnings,
      },
      clear: {
        onlyIsolatedKeyRemoved: true,
      },
      redaction: {
        passed: true,
      },
    },
    null,
    2,
  ),
);
