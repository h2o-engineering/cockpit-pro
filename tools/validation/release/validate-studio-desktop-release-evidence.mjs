#!/usr/bin/env node
// Focused, read-only Product validation. Only synthetic bytes under os.tmpdir().
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMAS, canonicalJson, canonicalBytes, verifyCanonicalBytes, sha256Bytes,
  sha256File, bundleTreeSha256, verifyArtifactBytes, sealEvidence,
  verifySealedEvidence, createIndexEntry, validateIndexChain, resolveIndexState,
  assertCurrentObject, validateReleaseChain, validateReleaseEvents, validateReleaseId, validateRcId,
  validateReleaseTag,
} from '../../release/studio-desktop-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const expectedSchemas = [
  'build', 'artifact', 'decision-reference', 'rc', 'tag-event', 'github-event',
  'publication-event', 'delivery-event', 'index-entry', 'copy-attestation',
].map((kind) => `h2o.studio.release-evidence.${kind}.v1`);
assert.deepEqual(Object.values(SCHEMAS), expectedSchemas);
const document = fs.readFileSync(path.join(root, 'docs/systems/cross-platform/studio-desktop-release-evidence-contract.md'), 'utf8');
for (const required of [
  'append-only Release Evidence Index', 'RFC 8785', 'obj:sha256:',
  'bundle-tree-sha256-v1', 'sha256-file-v1', 'synthetic: true',
  'LIVE_PHYSICAL_STORE=NOT ESTABLISHED BY THIS IMPLEMENTATION',
  'GitHub Release is hosted', 'h2o.studio.desktop-build-identity.v1',
  ...expectedSchemas,
]) assert.ok(document.includes(required), `contract missing ${required}`);
const oldCommand = fs.readFileSync(path.join(root, 'apps/studio/desktop/src-tauri/src/build_identity.rs'), 'utf8');
const binary = fs.readFileSync(path.join(root, 'apps/studio/desktop/src-tauri/src/main.rs'), 'utf8');
assert.match(oldCommand, /h2o\.studio\.desktop-build-identity\.v1/);
assert.match(oldCommand, /pub fn h2o_studio_desktop_build_identity\(\)/);
assert.match(oldCommand, /h2o\.studio\.release-evidence\.packaged-build-identity\.v1/);
for (const stamp of ['H2O_STUDIO_BUILD_SOURCE_COMMIT', 'H2O_STUDIO_BUILD_CHECKPOINT',
  'H2O_STUDIO_BUILD_TIMESTAMP', 'H2O_STUDIO_BUILD_GOVERNED', 'H2O_BUILD_PROFILE',
  'H2O_BUILD_DIRTY', 'CARGO_PKG_VERSION']) {
  assert.ok(oldCommand.includes(`env!("${stamp}")`), `packaged readback missing ${stamp}`);
}
assert.match(binary, /--h2o-build-identity-json/);
assert.match(binary, /arguments\.len\(\) == 1/);
assert.match(binary, /packaged_release_evidence_identity\(\)/);
assert.match(binary, /h2o_studio_desktop_lib::run\(\)/);
console.log('CONTRACT_AND_LEGACY_IDENTITY=PASS');

function synthetic(schema, fields) {
  return { schema, synthetic: true, authorityEffect: 'NONE', ...fields };
}
function sealed(payload) { return sealEvidence(payload, { mode: 'synthetic' }); }
function rejected(label, operation, pattern) {
  assert.throws(operation, pattern, label);
  console.log(`NEGATIVE_${label}=PASS`);
}

assert.equal(canonicalJson({ z: 1, a: [true, null, 'é'], '\uE000': 1, '\u{10000}': 2 }),
  '{"a":[true,null,"é"],"z":1,"𐀀":2,"":1}');
