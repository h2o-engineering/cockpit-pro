/*
 * P02 — stage the packed module graph for validation.
 *
 * Desktop surface modules are copied VERBATIM into the packed tree, so their
 * relative imports are written for the PACKED layout (../core/, and
 * ../browser-adapters/chrome/), not for the repository layout. That is the
 * packer's documented contract and the reason it rewrites no specifier.
 *
 * A validator that wants to exercise one of those modules therefore has to
 * present it with the layout it was written for. This stages that layout in a
 * temporary directory from the real repository sources, so what gets imported
 * is byte-identical to what ships.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

export const P02_PACKED_LAYOUT = Object.freeze({
  'sync': Object.freeze([
    'src-surfaces-base/studio/sync/sync-object-enumerator-v2.tauri.mjs',
    'src-surfaces-base/studio/sync/sync-first-publication-desktop-v2.tauri.mjs',
    'src-surfaces-base/studio/sync/sync-writer-storage-desktop-v2.tauri.mjs',
    'src-surfaces-base/studio/sync/sync-p02-revision-proof.tauri.mjs',
    'src-surfaces-base/studio/sync/sync-object-runtime-v2.desktop.mjs',
    'src-surfaces-base/studio/sync/sync-branch-evidence-desktop-v2.tauri.mjs',
    'src-surfaces-base/studio/sync/sync-p02-tip-memo-desktop-v2.tauri.mjs',
    'src-surfaces-base/studio/sync/sync-writer-generation-desktop-v2.tauri.mjs',
    'src-surfaces-base/studio/sync/sync-reverse-desktop-v2.tauri.mjs',
  ]),
  'core': Object.freeze([
    'packages/core/sync-p02-anchor-set-v2.mjs',
    'packages/core/sync-p02-revision-mint-v2.mjs',
    'packages/core/sync-p02-verified-tip-memo-v2.mjs',
    'packages/core/sync-p02-heads-merge-v2.mjs',
    'packages/core/sync-p02-descendant-publication-v2.mjs',
    'packages/core/sync-object-reconcile-v2.mjs',
    'packages/core/sync-object-apply-v2.mjs',
    'packages/core/sync-steady-publication-v2.mjs',
    'packages/core/sync-steady-driver-v2.mjs',
    'packages/core/sync-writer-generation-v2.mjs',
    'packages/core/sync-p02-peer-roster-v2.mjs',
    'packages/core/sync-p02-legacy-baseline-observer-v2.mjs',
    'packages/core/sync-object-classifier-v2.mjs',
    'packages/core/sync-object-projection.mjs',
    'packages/core/sync-object-runtime-v2.mjs',
    'packages/core/sync-format-gate-v2.mjs',
    'packages/core/sync-evidence-capacity-v2.mjs',
    'packages/core/sync-branch-evidence-v2.mjs',
    'packages/core/sync-object-scheduler-v2.mjs',
    'packages/core/sync-repository-root-v2.mjs',
    'packages/core/sync-first-publication-candidates-v2.mjs',
    'packages/core/sync-first-publication-composition-v2.mjs',
  ]),
  'browser-adapters/chrome': Object.freeze([
    'packages/browser-adapters/chrome/sync-contract-v2.mjs',
    'packages/browser-adapters/chrome/sync-revision-production-v2.mjs',
    'packages/browser-adapters/chrome/sync-revision-domain-chat-v2.mjs',
    'packages/browser-adapters/chrome/sync-reader-transport-v2.mjs',
    'packages/browser-adapters/chrome/sync-writer-transport-v2.mjs',
    'packages/browser-adapters/chrome/sync-branch-admission-v2.mjs',
    'packages/browser-adapters/chrome/sync-fsa-read-transport-v2.mjs',
    'packages/browser-adapters/chrome/sync-p02-tip-memo-chrome-v2.mjs',
    'packages/browser-adapters/chrome/sync-writer-generation-chrome-v2.mjs',
    'packages/browser-adapters/chrome/sync-revision-apply-v2.mjs',
  ]),
});

/* Returns a disposable directory shaped exactly like the packed tree. */
export function stagePackedGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p02-packed-'));
  for (const [sub, files] of Object.entries(P02_PACKED_LAYOUT)) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (const rel of files) {
      const source = path.join(repo, rel);
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, path.join(dir, sub, path.basename(rel)));
    }
  }
  return {
    dir,
    importPacked: (relInPack) => import(pathToFileURL(path.join(dir, relInPack)).href),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
