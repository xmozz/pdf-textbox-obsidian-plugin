import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  type PdfTextboxAnnotation,
} from "../src/core";
import {
  PdfTextboxStore,
  type StoreHost,
  type VaultFileSystem,
} from "../src/store";

const PLUGIN_DIR = ".obsidian/plugins/pdf-textbox";
const SHARD_DIR = `${PLUGIN_DIR}/annotations`;

class MemoryFs implements VaultFileSystem {
  readonly files = new Map<string, string>();
  failWrites: ((path: string) => boolean) | null = null;
  readCount = 0;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.hasFolder(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    this.readCount += 1;
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    if (this.failWrites?.(path)) throw new Error(`EACCES: ${path}`);
    this.files.set(path, data);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const value = this.files.get(oldPath);
    if (value === undefined) throw new Error(`ENOENT: ${oldPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, value);
  }

  async mkdir(_path: string): Promise<void> {
    // Folders are implicit in the in-memory file map.
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const files: string[] = [];
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      if (file.slice(prefix.length).includes("/")) continue;
      files.push(file);
    }
    return { files, folders: [] };
  }

  private hasFolder(path: string): boolean {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) return true;
    }
    return false;
  }
}

function annotation(
  id: string,
  file: string,
  page = 1,
  text = `Text ${id}`,
  overrides: Partial<PdfTextboxAnnotation> = {},
): PdfTextboxAnnotation {
  return {
    id,
    file,
    page,
    nx: 0.1,
    ny: 0.1,
    nw: 0.25,
    nh: 0.08,
    rotation: 0,
    text,
    fontSize: 12,
    color: "#ffd54f",
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function legacyData(annotations: PdfTextboxAnnotation[]): unknown {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    annotations,
  };
}

function createHost(fs: MemoryFs, initial: unknown) {
  const notices: string[] = [];
  let data = initial;
  const host: StoreHost = {
    fs,
    pluginDir: PLUGIN_DIR,
    loadData: async () => data,
    saveData: async (next) => {
      data = next;
    },
    notify: (message) => notices.push(message),
  };
  return {
    host,
    notices,
    getData: () => data,
  };
}

async function shardFiles(fs: MemoryFs): Promise<string[]> {
  const listed = await fs.list(SHARD_DIR);
  return listed.files.sort();
}

test("migrates v1 annotations into per-PDF shards", async () => {
  const fs = new MemoryFs();
  const legacy = legacyData([
    annotation("a", "Folder/Doc.pdf", 1),
    annotation("b", "Folder/Doc.pdf", 2),
    annotation("c", "Other.pdf", 1),
  ]);
  const { host, notices, getData } = createHost(fs, legacy);
  const store = new PdfTextboxStore(host);

  const status = await store.initialize();

  assert.equal(status.migrated, true);
  assert.equal(status.legacy, false);
  assert.ok(fs.files.has(`${PLUGIN_DIR}/data.json.v1.bak`));

  const data = getData() as {
    version: number;
    annotations: unknown[];
    shards: Record<string, string>;
  };
  assert.equal(data.version, 2);
  assert.deepEqual(data.annotations, []);
  assert.deepEqual(Object.keys(data.shards).sort(), [
    "Folder/Doc.pdf",
    "Other.pdf",
  ]);
  assert.equal((await shardFiles(fs)).length, 2);

  await store.ensureLoaded("Folder/Doc.pdf");
  assert.equal(store.countForFile("Folder/Doc.pdf"), 2);
  assert.equal(store.annotationsForPage("Folder/Doc.pdf", 1).length, 1);
  assert.equal(store.annotationsForPage("Folder/Doc.pdf", 2).length, 1);

  await store.ensureLoaded("Other.pdf");
  assert.equal(store.countForFile("Other.pdf"), 1);
});

test("a migrated store reloads without rewriting shards", async () => {
  const fs = new MemoryFs();
  const legacy = legacyData([annotation("a", "Doc.pdf", 1)]);
  const first = createHost(fs, legacy);
  const store = new PdfTextboxStore(first.host);
  await store.initialize();

  const shardPath = (await shardFiles(fs))[0];
  assert.ok(shardPath);
  const before = fs.files.get(shardPath);

  const second = createHost(fs, first.getData());
  const reloaded = new PdfTextboxStore(second.host);
  const status = await reloaded.initialize();

  assert.equal(status.migrated, false);
  assert.equal(status.legacy, false);
  assert.equal(fs.files.get(shardPath), before);

  await reloaded.ensureLoaded("Doc.pdf");
  assert.equal(reloaded.countForFile("Doc.pdf"), 1);
});

test("normal startup lists shards but does not read them", async () => {
  const fs = new MemoryFs();
  const first = createHost(
    fs,
    legacyData([
      annotation("a", "One.pdf", 1),
      annotation("b", "Two.pdf", 1),
    ]),
  );
  const store = new PdfTextboxStore(first.host);
  await store.initialize();

  fs.readCount = 0;
  const second = createHost(fs, first.getData());
  const lazy = new PdfTextboxStore(second.host);
  await lazy.initialize();

  assert.equal(fs.readCount, 0);
  assert.equal(lazy.isLoaded("One.pdf"), false);
  assert.equal(lazy.isLoaded("Two.pdf"), false);

  await lazy.ensureLoaded("One.pdf");
  assert.equal(fs.readCount, 1);
  assert.equal(lazy.countForFile("One.pdf"), 1);
  assert.equal(lazy.isLoaded("Two.pdf"), false);
});

test("startup reads only orphan shards when the index is present", async () => {
  const fs = new MemoryFs();
  const first = createHost(fs, legacyData([annotation("a", "One.pdf", 1)]));
  const store = new PdfTextboxStore(first.host);
  await store.initialize();

  const orphanPath = `${SHARD_DIR}/orphan-Two.json`;
  fs.files.set(
    orphanPath,
    JSON.stringify({
      version: 2,
      file: "Two.pdf",
      annotations: [annotation("b", "Two.pdf", 1, "Orphan box")],
    }),
  );

  fs.readCount = 0;
  const second = createHost(fs, first.getData());
  const recovered = new PdfTextboxStore(second.host);
  const status = await recovered.initialize();

  assert.equal(status.rebuiltIndex, true);
  assert.equal(fs.readCount, 1);
  await recovered.ensureLoaded("Two.pdf");
  assert.equal(recovered.countForFile("Two.pdf"), 1);
});

test("adding, editing and removing boxes writes only that PDF's shard", async () => {
  const fs = new MemoryFs();
  const { host, getData } = createHost(
    fs,
    legacyData([
      annotation("a", "One.pdf", 1),
      annotation("b", "Two.pdf", 1),
    ]),
  );
  const store = new PdfTextboxStore(host);
  await store.initialize();
  await store.ensureLoaded("One.pdf");

  const twoShard = (await shardFiles(fs)).find((path) => path.includes("Two"));
  const beforeTwo = twoShard ? fs.files.get(twoShard) : undefined;

  store.add("One.pdf", annotation("new", "One.pdf", 2, "New box"));
  store.touch("One.pdf");
  await store.flush();

  assert.equal(store.countForFile("One.pdf"), 2);
  if (twoShard) assert.equal(fs.files.get(twoShard), beforeTwo);

  const data = getData() as { version: number; annotations: unknown[] };
  assert.equal(data.version, 2);
  assert.deepEqual(data.annotations, []);

  const reloadedHost = createHost(fs, getData());
  const reloaded = new PdfTextboxStore(reloadedHost.host);
  await reloaded.initialize();
  await reloaded.ensureLoaded("One.pdf");
  assert.equal(reloaded.countForFile("One.pdf"), 2);
  assert.equal(reloaded.annotationsForPage("One.pdf", 2)[0]?.id, "new");
});

test("rebuilds a missing index from shard files", async () => {
  const fs = new MemoryFs();
  const legacy = legacyData([
    annotation("a", "Doc.pdf", 1),
    annotation("b", "Other.pdf", 2),
  ]);
  const first = createHost(fs, legacy);
  const store = new PdfTextboxStore(first.host);
  await store.initialize();

  const data = first.getData() as Record<string, unknown>;
  data.shards = {};

  const second = createHost(fs, data);
  const rebuilt = new PdfTextboxStore(second.host);
  const status = await rebuilt.initialize();

  assert.equal(status.rebuiltIndex, true);
  await rebuilt.ensureLoaded("Doc.pdf");
  assert.equal(rebuilt.countForFile("Doc.pdf"), 1);
  await rebuilt.ensureLoaded("Other.pdf");
  assert.equal(rebuilt.countForFile("Other.pdf"), 1);
});

test("merges downgrade residue into existing shards", async () => {
  const fs = new MemoryFs();
  const first = createHost(
    fs,
    legacyData([annotation("a", "Doc.pdf", 1, "Original")]),
  );
  const store = new PdfTextboxStore(first.host);
  await store.initialize();

  const data = first.getData() as {
    version: number;
    annotations: PdfTextboxAnnotation[];
    shards: Record<string, string>;
  };
  data.annotations = [
    annotation("a", "Doc.pdf", 1, "Edited while downgraded", { updatedAt: 99 }),
    annotation("b", "Doc.pdf", 2, "New while downgraded", { updatedAt: 99 }),
  ];

  const second = createHost(fs, data);
  const merged = new PdfTextboxStore(second.host);
  const status = await merged.initialize();

  assert.equal(status.migrated, true);
  await merged.ensureLoaded("Doc.pdf");
  assert.equal(merged.countForFile("Doc.pdf"), 2);
  assert.equal(merged.annotationsForPage("Doc.pdf", 1)[0]?.text, "Edited while downgraded");

  const saved = second.getData() as { annotations: unknown[] };
  assert.deepEqual(saved.annotations, []);
});

test("keeps downgrade residue safe when the merge write fails", async () => {
  const fs = new MemoryFs();
  const first = createHost(
    fs,
    legacyData([annotation("a", "Doc.pdf", 1, "Original")]),
  );
  const store = new PdfTextboxStore(first.host);
  await store.initialize();

  const data = first.getData() as {
    version: number;
    annotations: PdfTextboxAnnotation[];
    shards: Record<string, string>;
  };
  data.annotations = [
    annotation("b", "Doc.pdf", 2, "Residue while downgraded"),
  ];

  fs.failWrites = (path) => path.includes("/annotations/");
  const second = createHost(fs, data);
  const merged = new PdfTextboxStore(second.host);
  await merged.initialize();

  const stillLegacy = second.getData() as { annotations: PdfTextboxAnnotation[] };
  assert.equal(stillLegacy.annotations.length, 1);
  assert.equal(merged.countForFile("Doc.pdf"), 2);

  fs.failWrites = null;
  await merged.flush();

  const cleared = second.getData() as { annotations: unknown[] };
  assert.deepEqual(cleared.annotations, []);

  const reloadHost = createHost(fs, second.getData());
  const reloaded = new PdfTextboxStore(reloadHost.host);
  await reloaded.initialize();
  await reloaded.ensureLoaded("Doc.pdf");
  assert.equal(reloaded.countForFile("Doc.pdf"), 2);
});

test("quarantines a corrupt shard and continues with an empty file", async () => {
  const fs = new MemoryFs();
  const first = createHost(fs, legacyData([annotation("a", "Doc.pdf", 1)]));
  const store = new PdfTextboxStore(first.host);
  await store.initialize();

  const shardPath = (await shardFiles(fs))[0];
  assert.ok(shardPath);
  fs.files.set(shardPath, "{ not json");

  const second = createHost(fs, first.getData());
  const broken = new PdfTextboxStore(second.host);
  await broken.initialize();
  await broken.ensureLoaded("Doc.pdf");

  assert.equal(broken.countForFile("Doc.pdf"), 0);
  assert.ok(
    [...fs.files.keys()].some((path) => path.includes(".corrupt-")),
    "expected the broken shard to be kept as a .corrupt file",
  );
  assert.ok(second.notices.some((message) => message.includes("damaged")));
});

test("falls back to legacy data.json when migration fails", async () => {
  const fs = new MemoryFs();
  const legacy = legacyData([annotation("a", "Doc.pdf", 1)]);
  const { host, getData } = createHost(fs, legacy);
  const store = new PdfTextboxStore(host);

  fs.failWrites = (path) => path.includes("/annotations/") || path.endsWith(".bak");

  const status = await store.initialize();

  assert.equal(status.legacy, true);
  assert.equal((getData() as { version: number }).version, 1);
  await store.ensureLoaded("Doc.pdf");
  assert.equal(store.countForFile("Doc.pdf"), 1);
  assert.equal(store.annotationsForPage("Doc.pdf", 1).length, 1);

  fs.failWrites = null;
  store.add("Doc.pdf", annotation("b", "Doc.pdf", 2));
  await store.flush();

  const saved = getData() as {
    version: number;
    annotations: PdfTextboxAnnotation[];
  };
  assert.equal(saved.version, 1);
  assert.equal(saved.annotations.length, 2);

  store.remove("Doc.pdf", "a");
  await store.flush();
  const afterRemove = getData() as {
    version: number;
    annotations: PdfTextboxAnnotation[];
  };
  assert.equal(afterRemove.annotations.length, 1);
  assert.equal(afterRemove.annotations[0]?.id, "b");
});

test("renaming and deleting a PDF updates the index and shard", async () => {
  const fs = new MemoryFs();
  const first = createHost(
    fs,
    legacyData([annotation("a", "Folder/Old.pdf", 1)]),
  );
  const store = new PdfTextboxStore(first.host);
  await store.initialize();
  await store.ensureLoaded("Folder/Old.pdf");

  await store.renameFile("Folder/Old.pdf", "Folder/New.pdf", false);
  await store.flush();

  const data = first.getData() as { shards: Record<string, string> };
  assert.deepEqual(Object.keys(data.shards), ["Folder/New.pdf"]);

  const reloadHost = createHost(fs, first.getData());
  const reloaded = new PdfTextboxStore(reloadHost.host);
  await reloaded.initialize();
  await reloaded.ensureLoaded("Folder/New.pdf");
  assert.equal(reloaded.countForFile("Folder/New.pdf"), 1);

  await reloaded.deleteFile("Folder/New.pdf", false);
  const afterDelete = reloadHost.getData() as { shards: Record<string, string> };
  assert.deepEqual(afterDelete.shards, {});
  assert.equal((await shardFiles(fs)).length, 0);
});

test("removeForFile deletes the shard and leaves the index empty", async () => {
  const fs = new MemoryFs();
  const first = createHost(
    fs,
    legacyData([annotation("a", "Doc.pdf", 1)]),
  );
  const store = new PdfTextboxStore(first.host);
  await store.initialize();
  await store.ensureLoaded("Doc.pdf");

  store.removeForFile("Doc.pdf");
  await store.flush();

  const data = first.getData() as { shards: Record<string, string> };
  assert.deepEqual(data.shards, {});
  assert.equal((await shardFiles(fs)).length, 0);
});

test("a fresh store starts empty and does not migrate user annotations", async () => {
  const fs = new MemoryFs();
  const { host, getData } = createHost(fs, null);
  const store = new PdfTextboxStore(host);

  const status = await store.initialize();
  assert.equal(status.migrated, false);
  assert.equal(status.legacy, false);
  await store.ensureLoaded("Doc.pdf");
  assert.equal(store.countForFile("Doc.pdf"), 0);

  const data = getData() as { version: number; shards: Record<string, string> };
  assert.equal(data.version, 2);
  assert.deepEqual(data.shards, {});
});
