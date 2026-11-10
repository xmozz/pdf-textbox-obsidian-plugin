/**
 * Pure data, geometry, colour and migration helpers.
 *
 * This module deliberately has no Obsidian or DOM dependencies so it can be
 * unit tested with Node's built-in test runner.
 */

export const DATA_VERSION = 2;
export const DEFAULT_FONT_SIZE = 12;

export interface PdfTextboxSettings {
  /** Width of newly created textboxes, as a percentage of the page width. */
  defaultWidthPercent: number;
  /** Font size of newly created textboxes, in PDF points. */
  defaultFontSize: number;
  /** Background colour for every textbox, as a #rrggbb value. */
  backgroundColor: string;
  /** Background opacity, 0.05 - 1. */
  backgroundColorOpacity: number;
  /** Show the overwrite confirmation before burning into the PDF. */
  confirmBeforeBurn: boolean;
  /** Show a confirmation before deleting a burned textbox annotation. */
  confirmBeforeDeleteAnnotation: boolean;
  /** Render Markdown/LaTeX while typing instead of only after leaving the editor. */
  livePreviewWhileEditing: boolean;
  /** Keep textbox edit mode enabled across PDF switches and restarts. */
  editModeEnabled: boolean;
}

export const DEFAULT_SETTINGS: PdfTextboxSettings = {
  defaultWidthPercent: 22,
  defaultFontSize: DEFAULT_FONT_SIZE,
  backgroundColor: "#ffd54f",
  backgroundColorOpacity: 0.58,
  confirmBeforeBurn: true,
  confirmBeforeDeleteAnnotation: true,
  livePreviewWhileEditing: true,
  editModeEnabled: false,
};

/**
 * A textbox annotation.
 *
 * `nx`, `ny`, `nw` and `nh` are the rectangle normalised to 0..1 for the page
 * rotation that was active when the box was created. Rendering and burning use
 * these values, so zooming cannot move a box.
 */
export interface PdfTextboxAnnotation {
  id: string;
  file: string;
  page: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  rotation: number;
  text: string;
  fontSize: number;
  /** Per-textbox background colour (#rrggbb). */
  color: string;
  /** Per-textbox background opacity, 0.05 - 1. */
  opacity: number;
  /** Whether the textbox is shown as a small icon until hovered. */
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The complete `data.json` payload. */
export interface StoredData {
  version: number;
  settings: PdfTextboxSettings;
  /** Legacy v1 annotations. Only used for migration or downgrade recovery. */
  annotations: PdfTextboxAnnotation[];
  /** PDF path -> shard id (without the `.json` extension). */
  shards: Record<string, string>;
}

/** One per-PDF shard file. */
export interface PdfTextboxShard {
  version: number;
  file: string;
  annotations: PdfTextboxAnnotation[];
}

export interface ThemeMarkdownColors {
  strong: string;
  em: string;
  /** Computed colour for h1 … h6. */
  headings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                   */
/* -------------------------------------------------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const snapped = Math.round(value / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

/**
 * Rotates a normalised rectangle from one page rotation to another.
 * PDF.js rotations are clockwise, so a point (x, y) becomes (1 - y, x) for 90°.
 */
export function rotateNormalizedRect(
  x: number,
  y: number,
  width: number,
  height: number,
  fromRotation: number,
  toRotation: number,
): { x: number; y: number; width: number; height: number } {
  let rx = x;
  let ry = y;
  let rw = width;
  let rh = height;

  const steps =
    ((normalizeRotation(toRotation) - normalizeRotation(fromRotation)) / 90 + 4) % 4;

  for (let index = 0; index < steps; index += 1) {
    const previousWidth = rw;
    const nextX = 1 - (ry + rh);
    const nextY = rx;
    rw = rh;
    rh = previousWidth;
    rx = nextX;
    ry = nextY;
  }

  return { x: rx, y: ry, width: rw, height: rh };
}

export function baseSizeForRotation(
  baseWidth: number,
  baseHeight: number,
  currentRotation: number,
  targetRotation: number,
): { width: number; height: number } {
  const delta =
    ((normalizeRotation(targetRotation) - normalizeRotation(currentRotation)) / 90 + 4) % 4;
  return delta === 1 || delta === 3
    ? { width: baseHeight, height: baseWidth }
    : { width: baseWidth, height: baseHeight };
}

export function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `textbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Mirrors Obsidian's `normalizePath` closely enough for vault paths. */
export function normalizeVaultPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

/* -------------------------------------------------------------------------- */
/*  Colours                                                                    */
/* -------------------------------------------------------------------------- */

export function normalizeHexColor(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SETTINGS.backgroundColor;
  let hex = value.trim();

  if (!hex.startsWith("#")) hex = `#${hex}`;
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    const [red, green, blue] = hex.slice(1);
    hex = `#${red}${red}${green}${green}${blue}${blue}`;
  }

