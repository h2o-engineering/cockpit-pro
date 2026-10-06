import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_SNAPSHOT = 'h2o.identity.snapshot.v1';
const KEY_AUDIT = 'h2o.identity.audit.v1';
const KEY_SESSION_META = 'h2o.identity.session-meta.v1';

const SENSITIVE_KEYS = new Set([
  'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token',
  'rawSession', 'rawUser', 'rawEmail', 'providerIdentity', 'identity_data',
  'currentPassword', 'current_password', 'newPassword', 'confirmPassword',
  'owner_user_id', 'deleted_at', 'password', 'token', 'secret', 'credential',
]);

export function sanitizeForPersistence<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeForPersistence) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!SENSITIVE_KEYS.has(k)) out[k] = sanitizeForPersistence(v);
    }
    return out as T;
  }
  return value;
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(sanitizeForPersistence(value)));
}

async function clearKey(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // already absent — safe to ignore
  }
}

export async function readMobileStorageItem(key: string): Promise<string | null> {
  return AsyncStorage.getItem(key);
}

export async function writeMobileStorageJson(key: string, value: unknown): Promise<void> {
  await writeJson(key, value);
}

export async function removeMobileStorageItem(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}

export async function readSnapshot(): Promise<unknown | null> {
  return readJson(KEY_SNAPSHOT);
}

export async function writeSnapshot(snapshot: unknown): Promise<void> {
  await writeJson(KEY_SNAPSHOT, snapshot);
}

export async function clearSnapshot(): Promise<void> {
  await clearKey(KEY_SNAPSHOT);
}

export async function readAudit(): Promise<unknown[]> {
  const result = await readJson<unknown[]>(KEY_AUDIT);
  return Array.isArray(result) ? result : [];
}

export async function writeAudit(audit: unknown[]): Promise<void> {
  await writeJson(KEY_AUDIT, audit);
}

export async function clearAudit(): Promise<void> {
  await clearKey(KEY_AUDIT);
}

export async function readSessionMeta(): Promise<unknown | null> {
  return readJson(KEY_SESSION_META);
}

export async function writeSessionMeta(meta: unknown): Promise<void> {
  await writeJson(KEY_SESSION_META, meta);
}

export async function clearSessionMeta(): Promise<void> {
  await clearKey(KEY_SESSION_META);
}

export async function clearAllIdentityStorage(): Promise<void> {
  await Promise.all([clearSnapshot(), clearAudit(), clearSessionMeta()]);
}
