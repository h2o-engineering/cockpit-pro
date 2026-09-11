import crypto from 'node:crypto';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

class FakeNameList {
  constructor(storeConfigs) {
    this.storeConfigs = storeConfigs;
  }

  contains(name) {
    return this.storeConfigs.has(name);
  }

  [Symbol.iterator]() {
    return this.storeConfigs.keys();
  }
}

class FakeTransaction {
  constructor(factory, record, storeNames, mode) {
    this.factory = factory;
    this.record = record;
    this.storeNames = Array.from(new Set(
      Array.isArray(storeNames) ? storeNames : [storeNames]
    ));
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.aborted = false;
    this.done = false;
    this.started = false;
    this.pending = 0;
    this.queuedRequests = [];
    this.workingStores = new Map();
    this.mutations = new Map();
    for (const name of this.storeNames) {
      if (!record.stores.has(name)) throw new Error('missing-store');
    }
    if (!['readonly', 'readwrite'].includes(mode)) {
      throw new Error('unsupported-transaction-mode');
    }
    factory.registerTransaction(this);
  }

  start() {
    if (this.started || this.aborted || this.done) return;
    this.started = true;
    for (const name of this.storeNames) {
      this.workingStores.set(
        name,
        new Map(clone(Array.from(this.record.stores.get(name))))
      );
      this.mutations.set(name, new Map());
    }
    this.factory.transactionStartLog.push({
      mode: this.mode,
      storeNames: [...this.storeNames]
    });
    for (const queued of this.queuedRequests.splice(0)) {
      this.scheduleRequest(queued);
    }
    this.scheduleCompletion();
  }

  objectStore(name) {
    if (!this.storeNames.includes(name)) throw new Error('store-outside-transaction');
    return new FakeObjectStore(this, name);
  }

  request(operation, storeName, isWrite = false) {
    const request = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null
    };
    this.pending += 1;
    const queued = { request, operation, storeName, isWrite };
    if (this.started) {
      this.scheduleRequest(queued);
    } else {
      this.queuedRequests.push(queued);
    }
    return request;
  }

  scheduleRequest({ request, operation, storeName, isWrite }) {
    setTimeout(() => {
      if (this.aborted) return;
      try {
        if (isWrite && this.factory.failNextWriteStore === storeName) {
          this.factory.failNextWriteStore = null;
          const injected = new Error('injected-write-failure');
          injected.name = 'UnknownError';
          throw injected;
        }
        request.result = operation();
        request.onsuccess?.();
        this.pending -= 1;
        this.scheduleCompletion();
      } catch (error) {
        request.error = error;
        request.onerror?.();
        this.error = error;
        this.abort(error);
      }
    }, 0);
  }

  values(storeName) {
    const values = this.workingStores.get(storeName);
    if (!values) throw new Error('transaction-not-started');
    return values;
  }

  add(storeName, key, value) {
    const values = this.values(storeName);
    if (values.has(key)) {
      const error = new Error('constraint');
      error.name = 'ConstraintError';
      throw error;
    }
    values.set(key, clone(value));
    this.mutations.get(storeName).set(key, {
      kind: 'put',
      value: clone(value)
    });
  }

  put(storeName, key, value) {
    this.values(storeName).set(key, clone(value));
    this.mutations.get(storeName).set(key, {
      kind: 'put',
      value: clone(value)
    });
  }

  delete(storeName, key) {
    this.values(storeName).delete(key);
    this.mutations.get(storeName).set(key, { kind: 'delete' });
  }

  scheduleCompletion() {
    setTimeout(() => {
      if (this.aborted || this.done || this.pending !== 0) return;
      if (this.mode === 'readwrite') {
        for (const [name, changes] of this.mutations) {
          const current = this.record.stores.get(name);
          for (const [key, change] of changes) {
            if (change.kind === 'delete') {
              current.delete(key);
            } else {
              current.set(key, clone(change.value));
            }
          }
        }
      }
      this.done = true;
      this.factory.releaseTransaction(this);
      this.oncomplete?.();
    }, 0);
  }

  abort(error = null) {
    if (this.aborted || this.done) return;
    this.aborted = true;
    this.error = error ||
      Object.assign(new Error('transaction-aborted'), { name: 'AbortError' });
    setTimeout(() => {
      this.factory.releaseTransaction(this);
      this.onerror?.();
      this.onabort?.();
    }, 0);
  }
}

