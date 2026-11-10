/**
 * Sharded annotation storage.
 *
 * `data.json` keeps settings plus a small index (PDF path -> shard id). The
 * annotations themselves live in one file per PDF under `annotations/`, so a
 * normal save only rewrites the PDF that changed.
 */

import {
  DATA_VERSION,
  DEFAULT_SETTINGS,
  PageAnnotationIndex,
  coerceShard,
  coerceSettings,
  coerceStoredData,
  groupAnnotationsByFile,
  mergeAnnotations,
  normalizeVaultPath,
  shardIdForPath,
  type PdfTextboxAnnotation,
  type PdfTextboxSettings,
  type StoredData,
} from "./core";

export interface VaultFileSystem {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface StoreHost {
  fs: VaultFileSystem;
  /** Vault-relative plugin directory, e.g. `.obsidian/plugins/pdf-textbox`. */
  pluginDir: string;
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
  notify?(message: string, timeout?: number): void;
}

export interface StoreStatus {
  migrated: boolean;
  rebuiltIndex: boolean;
  legacy: boolean;
  warnings: string[];
}

interface DiskShard {
  id: string;
  file: string;
  annotations: PdfTextboxAnnotation[];
}

const SHARD_FOLDER = "annotations";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PdfTextboxStore {
  private settings: PdfTextboxSettings = { ...DEFAULT_SETTINGS };
  private index = new Map<string, string>();
  private shardToFile = new Map<string, string>();
  private cache = new Map<string, PageAnnotationIndex>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private refs = new Map<string, number>();
  private dirtyFiles = new Set<string>();
  private pendingDeletes = new Set<string>();
  private dirtyData = false;
  private mode: "sharded" | "legacy" = "sharded";
  private missingWarned = new Set<string>();

  constructor(private readonly host: StoreHost) {}

  getSettings(): PdfTextboxSettings {
    return { ...this.settings };
  }

  setSettings(patch: Partial<PdfTextboxSettings>): void {
    this.settings = coerceSettings({ ...this.settings, ...patch });
    this.dirtyData = true;
  }

  hasDirty(): boolean {
    return (
      this.dirtyData || this.dirtyFiles.size > 0 || this.pendingDeletes.size > 0
    );
  }

  isLoaded(filePath: string): boolean {
    return this.mode === "legacy" || this.loaded.has(normalizeVaultPath(filePath));
  }

  acquire(filePath: string): void {
    const file = normalizeVaultPath(filePath);
    this.refs.set(file, (this.refs.get(file) ?? 0) + 1);
  }

  async release(filePath: string): Promise<void> {
    const file = normalizeVaultPath(filePath);
    const remaining = (this.refs.get(file) ?? 1) - 1;
    if (remaining > 0) {
      this.refs.set(file, remaining);
      return;
    }
    this.refs.delete(file);
    if (this.mode === "legacy") return;

    if (this.dirtyFiles.has(file)) {
      await this.flushFile(file);
    }
    // A new view may have acquired the file while the shard was being written.
    if (this.refs.has(file)) return;
    this.cache.delete(file);
    this.loaded.delete(file);
  }

  annotationsForPage(
    filePath: string,
    pageNumber: number,
  ): readonly PdfTextboxAnnotation[] {
    const index = this.cache.get(normalizeVaultPath(filePath));
    return index ? index.get(pageNumber) : [];
  }

  allForFile(filePath: string): PdfTextboxAnnotation[] {
    const index = this.cache.get(normalizeVaultPath(filePath));
    return index ? index.all() : [];
  }

  countForFile(filePath: string): number {
    const index = this.cache.get(normalizeVaultPath(filePath));
    return index ? index.size : 0;
  }

  add(filePath: string, annotation: PdfTextboxAnnotation): void {
    const file = normalizeVaultPath(filePath);
    annotation.file = file;
    const index = this.requireIndex(file);
    index.add(annotation);

    if (!this.index.has(file)) {
      const id = this.uniqueShardId(file, new Set(this.shardToFile.keys()));
      this.index.set(file, id);
      this.shardToFile.set(id, file);
      this.dirtyData = true;
    }
    this.dirtyFiles.add(file);
    if (this.mode === "legacy") this.dirtyData = true;
  }

  touch(filePath: string): void {
    const file = normalizeVaultPath(filePath);
    // Never create an empty index here: that could overwrite a shard that was
    // not loaded yet.
    if (!this.cache.has(file)) return;
    this.dirtyFiles.add(file);
    if (this.mode === "legacy") this.dirtyData = true;
  }

  remove(filePath: string, id: string): boolean {
    const file = normalizeVaultPath(filePath);
    const index = this.cache.get(file);
    if (!index) return false;
    const removed = index.remove(id);
    if (removed) {
      this.dirtyFiles.add(file);
      if (this.mode === "legacy") this.dirtyData = true;
    }
    return removed;
  }

  removeMany(filePath: string, ids: ReadonlySet<string>): void {
    const file = normalizeVaultPath(filePath);
    const index = this.cache.get(file);
    if (!index) return;
    let changed = false;
    for (const id of ids) {
      if (index.remove(id)) changed = true;
    }
    if (changed) {
      this.dirtyFiles.add(file);
      if (this.mode === "legacy") this.dirtyData = true;
    }
  }

  removeForFile(filePath: string): void {
    const file = normalizeVaultPath(filePath);
    const index = this.cache.get(file);
    if (index) {
      index.clear();
      this.dirtyFiles.add(file);
      if (this.mode === "legacy") this.dirtyData = true;
      return;
    }

    const id = this.index.get(file);
    if (id) {
      this.index.delete(file);
      this.shardToFile.delete(id);
      if (!this.isShardReferenced(id)) this.pendingDeletes.add(id);
      this.dirtyData = true;
    }
  }

  moveToPage(annotation: PdfTextboxAnnotation, page: number): void {
    const index = this.cache.get(normalizeVaultPath(annotation.file));
    if (index) {
      index.moveToPage(annotation, page);
    } else {
      annotation.page = page;
    }
  }

  async ensureLoaded(filePath: string): Promise<void> {
    const file = normalizeVaultPath(filePath);
    if (this.mode === "legacy" || this.loaded.has(file)) return;

    const pending = this.loading.get(file);
    if (pending) return pending;

    const promise = this.loadFile(file).finally(() => {
      this.loading.delete(file);
    });
    this.loading.set(file, promise);
    return promise;
  }

  /* ---------------------------------------------------------------------- */
  /*  Init + migration                                                       */
  /* ---------------------------------------------------------------------- */

  async initialize(): Promise<StoreStatus> {
    const warnings: string[] = [];
    let raw: unknown = null;
    let stored = coerceStoredData(null);

    try {
      raw = await this.host.loadData();
      stored = coerceStoredData(raw);
    } catch (error) {
      warnings.push(`Could not read data.json: ${errorMessage(error)}`);
    }

    this.settings = stored.settings;

    let listed = new Set<string>();
    try {
      listed = await this.listShardIds(warnings);
    } catch (error) {
      warnings.push(`Could not list shards: ${errorMessage(error)}`);
    }

    if (stored.version < DATA_VERSION) {
      try {
        const disk = await this.readShardIds(listed, warnings);
        const migrated = await this.migrate(raw, stored, disk, warnings);
        return { migrated, rebuiltIndex: false, legacy: false, warnings };
      } catch (error) {
        this.enableLegacy(stored);
        warnings.push(`Migration failed: ${errorMessage(error)}`);
        return { migrated: false, rebuiltIndex: false, legacy: true, warnings };
      }
    }

    // Normal start: only the index is needed. Shards are read lazily when a
    // PDF is opened. The directory listing is metadata-only and lets us detect
    // orphans after a crash without reading every shard.
    this.index = new Map(Object.entries(stored.shards));
    this.rebuildShardToFile();
    let rebuiltIndex = false;

    const referenced = new Set(this.index.values());
    const orphanIds = [...listed].filter((id) => !referenced.has(id));

    try {
      if (this.index.size === 0 && listed.size > 0) {
        // The index was lost (for example after a downgrade): read everything.
        const disk = await this.readShardIds(listed, warnings);
        rebuiltIndex = await this.rebuildIndex(disk, warnings, true);
      } else if (orphanIds.length > 0) {
        // A crash between writing a shard and saving data.json leaves an
        // orphan. Read only those shards and attach them to the index.
        const disk = await this.readShardIds(new Set(orphanIds), warnings);
        rebuiltIndex = await this.rebuildIndex(disk, warnings, false);
      }
    } catch (error) {
      // Keep whatever index we have; individual shards can still be read.
      warnings.push(`Could not rebuild the shard index: ${errorMessage(error)}`);
    }

    if (stored.annotations.length > 0) {
      try {
        const residueFiles = new Set(
          groupAnnotationsByFile(stored.annotations).keys(),
        );
        const residueIds = new Set<string>();
        for (const file of residueFiles) {
          const id = this.index.get(file);
          if (id) residueIds.add(id);
        }
        const disk = await this.readShardIds(residueIds, warnings);
        await this.mergeResidue(stored.annotations, disk, warnings);
        this.dirtyData = true;
      } catch (error) {
        warnings.push(
          `Could not merge legacy annotations into shards: ${errorMessage(error)}`,
        );
      }
    }

    if (this.dirtyData) {
      try {
        await this.flush();
      } catch (error) {
        warnings.push(`Could not persist the migrated index: ${errorMessage(error)}`);
      }
    }

    return {
      migrated: stored.annotations.length > 0,
      rebuiltIndex,
      legacy: false,
      warnings,
    };
  }

  private async migrate(
    raw: unknown,
    stored: StoredData,
    disk: Map<string, DiskShard>,
    warnings: string[],
  ): Promise<boolean> {
    const byFile = new Map<string, PdfTextboxAnnotation[]>();
    for (const shard of disk.values()) {
      byFile.set(
        shard.file,
        mergeAnnotations(byFile.get(shard.file) ?? [], shard.annotations),
      );
    }
    for (const [file, annotations] of groupAnnotationsByFile(stored.annotations)) {
      byFile.set(file, mergeAnnotations(byFile.get(file) ?? [], annotations));
    }

    await this.ensureShardDir();
    await this.backupLegacyData(raw);

    const existingIdByFile = new Map(
      [...disk.values()].map((shard) => [shard.file, shard.id]),
    );
    const used = new Set(disk.keys());
    const nextIndex = new Map<string, string>();

    for (const [file, annotations] of byFile) {
      const id =
        existingIdByFile.get(file) ?? this.uniqueShardId(file, used);
      used.add(id);
      nextIndex.set(file, id);
      await this.writeShard(id, file, annotations);
      disk.set(id, { id, file, annotations });
    }

    this.index = nextIndex;
    this.rebuildShardToFile();

    if (disk.size !== byFile.size) {
      warnings.push(
        `Migration kept ${disk.size} shard${disk.size === 1 ? "" : "s"} for ${
          byFile.size
        } PDF${byFile.size === 1 ? "" : "s"}.`,
      );
    }

    await this.host.saveData(this.buildData());
    this.dirtyData = false;
    return stored.annotations.length > 0;
  }

  private async backupLegacyData(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const backup = `${this.pluginDir()}/data.json.v1.bak`;
    try {
      if (await this.host.fs.exists(backup)) return;
      await this.host.fs.write(backup, JSON.stringify(raw, null, 2));
    } catch (error) {
      throw new Error(
        `Could not create the safety backup (${backup}): ${errorMessage(error)}`,
      );
    }
  }

  private async rebuildIndex(
    disk: Map<string, DiskShard>,
    warnings: string[],
    complete: boolean,
  ): Promise<boolean> {
    let changed = false;
    this.rebuildShardToFile();

    // Validate index entries and keep the index authoritative for known paths.
    for (const [file, id] of [...this.index]) {
      const shard = disk.get(id);
      if (!shard) {
        if (complete) warnings.push(`Shard ${id} for ${file} is missing.`);
        continue;
      }
      if (shard.file !== file) {
        try {
          await this.writeShard(id, file, shard.annotations);
          disk.set(id, { ...shard, file });
          this.dirtyFiles.add(file);
          changed = true;
        } catch (error) {
          warnings.push(
            `Could not update the path inside shard ${id}: ${errorMessage(error)}`,
          );
        }
      }
    }

    const referenced = new Set(this.index.values());

    for (const shard of [...disk.values()]) {
      if (referenced.has(shard.id)) continue;

      const indexedId = this.index.get(shard.file);
      if (!indexedId) {
        this.index.set(shard.file, shard.id);
        referenced.add(shard.id);
        changed = true;
        continue;
      }

      // Two shards claim the same PDF. Merge their annotations into the
      // indexed shard before dropping the duplicate. The target may not be in
      // the partial `disk` map when only orphans were read, so load it.
      let target = disk.get(indexedId);
      if (!target) target = await this.readShardId(indexedId, warnings) ?? undefined;
      if (!target) {
        warnings.push(
          `Shard ${indexedId} for ${shard.file} is missing; using ${shard.id}.`,
        );
        this.index.set(shard.file, shard.id);
        referenced.add(shard.id);
        changed = true;
        continue;
      }

      try {
        const merged = mergeAnnotations(target.annotations, shard.annotations);
        await this.writeShard(indexedId, target.file, merged);
        disk.set(indexedId, { ...target, annotations: merged });
        await this.host.fs.remove(this.shardPath(shard.id));
        disk.delete(shard.id);
        warnings.push(
          `Merged duplicate shard ${shard.id} into ${indexedId} for ${shard.file}.`,
        );
        changed = true;
      } catch (error) {
        warnings.push(
          `Could not merge duplicate shard ${shard.id}: ${errorMessage(error)}`,
        );
      }
    }

    this.rebuildShardToFile();
    if (changed) this.dirtyData = true;
    return changed;
  }

  private async mergeResidue(
    residue: readonly PdfTextboxAnnotation[],
    disk: Map<string, DiskShard>,
    warnings: string[],
  ): Promise<void> {
    const used = new Set(this.shardToFile.keys());

    for (const [file, annotations] of groupAnnotationsByFile(residue)) {
      let id = this.index.get(file);
      const existing = id ? disk.get(id)?.annotations ?? [] : [];
      const merged = mergeAnnotations(existing, annotations);

      if (!id) {
        id = this.uniqueShardId(file, used);
        this.index.set(file, id);
      }
      used.add(id);

      try {
        await this.writeShard(id, file, merged);
        disk.set(id, { id, file, annotations: merged });
        this.shardToFile.set(id, file);
        this.dirtyData = true;
      } catch (error) {
        // Keep the merged data in memory and retry on the next save. The old
        // data.json still contains the residue, so nothing is lost if the
        // plugin closes before the retry succeeds.
        const index = new PageAnnotationIndex();
        for (const annotation of merged) {
          annotation.file = file;
          index.add(annotation);
        }
        this.cache.set(file, index);
        this.loaded.add(file);
        this.dirtyFiles.add(file);
        this.dirtyData = true;
        warnings.push(
          `Could not merge textboxes for ${file}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private enableLegacy(stored: StoredData): void {
    this.mode = "legacy";
    this.index.clear();
    this.shardToFile.clear();
    this.cache.clear();
    this.loaded.clear();
    this.dirtyFiles.clear();
    this.pendingDeletes.clear();
    this.dirtyData = false;
    this.settings = stored.settings;

    for (const [file, annotations] of groupAnnotationsByFile(stored.annotations)) {
      const index = new PageAnnotationIndex();
      for (const annotation of annotations) index.add(annotation);
      this.cache.set(file, index);
      this.loaded.add(file);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Reading                                                                */
  /* ---------------------------------------------------------------------- */

  private async loadFile(file: string): Promise<void> {
    const index = new PageAnnotationIndex();
    const id = this.index.get(file);

    if (id) {
      const path = this.shardPath(id);
      try {
        if (await this.host.fs.exists(path)) {
          const raw: unknown = JSON.parse(await this.host.fs.read(path));
          const shard = coerceShard(
            raw,
            file,
            this.settings.backgroundColorOpacity,
          );
          if (!shard) throw new Error("invalid shard format");

          for (const annotation of shard.annotations) {
            annotation.file = file;
            index.add(annotation);
          }
          if (shard.file !== file) this.dirtyFiles.add(file);
        } else if (!this.missingWarned.has(file)) {
          this.missingWarned.add(file);
          this.host.notify?.(
            `PDF Textbox: the textbox file for ${file} is missing. Starting with no textboxes.`,
            8000,
          );
        }
      } catch (error) {
        await this.quarantineShard(id, path, file, error);
      }
    }

    this.cache.set(file, index);
    this.loaded.add(file);
  }

  private async quarantineShard(
    id: string,
    path: string,
    file: string,
    error: unknown,
  ): Promise<void> {
    const target = `${path}.corrupt-${Date.now()}`;
    let kept = false;
    try {
      await this.host.fs.rename(path, target);
      kept = true;
      if (this.index.get(file) === id) {
        this.index.delete(file);
        this.shardToFile.delete(id);
        this.dirtyData = true;
      }
    } catch (renameError) {
      console.error("PDF Textbox: could not quarantine a broken shard", renameError);
    }
    this.host.notify?.(
      kept
        ? `PDF Textbox: the textbox file for ${file} was damaged and could not be read. ` +
            `A backup was kept next to the original.`
        : `PDF Textbox: the textbox file for ${file} was damaged and could not be read. ` +
            `It could not be moved aside; check the plugin folder.`,
      10000,
    );
    console.error("PDF Textbox: could not read a textbox shard", error);
  }

  private requireIndex(file: string): PageAnnotationIndex {
    let index = this.cache.get(file);
    if (!index) {
      index = new PageAnnotationIndex();
      this.cache.set(file, index);
      this.loaded.add(file);
    }
    return index;
  }

  /* ---------------------------------------------------------------------- */
  /*  Writing                                                                */
  /* ---------------------------------------------------------------------- */

  async flush(): Promise<void> {
    if (this.mode === "legacy") {
      if (!this.dirtyData) return;
      await this.host.saveData(this.buildLegacyData());
      this.dirtyData = false;
      return;
    }

    for (const file of [...this.dirtyFiles]) {
      await this.flushFile(file);
    }

    for (const id of [...this.pendingDeletes]) {
      const path = this.shardPath(id);
      if (await this.host.fs.exists(path)) await this.host.fs.remove(path);
      this.pendingDeletes.delete(id);
    }

    if (this.dirtyData) {
      await this.host.saveData(this.buildData());
      this.dirtyData = false;
    }
  }

  private async flushFile(file: string): Promise<void> {
    if (!this.dirtyFiles.has(file)) return;
    const index = this.cache.get(file);
    if (!index) {
      this.dirtyFiles.delete(file);
      return;
    }

    if (index.size === 0) {
      const id = this.index.get(file);
      if (id) {
        this.index.delete(file);
        this.shardToFile.delete(id);
        if (!this.isShardReferenced(id)) this.pendingDeletes.add(id);
        this.dirtyData = true;
      }
      this.dirtyFiles.delete(file);
      return;
    }

    let id = this.index.get(file);
    if (!id) {
      id = this.uniqueShardId(file, new Set(this.shardToFile.keys()));
      this.index.set(file, id);
      this.shardToFile.set(id, file);
      this.dirtyData = true;
    }

    const annotations = index.all();
    for (const annotation of annotations) annotation.file = file;
    await this.writeShard(id, file, annotations);
    this.dirtyFiles.delete(file);
  }

  private buildData(): StoredData {
    const shards: Record<string, string> = {};
    for (const [file, id] of [...this.index].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      shards[file] = id;
    }
    return {
      version: DATA_VERSION,
      settings: { ...this.settings },
      annotations: [],
      shards,
    };
  }

  private buildLegacyData(): StoredData {
    const annotations: PdfTextboxAnnotation[] = [];
    for (const index of this.cache.values()) annotations.push(...index.all());
    return {
      version: 1,
      settings: { ...this.settings },
      annotations,
      shards: {},
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Rename / delete                                                        */
  /* ---------------------------------------------------------------------- */

  async renameFile(
    oldPath: string,
    newPath: string,
    isFolder: boolean,
  ): Promise<void> {
    const oldBase = normalizeVaultPath(oldPath);
    const newBase = normalizeVaultPath(newPath);
    if (!oldBase || !newBase || oldBase === newBase) return;

    const affected: Array<{ oldFile: string; newFile: string; id: string }> = [];
    for (const [file, id] of this.index) {
      if (isFolder) {
        if (file === oldBase || file.startsWith(`${oldBase}/`)) {
          affected.push({
            oldFile: file,
            newFile: `${newBase}${file.slice(oldBase.length)}`,
            id,
          });
        }
      } else if (file === oldBase) {
        affected.push({ oldFile: file, newFile: newBase, id });
      }
    }
    if (affected.length === 0) return;

    for (const { oldFile, newFile, id } of affected) {
      this.index.delete(oldFile);
      this.index.set(newFile, id);
      this.shardToFile.set(id, newFile);

      const index = this.cache.get(oldFile);
      if (index) {
        for (const annotation of index.all()) annotation.file = newFile;
        this.cache.delete(oldFile);
        this.cache.set(newFile, index);
        this.loaded.delete(oldFile);
        this.loaded.add(newFile);
        this.dirtyFiles.delete(oldFile);
        this.dirtyFiles.add(newFile);
      }
    }

    this.dirtyData = true;

    // Correct the `file` field inside shards that are not loaded in memory.
    for (const { oldFile, newFile, id } of affected) {
      if (this.cache.has(newFile)) continue;
      const path = this.shardPath(id);
      try {
        if (!(await this.host.fs.exists(path))) continue;
        const raw: unknown = JSON.parse(await this.host.fs.read(path));
        const shard = coerceShard(
          raw,
          oldFile,
          this.settings.backgroundColorOpacity,
        );
        if (!shard) continue;
        await this.writeShard(id, newFile, shard.annotations);
      } catch (error) {
        console.error(`PDF Textbox: could not update shard ${id}`, error);
      }
    }

    await this.flush();
  }

  async deleteFile(filePath: string, isFolder: boolean): Promise<void> {
    const base = normalizeVaultPath(filePath);
    if (!base) return;

    let changed = false;
    const deletedIds = new Set<string>();
    for (const [file, id] of [...this.index]) {
      const matches = isFolder
        ? file === base || file.startsWith(`${base}/`)
        : file === base;
      if (!matches) continue;

      this.index.delete(file);
      this.shardToFile.delete(id);
      this.cache.delete(file);
      this.loaded.delete(file);
      this.dirtyFiles.delete(file);
      this.refs.delete(file);
      deletedIds.add(id);
      changed = true;
    }

    if (!changed) return;
    for (const id of deletedIds) {
      if (!this.isShardReferenced(id)) this.pendingDeletes.add(id);
    }
    this.dirtyData = true;
    await this.flush();
  }

  /* ---------------------------------------------------------------------- */
  /*  Low-level file helpers                                                 */
  /* ---------------------------------------------------------------------- */

  private pluginDir(): string {
    return normalizeVaultPath(this.host.pluginDir);
  }

  private shardDir(): string {
    return `${this.pluginDir()}/${SHARD_FOLDER}`;
  }

  private shardPath(id: string): string {
    return `${this.shardDir()}/${id}.json`;
  }

  private async ensureShardDir(): Promise<void> {
    const dir = this.shardDir();
    if (await this.host.fs.exists(dir)) return;
    try {
      await this.host.fs.mkdir(dir);
    } catch (error) {
      if (!(await this.host.fs.exists(dir))) throw error;
    }
  }

  private uniqueShardId(file: string, used: ReadonlySet<string>): string {
    const base = shardIdForPath(file);
    let id = base;
    let suffix = 2;
    while (
      used.has(id) ||
      (this.shardToFile.has(id) && this.shardToFile.get(id) !== file)
    ) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    return id;
  }

  private rebuildShardToFile(): void {
    this.shardToFile.clear();
    for (const [file, id] of this.index) this.shardToFile.set(id, file);
  }

  private isShardReferenced(id: string): boolean {
    for (const candidate of this.index.values()) {
      if (candidate === id) return true;
    }
    return false;
  }

  /** Lists shard ids without reading any shard file. */
  private async listShardIds(warnings: string[]): Promise<Set<string>> {
    const dir = this.shardDir();
    const ids = new Set<string>();
    if (!(await this.host.fs.exists(dir))) return ids;

    let listed: { files: string[]; folders: string[] };
    try {
      listed = await this.host.fs.list(dir);
    } catch (error) {
      warnings.push(`Could not list ${dir}: ${errorMessage(error)}`);
      return ids;
    }

    for (const path of listed.files) {
      if (path.toLowerCase().endsWith(".tmp")) {
        try {
          await this.host.fs.remove(path);
        } catch {
          // A leftover temporary file is harmless.
        }
        continue;
      }
      if (!path.toLowerCase().endsWith(".json")) continue;
      const id = (path.split("/").pop() ?? "").replace(/\.json$/i, "");
      if (id) ids.add(id);
    }
    return ids;
  }

  private async readShardIds(
    ids: ReadonlySet<string>,
    warnings: string[],
  ): Promise<Map<string, DiskShard>> {
    const shards = new Map<string, DiskShard>();
    for (const id of ids) {
      const shard = await this.readShardId(id, warnings);
      if (shard) shards.set(id, shard);
    }
    return shards;
  }

  private async readShardId(
    id: string,
    warnings: string[],
  ): Promise<DiskShard | null> {
    const path = this.shardPath(id);
    try {
      if (!(await this.host.fs.exists(path))) return null;
      const raw: unknown = JSON.parse(await this.host.fs.read(path));
      const shard = coerceShard(
        raw,
        undefined,
        this.settings.backgroundColorOpacity,
      );
      if (!shard) {
        warnings.push(`Ignored invalid shard ${path}.`);
        return null;
      }
      return {
        id,
        file: shard.file,
        annotations: shard.annotations,
      };
    } catch (error) {
      warnings.push(`Could not read shard ${path}: ${errorMessage(error)}`);
      return null;
    }
  }

  private async writeShard(
    id: string,
    file: string,
    annotations: readonly PdfTextboxAnnotation[],
  ): Promise<void> {
    await this.ensureShardDir();
    const data = JSON.stringify(
      {
        version: DATA_VERSION,
        file,
        annotations,
      },
      null,
      2,
    );
    await this.writeAtomic(this.shardPath(id), data);
  }

  private async writeAtomic(path: string, data: string): Promise<void> {
    const temporary = `${path}.${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    await this.host.fs.write(temporary, data);
    try {
      await this.host.fs.rename(temporary, path);
      return;
    } catch {
      // Some platforms refuse to rename over an existing file.
    }

    try {
      if (await this.host.fs.exists(path)) await this.host.fs.remove(path);
      await this.host.fs.rename(temporary, path);
      return;
    } catch {
      // Fall back to a direct write as the last resort.
    }

    await this.host.fs.write(path, data);
    try {
      if (await this.host.fs.exists(temporary)) {
        await this.host.fs.remove(temporary);
      }
    } catch {
      // A leftover .tmp file is harmless.
    }
  }
}