  return /^#[0-9a-f]{6}$/i.test(hex)
    ? hex.toLowerCase()
    : DEFAULT_SETTINGS.backgroundColor;
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex);
  const value = Number.parseInt(normalized.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${clamp(alpha, 0, 1)})`;
}

/** Picks black or white text so the label stays readable on any background. */
export function textColorForBackground(hex: string): string {
  const normalized = normalizeHexColor(hex);
  const value = Number.parseInt(normalized.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.6 ? "#1c1c1c" : "#ffffff";
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Parses hex/rgb/rgba and, as a fallback, any colour the browser understands. */
export function parseColor(value: string): RgbColor | null {
  const text = value.trim();
  if (!text) return null;

  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    const digits = hex[1] ?? "";
    const expand = (part: string): number =>
      Number.parseInt(part.length === 1 ? part + part : part, 16);
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits.charAt(0)),
        g: expand(digits.charAt(1)),
        b: expand(digits.charAt(2)),
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: Number.parseInt(digits.slice(0, 2), 16),
        g: Number.parseInt(digits.slice(2, 4), 16),
        b: Number.parseInt(digits.slice(4, 6), 16),
      };
    }
  }

  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }

  // Themed colours can be oklch()/lab()/named colours. Let the browser
  // normalise those to #rrggbb instead of guessing.
  try {
    if (typeof document === "undefined") return null;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return null;
    const sentinel = "#010203";
    context.fillStyle = sentinel;
    context.fillStyle = text;
    const normalized = context.fillStyle;
    const lower = text.toLowerCase();
    if (
      typeof normalized !== "string" ||
      (normalized === sentinel && lower !== sentinel && lower !== "black")
    ) {
      return null;
    }
    // The canvas getter can also echo modern colour spaces back verbatim;
    // only recurse for formats the regex above understands.
    if (!/^(#|rgba?\()/i.test(normalized)) return null;
    return parseColor(normalized);
  } catch {
    return null;
  }
}

export function relativeLuminance(color: RgbColor): number {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel(color.r) +
    0.7152 * channel(color.g) +
    0.0722 * channel(color.b)
  );
}

export function contrastRatio(first: RgbColor, second: RgbColor): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Keeps a theme colour when it is readable on the textbox background and
 * falls back to the high-contrast black/white text colour otherwise.
 */
export function readableColor(
  candidate: string,
  background: string,
  fallback: string,
  minRatio: number,
): string {
  const candidateRgb = parseColor(candidate);
  const backgroundRgb = parseColor(background);
  const fallbackRgb = parseColor(fallback);
  if (!candidateRgb || !backgroundRgb) return fallback;

  if (contrastRatio(candidateRgb, backgroundRgb) >= minRatio) {
    return candidate;
  }

  // The theme colour is not readable on this background on its own. Instead of
  // discarding it entirely, blend it toward the high-contrast fallback so the
  // hue survives while the text stays legible.
  if (!fallbackRgb) return fallback;
  for (let step = 1; step <= 10; step += 1) {
    const amount = step / 10;
    const blended: RgbColor = {
      r: Math.round(candidateRgb.r * (1 - amount) + fallbackRgb.r * amount),
      g: Math.round(candidateRgb.g * (1 - amount) + fallbackRgb.g * amount),
      b: Math.round(candidateRgb.b * (1 - amount) + fallbackRgb.b * amount),
    };
    if (contrastRatio(blended, backgroundRgb) >= minRatio) {
      return rgbToHex(blended);
    }
  }

  return fallback;
}

export function rgbToHex(color: RgbColor): string {
  const toHex = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

/* -------------------------------------------------------------------------- */
/*  Coercion                                                                   */
/* -------------------------------------------------------------------------- */

export function coerceSettings(raw: unknown): PdfTextboxSettings {
  const source =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  return {
    defaultWidthPercent: clamp(
      finiteNumber(source.defaultWidthPercent, DEFAULT_SETTINGS.defaultWidthPercent),
      5,
      80,
    ),
    defaultFontSize: clamp(
      finiteNumber(source.defaultFontSize, DEFAULT_SETTINGS.defaultFontSize),
      6,
      48,
    ),
    backgroundColor: normalizeHexColor(source.backgroundColor),
    backgroundColorOpacity: clamp(
      finiteNumber(
        source.backgroundColorOpacity,
        DEFAULT_SETTINGS.backgroundColorOpacity,
      ),
      0.05,
      1,
    ),
    confirmBeforeBurn:
      typeof source.confirmBeforeBurn === "boolean"
        ? source.confirmBeforeBurn
        : DEFAULT_SETTINGS.confirmBeforeBurn,
    confirmBeforeDeleteAnnotation:
      typeof source.confirmBeforeDeleteAnnotation === "boolean"
        ? source.confirmBeforeDeleteAnnotation
        : DEFAULT_SETTINGS.confirmBeforeDeleteAnnotation,
    livePreviewWhileEditing:
      typeof source.livePreviewWhileEditing === "boolean"
        ? source.livePreviewWhileEditing
        : DEFAULT_SETTINGS.livePreviewWhileEditing,
    editModeEnabled:
      typeof source.editModeEnabled === "boolean"
        ? source.editModeEnabled
        : DEFAULT_SETTINGS.editModeEnabled,
  };
}

export function coerceAnnotation(
  raw: unknown,
  fallbackColor = DEFAULT_SETTINGS.backgroundColor,
  fallbackOpacity = DEFAULT_SETTINGS.backgroundColorOpacity,
): PdfTextboxAnnotation | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;

  if (typeof source.file !== "string" || source.file.trim().length === 0) return null;
  const page = Math.floor(finiteNumber(source.page, 0));
  if (page < 1) return null;

  const nx = finiteNumber(source.nx, Number.NaN);
  const ny = finiteNumber(source.ny, Number.NaN);
  const nw = finiteNumber(source.nw, Number.NaN);
  const nh = finiteNumber(source.nh, Number.NaN);
  if (![nx, ny, nw, nh].every(Number.isFinite)) return null;

  const safeWidth = clamp(nw, 0.02, 1);
  const safeHeight = clamp(nh, 0.005, 1);
  const safeX = clamp(nx, 0, Math.max(0, 1 - safeWidth));
  const safeY = clamp(ny, 0, Math.max(0, 1 - safeHeight));

  return {
    id: typeof source.id === "string" && source.id.length > 0 ? source.id : createId(),
    file: normalizeVaultPath(source.file),
    page,
    nx: safeX,
    ny: safeY,
    nw: safeWidth,
    nh: safeHeight,
    rotation: normalizeRotation(finiteNumber(source.rotation, 0)),
    text: typeof source.text === "string" ? source.text : "",
    fontSize: clamp(finiteNumber(source.fontSize, DEFAULT_FONT_SIZE), 6, 96),
    color: normalizeHexColor(source.color ?? fallbackColor),
    opacity: clamp(finiteNumber(source.opacity, fallbackOpacity), 0.05, 1),
    collapsed: source.collapsed === true,
    createdAt: finiteNumber(source.createdAt, Date.now()),
    updatedAt: finiteNumber(source.updatedAt, Date.now()),
  };
}

export function isNonEmptyAnnotation(annotation: PdfTextboxAnnotation): boolean {
  return annotation.text.trim().length > 0;
}

function sanitizeShardMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, string> = {};
  for (const [path, id] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== "string") continue;
    const normalizedPath = normalizeVaultPath(path);
    const trimmed = id.trim().replace(/\.json$/i, "");
    // Shard ids are file names, never paths.
    if (!trimmed || /[\\/]/.test(trimmed) || trimmed === "." || trimmed === "..") {
      continue;
    }
    const normalizedId = trimmed.replace(/[^a-z0-9._-]/gi, "");
    if (!normalizedPath || !normalizedId) continue;
    result[normalizedPath] = normalizedId;
  }
  return result;
}

export function coerceStoredData(raw: unknown): StoredData {
  if (!raw || typeof raw !== "object") {
    return {
      version: 0,
      settings: { ...DEFAULT_SETTINGS },
      annotations: [],
      shards: {},
    };
  }

  const source = raw as Record<string, unknown>;
  const settings = coerceSettings(source.settings);
  const annotations = Array.isArray(source.annotations)
    ? source.annotations
        .map((entry) =>
          coerceAnnotation(
            entry,
            settings.backgroundColor,
            settings.backgroundColorOpacity,
          ),
        )
        .filter((entry): entry is PdfTextboxAnnotation => entry !== null)
        .filter(isNonEmptyAnnotation)
    : [];

  return {
    version: finiteNumber(source.version, 1),
    settings,
    annotations,
    shards: sanitizeShardMap(source.shards),
  };
}

export function coerceShard(
  raw: unknown,
  fallbackFile?: string,
  fallbackOpacity = DEFAULT_SETTINGS.backgroundColorOpacity,
): PdfTextboxShard | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const rawFile =
    typeof source.file === "string" && source.file.trim().length > 0
      ? source.file
      : fallbackFile ?? "";
  const file = normalizeVaultPath(rawFile);
  if (!file) return null;

  const annotations = Array.isArray(source.annotations)
    ? source.annotations
        .map((entry) =>
          coerceAnnotation(
            entry,
            DEFAULT_SETTINGS.backgroundColor,
            fallbackOpacity,
          ),
        )
        .filter((entry): entry is PdfTextboxAnnotation => entry !== null)
        .filter(isNonEmptyAnnotation)
    : [];

  return {
    version: DATA_VERSION,
    file,
    annotations,
  };
}

/* -------------------------------------------------------------------------- */
/*  Migration helpers                                                          */
/* -------------------------------------------------------------------------- */

export function groupAnnotationsByFile(
  annotations: readonly PdfTextboxAnnotation[],
): Map<string, PdfTextboxAnnotation[]> {
  const groups = new Map<string, PdfTextboxAnnotation[]>();
  for (const annotation of annotations) {
    const file = normalizeVaultPath(annotation.file);
    const list = groups.get(file);
    if (list) list.push(annotation);
    else groups.set(file, [annotation]);
  }
  return groups;
}

/** Merges annotations by id; the newer `updatedAt` wins. */
export function mergeAnnotations(
  base: readonly PdfTextboxAnnotation[],
  incoming: readonly PdfTextboxAnnotation[],
): PdfTextboxAnnotation[] {
  const result = [...base];
  const positions = new Map<string, number>();
  result.forEach((annotation, index) => positions.set(annotation.id, index));

  for (const annotation of incoming) {
    const index = positions.get(annotation.id);
    if (index === undefined) {
      positions.set(annotation.id, result.length);
      result.push(annotation);
      continue;
    }
    const existing = result[index];
    if (existing && annotation.updatedAt >= existing.updatedAt) {
      result[index] = annotation;
    }
  }

  return result;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function sanitizeShardBaseName(filePath: string): string {
  const name = normalizeVaultPath(filePath).split("/").pop() ?? "pdf";
  const withoutExtension = name.replace(/\.pdf$/i, "");
  let base = withoutExtension
    .replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s-]+/, "")
    .replace(/[.\s-]+$/, "");

  if (!base) base = "pdf";
  if (base.length > 48) {
    base = base.slice(0, 48).replace(/[.\s-]+$/, "");
  }
  return base || "pdf";
}

/**
 * Deterministic shard id for a PDF path. The hash keeps collisions extremely
 * unlikely while the readable suffix makes debugging shard files easier.
 */
export function shardIdForPath(filePath: string): string {
  const normalized = normalizeVaultPath(filePath);
  return `${fnv1a64(normalized)}-${sanitizeShardBaseName(normalized)}`;
}

/* -------------------------------------------------------------------------- */
/*  Page index                                                                 */
/* -------------------------------------------------------------------------- */

const EMPTY_PAGE: readonly PdfTextboxAnnotation[] = Object.freeze([]);

/**
 * Keeps annotations grouped by page so rendering never has to scan every
 * textbox in the vault.
 */
export class PageAnnotationIndex {
  private readonly pages = new Map<number, PdfTextboxAnnotation[]>();
  private readonly ids = new Map<string, PdfTextboxAnnotation>();

  get size(): number {
    return this.ids.size;
  }

  add(annotation: PdfTextboxAnnotation): void {
    const existing = this.ids.get(annotation.id);
    if (existing) this.detach(existing);

    this.ids.set(annotation.id, annotation);
    const list = this.pages.get(annotation.page);
    if (list) list.push(annotation);
    else this.pages.set(annotation.page, [annotation]);
  }

  remove(id: string): boolean {
    const annotation = this.ids.get(id);
    if (!annotation) return false;
    this.detach(annotation);
    this.ids.delete(id);
    return true;
  }

  getById(id: string): PdfTextboxAnnotation | undefined {
    return this.ids.get(id);
  }

  /** Moves an annotation to another page and keeps the page index in sync. */
  moveToPage(annotation: PdfTextboxAnnotation, page: number): void {
    const existing = this.ids.get(annotation.id);
    if (!existing) {
      annotation.page = page;
      this.add(annotation);
      return;
    }
    if (existing.page === page) return;
    this.detach(existing);
    existing.page = page;
    this.add(existing);
  }

  get(page: number): readonly PdfTextboxAnnotation[] {
    return this.pages.get(page) ?? EMPTY_PAGE;
  }

  all(): PdfTextboxAnnotation[] {
    const result: PdfTextboxAnnotation[] = [];
    for (const list of this.pages.values()) result.push(...list);
    return result;
  }

  clear(): void {
    this.pages.clear();
    this.ids.clear();
  }

  private detach(annotation: PdfTextboxAnnotation): void {
    const list = this.pages.get(annotation.page);
    if (!list) return;
    const index = list.indexOf(annotation);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.pages.delete(annotation.page);
  }
}