assert.equal(verifyCanonicalBytes(canonicalBytes({ b: 1, a: 2 })).a, 2);
rejected('NONFINITE', () => canonicalJson(NaN), /non-finite/);
rejected('LONE_SURROGATE', () => canonicalJson('\ud800'), /surrogate/);
rejected('DUPLICATE_KEY', () => verifyCanonicalBytes(Buffer.from('{"a":1,"a":2}')), /noncanonical/);
rejected('NONCANONICAL_JSON', () => verifyCanonicalBytes(Buffer.from('{"b":1,"a":2}')), /noncanonical/);
console.log('RFC8785_CANONICALIZATION=PASS');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-m03-synthetic-'));
try {
  const appPath = path.join(temporary, 'SYNTHETIC-H2O-Studio.app');
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'h2o-studio-desktop');
  const dmgPath = path.join(temporary, 'SYNTHETIC-H2O-Studio.dmg');
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, 'SYNTHETIC EXECUTABLE BYTES\n');
  fs.writeFileSync(dmgPath, 'SYNTHETIC DMG BYTES\n');
  fs.symlinkSync('MacOS/h2o-studio-desktop', path.join(appPath, 'Contents', 'SyntheticLink'));
  const sourceCommit = 'a'.repeat(40);
  const version = '0.1.0';
  const releaseId = `studio-desktop/v${version}`;
  const rcId = `${releaseId}/rc.1`;
  const exeDigest = `sha256:${sha256File(executablePath)}`;
  const appDigest = `sha256:${bundleTreeSha256(appPath)}`;
  const dmgDigest = `sha256:${sha256File(dmgPath)}`;
  assert.notEqual(appDigest, dmgDigest);
  assert.notEqual(appDigest, exeDigest);
  const readback = {
    componentId: 'studio-desktop', componentVersion: version, sourceCommit,
    checkpoint: 'SYNTHETIC_CHECKPOINT', builtAtUtc: '2026-09-28T12:00:00Z',
    targetOs: 'macos', architecture: 'arm64', profile: 'release', governed: true,
    sourceDirty: false, executableSha256: exeDigest,
  };
  const build = sealed(synthetic(SCHEMAS.build, {
    ...readback, packagedReadback: {
      schema: 'h2o.studio.release-evidence.packaged-build-identity.v1', ...readback,
    },
  }));
  const locations = { executable: executablePath, app: appPath, dmg: dmgPath };
  const digests = { executable: exeDigest, app: appDigest, dmg: dmgDigest };
  const artifacts = Object.fromEntries(['executable', 'app', 'dmg'].map((kind) => {
    const byteSize = kind === 'app' ? fs.statSync(executablePath).size : fs.statSync(locations[kind]).size;
    const artifact = sealed(synthetic(SCHEMAS.artifact, {
      artifactId: `studio-desktop@${version}/artifact/${kind}/${digests[kind]}`,
      kind, digestMethod: kind === 'app' ? 'bundle-tree-sha256-v1' : 'sha256-file-v1',
      digest: digests[kind], byteSize, buildObjectId: build.objectId,
      sourceCommit, componentVersion: version, targetOs: 'macos', architecture: 'arm64',
    }));
    assert.equal(verifyArtifactBytes(artifact.payload, locations[kind]), true);
    return [kind, artifact];
  }));
  const decision = sealed(synthetic(SCHEMAS.decision, {
    decisionType: 'rc', decisionAuthority: 'HDA/Product', releaseId, rcId,
    managementCommit: 'b'.repeat(40), recordPath: 'missions/synthetic-m03/decision.md',
    decisionDigest: `sha256:${'c'.repeat(64)}`,
    approvedAssetObjectIds: [artifacts.app.objectId, artifacts.dmg.objectId],
  }));
  const rc = sealed(synthetic(SCHEMAS.rc, {
    rcId, releaseId, sourceCommit, buildObjectId: build.objectId,
    artifactObjectIds: Object.fromEntries(Object.entries(artifacts).map(([kind, record]) => [kind, record.objectId])),
    decisionObjectId: decision.objectId,
  }));
  assert.equal(validateReleaseChain({ build, artifacts, decision, rc }, { mode: 'synthetic' }), true);
  for (const record of [build, ...Object.values(artifacts), decision, rc]) {
    assert.equal(record.objectId, `obj:sha256:${sha256Bytes(record.bytes)}`);
    assert.deepEqual(verifySealedEvidence(record, { mode: 'synthetic' }), record.payload);
  }
  console.log('OBJECT_CONTENT_ID=PASS');
  console.log('SHA256_FILE_V1=PASS');
  console.log('BUNDLE_TREE_SHA256_V1=PASS');
  console.log('BUILD_ARTIFACT_RC=PASS');

  const decisionBase = {
    decisionAuthority: 'HDA/Product', releaseId, managementCommit: 'b'.repeat(40),
    recordPath: 'missions/synthetic-m03/decision.md',
    decisionDigest: `sha256:${'c'.repeat(64)}`,
    approvedAssetObjectIds: [artifacts.app.objectId, artifacts.dmg.objectId],
  };
  const releaseDecision = sealed(synthetic(SCHEMAS.decision, { ...decisionBase, decisionType: 'release', rcId }));
  const tagDecision = sealed(synthetic(SCHEMAS.decision, { ...decisionBase, decisionType: 'tag' }));
  const publicationDecision = sealed(synthetic(SCHEMAS.decision, { ...decisionBase, decisionType: 'publication' }));
  const tag = sealed(synthetic(SCHEMAS.tag, {
    releaseId, tag: `component/${releaseId}`, targetCommit: sourceCommit,
    refObjectId: sourceCommit, tagObjectId: null,
    observedAtUtc: '2026-09-28T12:01:00Z', operator: 'SYNTHETIC_OPERATOR',
    decisionObjectId: tagDecision.objectId, releaseDecisionObjectId: releaseDecision.objectId,
  }));
  const github = sealed(synthetic(SCHEMAS.github, {
    releaseId, githubReleaseId: 1, githubNodeId: 'SYNTHETIC_NODE', state: 'published',
    tag: `component/${releaseId}`, targetCommit: sourceCommit,
    createdAtUtc: '2026-09-28T12:01:30Z', publishedAtUtc: '2026-09-28T12:02:00Z',
    updatedAtUtc: '2026-09-28T12:02:00Z', observedAtUtc: '2026-09-28T12:02:30Z',
    operator: 'SYNTHETIC_OPERATOR',
    assets: [
      { assetId: 1, name: 'SYNTHETIC.app', byteSize: artifacts.app.payload.byteSize,
        githubDigest: null, approvedDigest: appDigest, artifactObjectId: artifacts.app.objectId },
      { assetId: 2, name: 'SYNTHETIC.dmg', byteSize: artifacts.dmg.payload.byteSize,
        githubDigest: null, approvedDigest: dmgDigest, artifactObjectId: artifacts.dmg.objectId },
    ],
    decisionObjectId: publicationDecision.objectId,
    releaseDecisionObjectId: releaseDecision.objectId,
  }));
  const publication = sealed(synthetic(SCHEMAS.publication, {
    releaseId, githubEventObjectId: github.objectId, decisionObjectId: publicationDecision.objectId,
    operator: 'SYNTHETIC_OPERATOR', occurredAtUtc: '2026-09-28T12:03:00Z',
  }));
  const deployment = sealed(synthetic(SCHEMAS.delivery, {
    eventType: 'deployment', releaseId, artifactObjectId: artifacts.app.objectId,
    destination: 'SYNTHETIC_DESTINATION', operator: 'SYNTHETIC_OPERATOR',
    occurredAtUtc: '2026-09-28T12:04:00Z', deploymentId: 'SYNTHETIC_DEPLOYMENT',
  }));
  const activation = sealed(synthetic(SCHEMAS.delivery, {
    eventType: 'activation', releaseId, artifactObjectId: artifacts.app.objectId,
    destination: 'SYNTHETIC_DESTINATION', operator: 'SYNTHETIC_OPERATOR',
    occurredAtUtc: '2026-09-28T12:05:00Z', deploymentId: 'SYNTHETIC_DEPLOYMENT',
    predecessorObjectId: deployment.objectId,
  }));
  const copy = sealed(synthetic(SCHEMAS.copy, {
    releaseId, copyId: 'SYNTHETIC_COPY', sourceLocator: 'SYNTHETIC_PRIMARY',
    targetLocator: 'SYNTHETIC_OTHER_HOST', sourceHostId: 'SYNTHETIC_HOST_A',
    targetHostId: 'SYNTHETIC_HOST_B', copyDigest: `sha256:${'d'.repeat(64)}`,
    operator: 'SYNTHETIC_OTHER_OPERATOR', observedAtUtc: '2026-09-28T12:06:00Z',
    objectIds: [build.objectId, artifacts.app.objectId, artifacts.dmg.objectId],
  }));
  for (const record of [releaseDecision, tagDecision, publicationDecision, tag, github, publication, deployment, activation, copy]) verifySealedEvidence(record, { mode: 'synthetic' });
  assert.equal(validateReleaseEvents({
    build, artifacts, rc, releaseDecision, tagDecision, publicationDecision,
    tag, github, publication,
  }, { mode: 'synthetic' }), true);
  console.log('OPTIONAL_EVENT_SCHEMAS=PASS');

  const children = [build, artifacts.executable, artifacts.app, artifacts.dmg, decision, rc,
    releaseDecision, tagDecision, publicationDecision, tag, github, publication,
    deployment, activation, copy];
  const objects = new Map(children.map((record) => [record.objectId, record]));
  const entries = [];
  for (const child of children) entries.push(createIndexEntry({
    releaseId, sequence: entries.length + 1,
    previousEntryDigest: entries.length ? `sha256:${entries.at(-1).digest}` : null,
    childSchema: child.payload.schema,
    childSemanticId: child.payload.schema === SCHEMAS.build ? `studio-desktop@${version}` :
      child.payload.schema === SCHEMAS.rc ? child.payload.rcId :
      child.payload.schema === SCHEMAS.artifact ? child.payload.artifactId :
      child.payload.schema === SCHEMAS.tag ? child.payload.tag :
      child.payload.schema === SCHEMAS.copy ? child.payload.copyId : releaseId,
    childObjectId: child.objectId, synthetic: true,
  }));
  assert.equal(validateIndexChain(entries, { mode: 'synthetic', objects }), true);
  assertCurrentObject(entries, build.objectId, { mode: 'synthetic' });
  console.log('APPEND_ONLY_INDEX=PASS');

  rejected('MALFORMED_SCHEMA', () => sealed({ ...build.payload, schema: 'invalid' }), /malformed schema/);
  rejected('PACKAGED_READBACK_MISMATCH', () => sealed({ ...build.payload,
    packagedReadback: { ...build.payload.packagedReadback, sourceCommit: 'e'.repeat(40) },
  }), /packaged readback sourceCommit mismatch/);
  rejected('OBJECT_DIGEST_MISMATCH', () => verifySealedEvidence({ ...build, objectId: `obj:sha256:${'0'.repeat(64)}` }, { mode: 'synthetic' }), /object digest mismatch/);
  rejected('SEALED_PAYLOAD_BYTES_MISMATCH', () => verifySealedEvidence({ ...build, payload: { ...build.payload, checkpoint: 'ALTERED' } }, { mode: 'synthetic' }), /payload\/bytes mismatch/);
  const badPredecessor = createIndexEntry({ ...entries[1].payload, previousEntryDigest: `sha256:${'0'.repeat(64)}` });
  rejected('PREDECESSOR_MISMATCH', () => validateIndexChain([entries[0], badPredecessor], { mode: 'synthetic' }), /predecessor mismatch/);
  const gap = createIndexEntry({ ...entries[1].payload, sequence: 3 });
  rejected('SEQUENCE_GAP', () => validateIndexChain([entries[0], gap], { mode: 'synthetic' }), /sequence gap/);
  rejected('SEQUENCE_FORK_DUPLICATE', () => validateIndexChain([entries[0], entries[1], entries[1]], { mode: 'synthetic' }), /sequence gap/);
  const falseChild = createIndexEntry({ ...entries[0].payload,
    childSchema: SCHEMAS.artifact, childSemanticId: artifacts.app.payload.artifactId,
  });
  rejected('INDEX_CHILD_BINDING_MISMATCH', () => validateIndexChain([falseChild], { mode: 'synthetic', objects }), /index child binding mismatch/);
  const wrongSource = sealed({ ...artifacts.app.payload, sourceCommit: 'e'.repeat(40) });
  const sourceRc = sealed({ ...rc.payload, artifactObjectIds: { ...rc.payload.artifactObjectIds, app: wrongSource.objectId } });
  rejected('SOURCE_MISMATCH', () => validateReleaseChain({ build, artifacts: { ...artifacts, app: wrongSource }, decision, rc: sourceRc }, { mode: 'synthetic' }), /source\/artifact mismatch/);
  const wrongExe = sealed({ ...artifacts.executable.payload, digest: `sha256:${'f'.repeat(64)}`, artifactId: `studio-desktop@${version}/artifact/executable/sha256:${'f'.repeat(64)}` });
  const exeRc = sealed({ ...rc.payload, artifactObjectIds: { ...rc.payload.artifactObjectIds, executable: wrongExe.objectId } });
  rejected('EXECUTABLE_DIGEST_MISMATCH', () => validateReleaseChain({ build, artifacts: { ...artifacts, executable: wrongExe }, decision, rc: exeRc }, { mode: 'synthetic' }), /executable digest mismatch/);
  fs.appendFileSync(executablePath, 'MUTATION');
  rejected('APP_DIGEST_MISMATCH', () => verifyArtifactBytes(artifacts.app.payload, appPath), /app digest mismatch/);
  rejected('EXECUTABLE_BYTE_MISMATCH', () => verifyArtifactBytes(artifacts.executable.payload, executablePath), /executable digest mismatch/);
  fs.appendFileSync(dmgPath, 'MUTATION');
  rejected('DMG_DIGEST_MISMATCH', () => verifyArtifactBytes(artifacts.dmg.payload, dmgPath), /dmg digest mismatch/);
  const substitutedRc = sealed({ ...rc.payload, artifactObjectIds: { ...rc.payload.artifactObjectIds, app: github.objectId } });
  rejected('ARTIFACT_SUBSTITUTION', () => validateReleaseChain({ build, artifacts, decision, rc: substitutedRc }, { mode: 'synthetic' }), /artifact substitution/);
  rejected('RC_IDENTITY_MISMATCH', () => sealed({ ...rc.payload, rcId: 'studio-desktop/v0.2.0/rc.1' }), /RC identity mismatch/);
  const wrongDecision = sealed({ ...decision.payload, rcId: `${releaseId}/rc.2` });
  const decisionRc = sealed({ ...rc.payload, decisionObjectId: wrongDecision.objectId });
  rejected('DECISION_REFERENCE_MISMATCH', () => validateReleaseChain({ build, artifacts, decision: wrongDecision, rc: decisionRc }, { mode: 'synthetic' }), /decision-reference mismatch/);
  rejected('UNSAFE_DECISION_LOCATOR', () => sealed({ ...decision.payload, recordPath: 'missions/../other.md' }), /unsafe Management recordPath/);
  rejected('APPROVED_RC_MISMATCH', () => sealed({ ...releaseDecision.payload, rcId: `${releaseId}/rc.2`, releaseId: 'studio-desktop/v0.2.0' }), /approved RC\/decision mismatch/);
  const wrongHosted = sealed({ ...github.payload, assets: [github.payload.assets[0]] });
  rejected('HOSTED_ASSET_MISMATCH', () => validateReleaseEvents({ build, artifacts, rc, releaseDecision, tagDecision, publicationDecision, tag, github: wrongHosted }, { mode: 'synthetic' }), /hosted authority\/asset mismatch/);
  const draftHosted = sealed({ ...github.payload, state: 'draft', publishedAtUtc: null });
  rejected('DRAFT_AS_PUBLICATION', () => validateReleaseEvents({ build, artifacts, rc, releaseDecision, tagDecision, publicationDecision, tag, github: draftHosted, publication }, { mode: 'synthetic' }), /publication needs published hosted state/);
  rejected('INVALID_RELEASE_GRAMMAR', () => validateReleaseId('studio-desktop/v01.0.0'), /releaseId/);
  rejected('INVALID_RC_GRAMMAR', () => validateRcId(`${releaseId}/rc.0`), /rcId/);
  rejected('INVALID_TAG_GRAMMAR', () => validateReleaseTag(`component/${releaseId}/rc.1`), /release tag/);
  const successorReadback = { ...readback, checkpoint: 'SYNTHETIC_CHECKPOINT_2' };
  const successorBuild = sealed(synthetic(SCHEMAS.build, {
    ...successorReadback, packagedReadback: {
      schema: 'h2o.studio.release-evidence.packaged-build-identity.v1', ...successorReadback,
    },
  }));
  const successor = createIndexEntry({
    releaseId, sequence: entries.length + 1, previousEntryDigest: `sha256:${entries.at(-1).digest}`,
    childSchema: SCHEMAS.build, childSemanticId: `studio-desktop@${version}`, childObjectId: successorBuild.objectId,
    synthetic: true, disposition: 'supersede', supersedesObjectId: build.objectId,
  });
  assertCurrentObject([...entries, successor], successorBuild.objectId, { mode: 'synthetic' });
  rejected('SUPERSEDED_AS_CURRENT', () => assertCurrentObject([...entries, successor], build.objectId, { mode: 'synthetic' }), /historical/);
  const withdrawal = createIndexEntry({
    releaseId, sequence: entries.length + 2, previousEntryDigest: `sha256:${successor.digest}`,
    childSchema: SCHEMAS.decision, childSemanticId: releaseId, childObjectId: wrongDecision.objectId,
    synthetic: true, disposition: 'withdraw',
  });
  assert.equal(resolveIndexState([...entries, successor, withdrawal], { mode: 'synthetic' }).withdrawn, true);
  rejected('WITHDRAWN_AS_CURRENT', () => assertCurrentObject([...entries, successor, withdrawal], successorBuild.objectId, { mode: 'synthetic' }), /withdrawn/);
  rejected('SYNTHETIC_AS_REAL_OBJECT', () => verifySealedEvidence(build), /synthetic object presented as real/);
  rejected('SYNTHETIC_AS_REAL_INDEX', () => validateIndexChain(entries, { objects }), /synthetic index presented as real/);
  console.log('SCHEMA_VALIDATION=PASS');
  console.log('SYNTHETIC_AS_REAL_REJECTION=PASS');
  console.log('NEGATIVE_CASES=PASS');
  console.log('NO_GOVERNED_STORE_OR_PUBLICATION=PASS');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