class FakeObjectStore {
  constructor(transaction, name) {
    this.transaction = transaction;
    this.name = name;
    this.keyPath = transaction.record.storeConfigs.get(name).keyPath;
  }

  get(key) {
    return this.transaction.request(
      () => clone(this.transaction.values(this.name).get(key)),
      this.name
    );
  }

  getAll() {
    return this.transaction.request(
      () => clone(Array.from(this.transaction.values(this.name).values())),
      this.name
    );
  }

  count() {
    return this.transaction.request(
      () => this.transaction.values(this.name).size,
      this.name
    );
  }

  add(value) {
    return this.transaction.request(() => {
      const key = value[this.keyPath];
      this.transaction.add(this.name, key, value);
      return key;
    }, this.name, true);
  }

  put(value) {
    return this.transaction.request(() => {
      const key = value[this.keyPath];
      this.transaction.put(this.name, key, value);
      return key;
    }, this.name, true);
  }

  delete(key) {
    return this.transaction.request(() => {
      this.transaction.delete(this.name, key);
      return undefined;
    }, this.name, true);
  }
}

class FakeDatabase {
  constructor(factory, record) {
    this.factory = factory;
    this.record = record;
    this.version = record.version;
    this.objectStoreNames = new FakeNameList(record.storeConfigs);
    this.closed = false;
    this.onversionchange = null;
    factory.connections.add(this);
  }

  createObjectStore(name, options = {}) {
    if (this.record.storeConfigs.has(name)) throw new Error('duplicate-store');
    this.record.storeConfigs.set(name, { keyPath: options.keyPath });
    this.record.stores.set(name, new Map());
    return { name };
  }

  transaction(storeNames, mode) {
    if (this.closed) throw new Error('database-closed');
    return new FakeTransaction(this.factory, this.record, storeNames, mode);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.factory.closedConnectionCount += 1;
    this.factory.connections.delete(this);
  }
}

export class FakeIndexedDBFactory {
  constructor() {
    this.records = new Map();
    this.connections = new Set();
    this.activeTransactions = new Set();
    this.queuedTransactions = [];
    this.transactionStartLog = [];
    this.failNextWriteStore = null;
    this.blockNextOpenWithLateSuccess = false;
    this.openCount = 0;
    this.closedConnectionCount = 0;
    this.lastOpenedDatabase = null;
  }

  transactionsConflict(left, right) {
    if (left.record !== right.record) return false;
    const overlapping = left.storeNames.some((name) =>
      right.storeNames.includes(name));
    return overlapping &&
      (left.mode === 'readwrite' || right.mode === 'readwrite');
  }

  registerTransaction(transaction) {
    this.queuedTransactions.push(transaction);
    this.startEligibleTransactions();
  }

  releaseTransaction(transaction) {
    this.activeTransactions.delete(transaction);
    const queuedIndex = this.queuedTransactions.indexOf(transaction);
    if (queuedIndex >= 0) this.queuedTransactions.splice(queuedIndex, 1);
    this.startEligibleTransactions();
  }

  startEligibleTransactions() {
    let index = 0;
    while (index < this.queuedTransactions.length) {
      const transaction = this.queuedTransactions[index];
      const blocked = Array.from(this.activeTransactions).some((active) =>
        this.transactionsConflict(active, transaction));
      if (blocked) {
        index += 1;
        continue;
      }
      this.queuedTransactions.splice(index, 1);
      this.activeTransactions.add(transaction);
      transaction.start();
    }
  }

