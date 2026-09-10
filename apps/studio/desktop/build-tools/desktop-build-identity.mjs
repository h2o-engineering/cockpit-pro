const CHECKPOINT_PATTERN = /^[A-Z][A-Z0-9]*(?:[._-][A-Z0-9]+)*$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function requiredText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`[tauri-build] ${label} is required`);
  return normalized;
}

export function createGovernedDesktopBuildIdentity({ checkpoint, sourceCommit, builtAt }) {
  const normalizedCheckpoint = requiredText(checkpoint, 'H2O_STUDIO_BUILD_CHECKPOINT');
  if (!CHECKPOINT_PATTERN.test(normalizedCheckpoint)) {
    throw new Error('[tauri-build] H2O_STUDIO_BUILD_CHECKPOINT must be an uppercase build checkpoint token');
  }

  const normalizedSourceCommit = requiredText(sourceCommit, 'source commit').toLowerCase();
  if (!SOURCE_COMMIT_PATTERN.test(normalizedSourceCommit)) {
    throw new Error('[tauri-build] source commit must be the exact 40-character Git HEAD');
  }

  const normalizedBuiltAt = requiredText(builtAt, 'build timestamp');
  if (!Number.isFinite(Date.parse(normalizedBuiltAt))) {
    throw new Error('[tauri-build] build timestamp must be an ISO-8601 timestamp');
  }

  return Object.freeze({
    checkpoint: normalizedCheckpoint,
    sourceCommit: normalizedSourceCommit,
    builtAt: normalizedBuiltAt,
  });
}

export function governedDesktopBuildEnvironment(baseEnvironment, identity) {
  return {
    ...baseEnvironment,
    H2O_STUDIO_BUILD_CHECKPOINT: identity.checkpoint,
    H2O_STUDIO_BUILD_SOURCE_COMMIT: identity.sourceCommit,
    H2O_STUDIO_BUILD_TIMESTAMP: identity.builtAt,
    H2O_STUDIO_BUILD_GOVERNED: 'true',
  };
}
