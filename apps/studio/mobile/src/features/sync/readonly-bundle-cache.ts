import {
  readMobileStorageItem,
  writeMobileStorageJson,
  removeMobileStorageItem,
} from "../../identity/mobileStorage";

import type { MobileBundleDiagnostic } from "./latest-bundle-reader";

export const READ_ONLY_BUNDLE_CACHE_SCHEMA = "h2o.mobile.readonly.bundle-cache.v1";
export const READ_ONLY_BUNDLE_CACHE_KEY = READ_ONLY_BUNDLE_CACHE_SCHEMA;

export type MobileReadOnlyBundleCacheSourceKind = "pasted-json" | "latest-json";

export type MobileReadOnlyBundleCacheWarning = {
  code: string;
};

export type MobileReadOnlyBundleCacheMetadata = {
  schema: typeof READ_ONLY_BUNDLE_CACHE_SCHEMA;
  readOnly: true;
  nonAuthoritative: true;
  cachedAt: string;
  sourceKind: MobileReadOnlyBundleCacheSourceKind;
  sourceSchemaPresent: boolean;
  exportedAtPresent: boolean;
  checksumPresent: boolean;
  checksumVerified?: boolean;
  sourcePeerPresent: boolean;
  counts: {
    chats: number;
    snapshots: number;
    folders: number;
    folderMemberships: number;
    labels: number;
    categories: number;
    tombstones: number;
    conflicts: number;
    applyEvents: number;
  };
  warnings: MobileReadOnlyBundleCacheWarning[];
};

export function buildReadOnlyBundleCacheMetadata(args: {
  diagnostic: MobileBundleDiagnostic;
  sourceKind: MobileReadOnlyBundleCacheSourceKind;
  cachedAt?: string;
}): MobileReadOnlyBundleCacheMetadata {
  return {
    schema: READ_ONLY_BUNDLE_CACHE_SCHEMA,
    readOnly: true,
    nonAuthoritative: true,
    cachedAt: nonEmptyString(args.cachedAt) ?? new Date().toISOString(),
    sourceKind: args.sourceKind,
    sourceSchemaPresent: args.diagnostic.source.schemaPresent === true,
    exportedAtPresent: args.diagnostic.source.exportedAtPresent === true,
    checksumPresent: args.diagnostic.source.checksumPresent === true,
    checksumVerified: args.diagnostic.source.checksumVerified === true,
    sourcePeerPresent: args.diagnostic.source.sourcePeerPresent === true,
    counts: normalizeCounts(args.diagnostic.counts),
    warnings: normalizeWarnings([
      ...args.diagnostic.blockers,
      ...args.diagnostic.warnings,
    ]),
  };
}

export async function saveReadOnlyBundleCacheMetadata(
  metadata: MobileReadOnlyBundleCacheMetadata,
): Promise<{ ok: boolean; warnings: MobileReadOnlyBundleCacheWarning[] }> {
  const normalized = normalizeCacheMetadata(metadata);
  if (!normalized) {
    return {
      ok: false,
      warnings: [{ code: "readonly-cache-metadata-invalid" }],
    };
  }

  try {
    await writeMobileStorageJson(READ_ONLY_BUNDLE_CACHE_KEY, normalized);
    return { ok: true, warnings: [] };
  } catch {
    return {
      ok: false,
      warnings: [{ code: "readonly-cache-save-failed" }],
    };
  }
}

export async function loadReadOnlyBundleCacheMetadata(): Promise<{
  ok: boolean;
  found: boolean;
  metadata: MobileReadOnlyBundleCacheMetadata | null;
  warnings: MobileReadOnlyBundleCacheWarning[];
}> {
  let raw: string | null;
  try {
    raw = await readMobileStorageItem(READ_ONLY_BUNDLE_CACHE_KEY);
  } catch {
    return {
      ok: false,
      found: false,
      metadata: null,
      warnings: [{ code: "readonly-cache-load-failed" }],
    };
  }

  if (raw === null) {
    return {
      ok: true,
      found: false,
      metadata: null,
      warnings: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      found: false,
      metadata: null,
      warnings: [{ code: "readonly-cache-malformed" }],
    };
  }

  if (isRecord(parsed) && parsed.schema !== READ_ONLY_BUNDLE_CACHE_SCHEMA) {
    return {
      ok: false,
      found: false,
      metadata: null,
      warnings: [{ code: "readonly-cache-schema-unsupported" }],
    };
  }

  const metadata = normalizeCacheMetadata(parsed);
  if (!metadata) {
    return {
      ok: false,
      found: false,
      metadata: null,
      warnings: [{ code: "readonly-cache-malformed" }],
    };
  }

  return {
    ok: true,
    found: true,
    metadata,
    warnings: [],
  };
}

export async function clearReadOnlyBundleCacheMetadata(): Promise<{
  ok: boolean;
  warnings: MobileReadOnlyBundleCacheWarning[];
}> {
  try {
    await removeMobileStorageItem(READ_ONLY_BUNDLE_CACHE_KEY);
    return { ok: true, warnings: [] };
  } catch {
    return {
      ok: false,
      warnings: [{ code: "readonly-cache-clear-failed" }],
    };
  }
}

function normalizeCacheMetadata(value: unknown): MobileReadOnlyBundleCacheMetadata | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.schema !== READ_ONLY_BUNDLE_CACHE_SCHEMA) {
    return null;
  }
  if (value.readOnly !== true || value.nonAuthoritative !== true) {
    return null;
  }
  const cachedAt = nonEmptyString(value.cachedAt);
  const sourceKind = normalizeSourceKind(value.sourceKind);
  if (!cachedAt || !sourceKind) {
    return null;
  }
  if (!isRecord(value.counts)) {
    return null;
  }

  const metadata: MobileReadOnlyBundleCacheMetadata = {
    schema: READ_ONLY_BUNDLE_CACHE_SCHEMA,
    readOnly: true,
    nonAuthoritative: true,
    cachedAt,
    sourceKind,
    sourceSchemaPresent: value.sourceSchemaPresent === true,
    exportedAtPresent: value.exportedAtPresent === true,
    checksumPresent: value.checksumPresent === true,
    checksumVerified: value.checksumVerified === true,
    sourcePeerPresent: value.sourcePeerPresent === true,
    counts: normalizeCounts(value.counts),
    warnings: normalizeWarnings(Array.isArray(value.warnings) ? value.warnings : []),
  };
  return metadata;
}

function normalizeCounts(value: unknown): MobileReadOnlyBundleCacheMetadata["counts"] {
  const record = isRecord(value) ? value : {};
  return {
    chats: safeCount(record.chats),
    snapshots: safeCount(record.snapshots),
    folders: safeCount(record.folders),
    folderMemberships: safeCount(record.folderMemberships),
    labels: safeCount(record.labels),
    categories: safeCount(record.categories),
    tombstones: safeCount(record.tombstones),
    conflicts: safeCount(record.conflicts),
    applyEvents: safeCount(record.applyEvents),
  };
}

function normalizeWarnings(values: unknown[]): MobileReadOnlyBundleCacheWarning[] {
  const warnings: MobileReadOnlyBundleCacheWarning[] = [];
  for (const value of values) {
    if (!isRecord(value)) {
      continue;
    }
    const code = nonEmptyString(value.code);
    if (!code || warnings.some((warning) => warning.code === code)) {
      continue;
    }
    warnings.push({ code });
  }
  return warnings;
}

function normalizeSourceKind(value: unknown): MobileReadOnlyBundleCacheSourceKind | null {
  return value === "pasted-json" || value === "latest-json" ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