  open(name, version) {
    this.openCount += 1;
    const request = {
      result: null,
      error: null,
      transaction: null,
      onupgradeneeded: null,
      onblocked: null,
      onerror: null,
      onsuccess: null
    };
    const complete = () => {
      const existing = this.records.get(name);
      if (existing && existing.version > version) {
        request.error = Object.assign(
          new Error('future-version'),
          { name: 'VersionError' }
        );
        request.onerror?.();
        return;
      }
      const oldVersion = existing?.version || 0;
      const upgrading = oldVersion < version;
      const record = existing && !upgrading
        ? existing
        : existing
          ? {
            version,
            storeConfigs: new Map(clone(Array.from(existing.storeConfigs))),
            stores: new Map(Array.from(existing.stores, ([key, value]) => [
              key,
              new Map(clone(Array.from(value)))
            ]))
          }
          : { version, storeConfigs: new Map(), stores: new Map() };
      const database = new FakeDatabase(this, record);
      this.lastOpenedDatabase = database;
      request.result = database;
      if (upgrading) {
        let aborted = false;
        request.transaction = {
          error: null,
          abort() {
            aborted = true;
            this.error = Object.assign(
              new Error('upgrade-aborted'),
              { name: 'AbortError' }
            );
          }
        };
        request.onupgradeneeded?.({ oldVersion, newVersion: version });
        if (aborted) {
          database.close();
          request.error = request.transaction.error;
          request.onerror?.();
          return;
        }
      }
      this.records.set(name, record);
      request.onsuccess?.();
    };

    setTimeout(() => {
      if (this.blockNextOpenWithLateSuccess) {
        this.blockNextOpenWithLateSuccess = false;
        request.onblocked?.();
        setTimeout(complete, 0);
        return;
      }
      complete();
    }, 0);
    return request;
  }

  seedFutureVersion(name, version) {
    this.records.set(name, {
      version,
      storeConfigs: new Map(),
      stores: new Map()
    });
  }

  triggerVersionChange() {
    for (const database of Array.from(this.connections)) {
      database.onversionchange?.({ oldVersion: database.version });
    }
  }

  deleteStoreEntry(databaseName, storeName, key) {
    this.records.get(databaseName)?.stores.get(storeName)?.delete(key);
  }

  updateFirstStoreEntry(databaseName, storeName, update) {
    const values = this.records.get(databaseName)?.stores.get(storeName);
    if (!values) return false;
    const first = values.entries().next();
    if (first.done) return false;
    const [key, value] = first.value;
    values.set(key, update(clone(value)));
    return true;
  }

  storeSize(databaseName, storeName) {
    return this.records.get(databaseName)?.stores.get(storeName)?.size || 0;
  }

  serialized() {
    return JSON.stringify(Array.from(this.records, ([databaseName, record]) => ({
      databaseName,
      version: record.version,
      stores: Array.from(record.stores, ([storeName, values]) => ({
        storeName,
        values: Array.from(values.values())
      }))
    })));
  }
}

export function chromeIdentity(
  installId = '11111111-2222-4333-8444-555555555555'
) {
  return {
    schema: 'h2o.studio.peer-identity.v1',
    installId,
    physicalDeviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    syncPeerId: `studio-chrome:mv3-chrome:idb-archive:${installId}`,
    surfaceKind: 'studio-chrome',
    appKind: 'mv3-chrome',
    storeKind: 'idb-archive',
    displayName: 'studio-chrome (idb-archive)',
    createdAt: '2026-07-30T10:00:00.000Z',
    updatedAt: '2026-07-30T10:00:00.000Z',
    surfaceHistory: []
  };
}

export function identityProvider(value) {
  return {
    async whenSyncReady() {
      return value;
    }
  };
}

export async function hashBytes(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : new TextEncoder().encode(value);
  const digest = await crypto.webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}
