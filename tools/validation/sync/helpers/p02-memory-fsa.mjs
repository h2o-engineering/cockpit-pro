/* In-memory File System Access fixture shared by existing P02 validators.
 * It models handles, resolve(), byte writes, and same-filesystem move without
 * touching a real profile or repository. */

class NotFoundError extends Error {
  constructor() { super('not found'); this.name = 'NotFoundError'; }
}

class DirectoryNode {
  constructor(name, parent = null) {
    this.kind = 'directory'; this.name = name; this.parent = parent;
    this.children = new Map();
  }
}

class FileNode {
  constructor(name, parent, bytes = new Uint8Array()) {
    this.kind = 'file'; this.name = name; this.parent = parent;
    this.bytes = new Uint8Array(bytes);
  }
}

class FileHandle {
  constructor(node, fixture) {
    this.kind = 'file'; this.name = node.name; this.node = node; this.fixture = fixture;
  }
  async getFile() {
    const bytes = new Uint8Array(this.node.bytes);
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(0) };
  }
  async createWritable() {
    const node = this.node;
    const fixture = this.fixture;
    let proposed = null;
    return {
      async write(value) { proposed = new Uint8Array(value); },
      async close() {
        if (!(proposed instanceof Uint8Array)) throw new Error('fixture-write-missing');
        node.bytes = proposed;
        fixture.events.push(`write:${fixture.pathOf(node)}`);
      },
      async abort() { proposed = null; }
    };
  }
  async move(destination, name) {
    const destinationPath = `${this.fixture.pathOf(destination.node)}/${name}`;
    if (this.fixture.failMovePath === destinationPath) {
      throw Object.assign(new Error('fixture-move-failed'), { code: 'EIO' });
    }
    this.node.parent.children.delete(this.node.name);
    this.node.parent = destination.node;
    this.node.name = name;
    destination.node.children.set(name, this.node);
    this.name = name;
    this.fixture.events.push(`promote:${destinationPath}`);
  }
}

class DirectoryHandle {
  constructor(node, fixture) {
    this.kind = 'directory'; this.name = node.name; this.node = node;
    this.fixture = fixture;
  }
  async queryPermission({ mode } = {}) {
    this.fixture.events.push(`permission:${mode || ''}`);
    return this.fixture.permission;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    let child = this.node.children.get(name);
    if (!child && create) {
      child = new DirectoryNode(name, this.node);
      this.node.children.set(name, child);
    }
    if (!child || child.kind !== 'directory') throw new NotFoundError();
    return new DirectoryHandle(child, this.fixture);
  }
  async getFileHandle(name, { create = false } = {}) {
    let child = this.node.children.get(name);
    if (!child && create) {
      child = new FileNode(name, this.node);
      this.node.children.set(name, child);
    }
    if (!child || child.kind !== 'file') throw new NotFoundError();
    return new FileHandle(child, this.fixture);
  }
  async resolve(handle) {
    const parts = [];
    let cursor = handle?.node;
    while (cursor && cursor !== this.node) {
      parts.unshift(cursor.name);
      cursor = cursor.parent;
    }
    return cursor === this.node ? parts : null;
  }
}

export function createMemoryFsa({ permission = 'granted' } = {}) {
  const root = new DirectoryNode('container');
  const fixture = {
    root, permission, events: [], failMovePath: null,
    pathOf(node) {
      const parts = [];
      let cursor = node;
      while (cursor && cursor !== root) { parts.unshift(cursor.name); cursor = cursor.parent; }
      return parts.join('/');
    },
    put(path, bytes) {
      const parts = path.split('/');
      const name = parts.pop();
      let cursor = root;
      for (const part of parts) {
        let child = cursor.children.get(part);
        if (!child) {
          child = new DirectoryNode(part, cursor);
          cursor.children.set(part, child);
        }
        if (child.kind !== 'directory') throw new Error('fixture-path-conflict');
        cursor = child;
      }
      cursor.children.set(name, new FileNode(name, cursor, bytes));
    },
    read(path) {
      let cursor = root;
      for (const part of path.split('/')) {
        cursor = cursor?.children?.get(part);
        if (!cursor) return null;
      }
      return cursor.kind === 'file' ? new Uint8Array(cursor.bytes) : null;
    },
    has(path) { return this.read(path) !== null; },
    listFiles() {
      const found = [];
      const walk = (node) => {
        for (const child of node.children.values()) {
          if (child.kind === 'file') found.push(this.pathOf(child));
          else walk(child);
        }
      };
      walk(root);
      return found.sort();
    }
  };
  fixture.handle = new DirectoryHandle(root, fixture);
  return fixture;
}
