import {
  EditorSelection,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { language } from "@codemirror/language";
import {
  App,
  Component,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  View,
  WorkspaceLeaf,
  editorLivePreviewField,
  normalizePath,
  setIcon,
} from "obsidian";
import html2canvas from "html2canvas";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
} from "pdf-lib";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DATA_VERSION = 1;
const PDF_VIEW_TYPE = "pdf";
const PAGE_SELECTOR = ".page[data-page-number]";
const TOOL_CLASS = "pdf-textbox-tool";
const CREATE_TOOL_CLASS = "pdf-textbox-create-tool";
const EDIT_TOOL_CLASS = "pdf-textbox-edit-tool";
const COLOR_TOOL_CLASS = "pdf-textbox-color-tool";
const SIZE_TOOL_CLASS = "pdf-textbox-size-tool";
const LAYER_CLASS = "pdf-textbox-layer";
const ANNOTATION_CLASS = "pdf-textbox-annotation";
const EDIT_MODE_CLASS = "pdf-textbox-edit-mode";
const CREATE_MODE_CLASS = "pdf-textbox-create-mode";
const SAVE_DEBOUNCE_MS = 400;
const DEFAULT_FONT_SIZE = 12;
const MIN_HEIGHT_PDF = 24;
const MAX_ATTACH_ATTEMPTS = 40;
/** PDF.js viewports express CSS pixels; 1 PDF point = 96/72 CSS pixels. */
const CSS_UNITS = 96 / 72;

/* -------------------------------------------------------------------------- */
/*  Data model                                                                 */
/* -------------------------------------------------------------------------- */

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
  /** Keep textbox edit mode enabled across PDF switches and restarts. */
  editModeEnabled: boolean;
}

export const DEFAULT_SETTINGS: PdfTextboxSettings = {
  defaultWidthPercent: 22,
  defaultFontSize: DEFAULT_FONT_SIZE,
  backgroundColor: "#ffd54f",
  backgroundColorOpacity: 0.58,
  confirmBeforeBurn: true,
  editModeEnabled: false,
};

/**
 * A textbox annotation.
 *
 * `x`, `y`, `width` and `height` are stored in PDF page units at scale 1
 * (not screen pixels) for the page rotation that was active when the box was
 * created. `nx`, `ny`, `nw` and `nh` are the same rectangle normalised to 0..1
 * and are what the overlay uses for rendering, so zooming cannot move a box.
 */
export interface PdfTextboxAnnotation {
  id: string;
  file: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  rotation: number;
  text: string;
  fontSize: number;
  /** Per-textbox background colour (#rrggbb). */
  color: string;
  /** Whether the textbox is shown as a small icon until hovered. */
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PdfTextboxData {
  version: number;
  annotations: PdfTextboxAnnotation[];
  settings: PdfTextboxSettings;
}

function createEmptyData(): PdfTextboxData {
  return {
    version: DATA_VERSION,
    annotations: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/* -------------------------------------------------------------------------- */
/*  Minimal PDF.js/Obsidian internal types                                     */
/* -------------------------------------------------------------------------- */

interface PdfJsViewport {
  width: number;
  height: number;
  scale: number;
  rotation: number;
}

interface PdfPageView {
  viewport?: PdfJsViewport;
  scale?: number;
}

type PdfEventHandler = (data?: unknown) => void;

interface PdfEventBus {
  on?: (eventName: string, handler: PdfEventHandler) => void;
  off?: (eventName: string, handler: PdfEventHandler) => void;
  _on?: (eventName: string, handler: PdfEventHandler) => void;
  _off?: (eventName: string, handler: PdfEventHandler) => void;
}

interface PdfViewer {
  currentScale?: number;
  currentScaleValue?: string;
  eventBus?: PdfEventBus;
  getPageView?: (pageIndex: number) => PdfPageView | undefined;
  /** Obsidian wraps PDF.js in its own viewer object; the real one is nested. */
  pdfViewer?: PdfViewer;
}

/**
 * Obsidian's PDF view is not part of the public plugin API. These are the
 * internal fields we rely on, deliberately kept optional and accessed through
 * one cast in `resolvePdfHost()`.
 *
 * Depending on the Obsidian version the PDF component is either the view
 * itself (older builds) or nested in `view.viewer.child` (1.14+).
 */
interface PdfViewerHost {
  containerEl?: HTMLElement;
  file?: TFile | null;
  pdfViewer?: PdfViewer;
  eventBus?: PdfEventBus;
}

interface PdfView extends View {
  file?: TFile | null;
  pdfViewer?: PdfViewer;
  viewer?: PdfViewerHost & { child?: PdfViewerHost };
  /** `FileView` method used to reload the PDF after it was overwritten. */
  loadFile?: (file: TFile) => Promise<void>;
}

interface ResolvedPdfHost {
  host: PdfViewerHost;
  pdfViewer: PdfViewer;
  rootEl: HTMLElement;
  filePath: string;
}

interface PdfPageMetrics {
  pageNumber: number;
  /** Unscaled width of the displayed (rotated) page in PDF units. */
  baseWidth: number;
  /** Unscaled height of the displayed (rotated) page in PDF units. */
  baseHeight: number;
  /** CSS pixel width of the page at the current zoom. */
  displayedWidth: number;
  /** CSS pixel height of the page at the current zoom. */
  displayedHeight: number;
  /** Current zoom factor. */
  scale: number;
  /** Current page rotation (0, 90, 180 or 270). */
  rotation: number;
}

interface EditingSession {
  annotation: PdfTextboxAnnotation;
  element: HTMLElement;
  editorView: EditorView;
  pageEl: HTMLElement;
  pageNumber: number;
  isNew: boolean;
  committing: boolean;
  original: {
    text: string;
    nx: number;
    ny: number;
    nw: number;
    nh: number;
  };
}

interface PlacementSession {
  pointerId: number;
  pageEl: HTMLElement;
  pageNumber: number;
  metrics: PdfPageMetrics;
  pageRect: DOMRect;
  startClientX: number;
  startClientY: number;
  preview: HTMLElement;
  moved: boolean;
}

interface PdfViewState {
  leaf: WorkspaceLeaf;
  view: PdfView;
  host: PdfViewerHost;
  rootEl: HTMLElement;
  viewerContainerEl: HTMLElement;
  viewerEl: HTMLElement;
  pdfViewer: PdfViewer;
  eventBus: PdfEventBus | null;
  filePath: string;
  editMode: boolean;
  createMode: boolean;
  component: Component;
  createButton: HTMLElement | null;
  editButton: HTMLElement | null;
  colorButton: HTMLInputElement | null;
  sizeButton: HTMLSelectElement | null;
  cleanups: Array<() => void>;
  observer: MutationObserver | null;
  resizeObserver: ResizeObserver | null;
  popupObserver: MutationObserver | null;
  editing: EditingSession | null;
  placement: PlacementSession | null;
  activeBurnedAnnotationId: string | null;
  renderFrame: number | null;
  renderTimer: number | null;
}

/* -------------------------------------------------------------------------- */
/*  Geometry helpers                                                           */
/* -------------------------------------------------------------------------- */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const snapped = Math.round(value / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

/**
 * Rotates a normalised rectangle from one page rotation to another.
 * PDF.js rotations are clockwise, so a point (x, y) becomes (1 - y, x) for 90°.
 */
function rotateNormalizedRect(
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

function baseSizeForRotation(
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

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `textbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeHexColor(value: unknown): string {
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

function coerceSettings(raw: unknown): PdfTextboxSettings {
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
    editModeEnabled:
      typeof source.editModeEnabled === "boolean"
        ? source.editModeEnabled
        : DEFAULT_SETTINGS.editModeEnabled,
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex);
  const value = Number.parseInt(normalized.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${clamp(alpha, 0, 1)})`;
}

/** Picks black or white text so the label stays readable on any background. */
function textColorForBackground(hex: string): string {
  const normalized = normalizeHexColor(hex);
  const value = Number.parseInt(normalized.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.6 ? "#1c1c1c" : "#ffffff";
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function coerceAnnotation(
  raw: unknown,
  fallbackColor = DEFAULT_SETTINGS.backgroundColor,
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
    file: normalizePath(source.file),
    page,
    x: finiteNumber(source.x, 0),
    y: finiteNumber(source.y, 0),
    width: Math.max(1, finiteNumber(source.width, 100)),
    height: Math.max(1, finiteNumber(source.height, 20)),
    nx: safeX,
    ny: safeY,
    nw: safeWidth,
    nh: safeHeight,
    rotation: normalizeRotation(finiteNumber(source.rotation, 0)),
    text: typeof source.text === "string" ? source.text : "",
    fontSize: clamp(finiteNumber(source.fontSize, DEFAULT_FONT_SIZE), 6, 96),
    color: normalizeHexColor(source.color ?? fallbackColor),
    collapsed: source.collapsed === true,
    createdAt: finiteNumber(source.createdAt, Date.now()),
    updatedAt: finiteNumber(source.updatedAt, Date.now()),
  };
}

function coerceData(raw: unknown): PdfTextboxData {
  if (!raw || typeof raw !== "object") return createEmptyData();
  const source = raw as Record<string, unknown>;
  const settings = coerceSettings(source.settings);
  const annotations = Array.isArray(source.annotations)
    ? source.annotations
        .map((entry) => coerceAnnotation(entry, settings.backgroundColor))
        .filter((entry): entry is PdfTextboxAnnotation => entry !== null)
    : [];

  return {
    version: DATA_VERSION,
    annotations,
    settings,
  };
}

/**
 * Finds the internal PDF component. The public view is a thin wrapper in
 * recent Obsidian versions; older versions expose `pdfViewer` directly.
 */
function resolvePdfHost(view: PdfView): ResolvedPdfHost | null {
  const candidates: Array<PdfViewerHost | undefined> = [
    view as unknown as PdfViewerHost,
    view.viewer,
    view.viewer?.child,
  ];

  for (const candidate of candidates) {
    const wrapper = candidate?.pdfViewer;
    if (!candidate || !wrapper) continue;

    // Obsidian's PDFViewer object delegates to the actual PDF.js viewer.
    // Coordinates and page views must come from the nested instance.
    const nested = wrapper.pdfViewer;
    const pdfViewer =
      nested && typeof nested.getPageView === "function" ? nested : wrapper;

    const rootEl = candidate.containerEl ?? view.containerEl;
    if (!rootEl) continue;

    const filePath = candidate.file?.path ?? view.file?.path ?? view.viewer?.file?.path ?? "";
    return {
      host: candidate,
      pdfViewer,
      rootEl,
      filePath: filePath ? normalizePath(filePath) : "",
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*  Small confirmation modal                                                   */
/* -------------------------------------------------------------------------- */

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Delete textboxes");
    this.contentEl.createEl("p", { text: this.message });

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText("Delete")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class BurnModal extends Modal {
  private skipWarning = false;

  constructor(
    app: App,
    private readonly count: number,
    private readonly onConfirm: (skipWarning: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Burn textboxes into PDF");
    this.contentEl.createEl("p", {
      text: `${this.count} textbox${this.count === 1 ? "" : "es"} will be rendered with Markdown/LaTeX and written directly into this PDF as images.`,
    });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "The current PDF will be overwritten. No copy is created. The textboxes will be permanently part of the PDF and can no longer be edited as textboxes.",
    });

    new Setting(this.contentEl)
      .setName("Don't show again")
      .setDesc("Skip this warning for future burn operations.")
      .addToggle((toggle) =>
        toggle.setValue(false).onChange((value) => {
          this.skipWarning = value;
        }),
      );

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText("Overwrite")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm(this.skipWarning);
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                     */
/* -------------------------------------------------------------------------- */

export default class PdfTextboxPlugin extends Plugin {
  private data: PdfTextboxData = createEmptyData();
  private readonly states = new Map<WorkspaceLeaf, PdfViewState>();
  private readonly retryTimers = new Map<WorkspaceLeaf, number>();
  private saveTimer: number | null = null;
  private syncTimer: number | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private dirty = false;
  private disposed = false;
  private burning = false;
  private colorMenuCleanup: (() => void) | null = null;
  private markdownLanguage: Extension | null = null;
  private markdownLanguagePromise: Promise<Extension | null> | null = null;
  private editorRequestId = 0;

  async onload(): Promise<void> {
    await this.loadStore();

    this.addCommand({
      id: "toggle-textbox-edit-mode",
      name: "Toggle textbox edit mode",
      checkCallback: (checking) => {
        const state = this.getActivePdfState();
        if (!state) return false;
        if (!checking) this.setEditMode(state, !state.editMode);
        return true;
      },
    });

    this.addCommand({
      id: "arm-textbox-placement",
      name: "Start textbox placement",
      checkCallback: (checking) => {
        const state = this.getActivePdfState();
        if (!state) return false;
        if (!checking) this.setCreateMode(state, true);
        return true;
      },
    });

    this.addCommand({
      id: "clear-current-pdf-textboxes",
      name: "Delete all textboxes in current PDF",
      checkCallback: (checking) => {
        const state = this.getActivePdfState();
        if (!state || state.filePath.length === 0) return false;
        if (!checking) this.confirmClearCurrentPdf(state);
        return true;
      },
    });

    this.addCommand({
      id: "burn-textboxes-to-pdf",
      name: "Burn textboxes into PDF",
      checkCallback: (checking) => {
        const state = this.getActivePdfState();
        if (!state || state.filePath.length === 0) return false;
        if (!checking) this.confirmBurnCurrentPdf(state);
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleSync()));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.scheduleSync(80)),
    );
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleSync(80)));
    this.registerEvent(this.app.workspace.on("quit", () => void this.flushSave()));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.onFileRenamed(file, oldPath)),
    );
    this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDeleted(file)));

    this.addSettingTab(new PdfTextboxSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => this.scheduleSync(0));
  }

  onunload(): void {
    this.dispose();
  }

  /* ------------------------------ persistence ----------------------------- */

  private async loadStore(): Promise<void> {
    const raw: unknown = await this.loadData();
    this.data = coerceData(raw);
  }

  /** Called by the settings tab; applies immediately and persists. */
  setSettings(patch: Partial<PdfTextboxSettings>): void {
    this.data.settings = coerceSettings({ ...this.data.settings, ...patch });
    this.requestSave();
    for (const state of this.states.values()) this.renderAll(state);
  }

  getSettings(): PdfTextboxSettings {
    return { ...this.data.settings };
  }

  private requestSave(): void {
    this.dirty = true;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  private async flushSave(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    const snapshot: PdfTextboxData = {
      version: DATA_VERSION,
      annotations: this.data.annotations
        .filter((annotation) => annotation.text.trim().length > 0)
        .map((annotation) => ({ ...annotation })),
      settings: { ...this.data.settings },
    };

    this.saveQueue = this.saveQueue
      .catch((error) => {
        console.error("PDF Textbox: previous save failed", error);
      })
      .then(() => this.saveData(snapshot));

    try {
      await this.saveQueue;
    } catch (error) {
      this.dirty = true;
      console.error("PDF Textbox: could not save data.json", error);
    }
  }

  private onFileRenamed(file: TAbstractFile, oldPath: string): void {
    const normalizedOldPath = normalizePath(oldPath);
    const newPath = normalizePath(file.path);
    let changed = false;

    for (const annotation of this.data.annotations) {
      if (annotation.file === normalizedOldPath) {
        annotation.file = newPath;
        annotation.updatedAt = Date.now();
        changed = true;
      }
    }

    if (changed) {
      this.requestSave();
      this.scheduleSync(0);
    }
  }

  private onFileDeleted(file: TAbstractFile): void {
    const path = normalizePath(file.path);
    const previousLength = this.data.annotations.length;
    this.data.annotations = this.data.annotations.filter(
      (annotation) => annotation.file !== path,
    );

    if (this.data.annotations.length !== previousLength) {
      this.requestSave();
      this.scheduleSync(0);
    }
  }

  /* --------------------------- workspace wiring --------------------------- */

  private scheduleSync(delay = 50): void {
    if (this.disposed) return;
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.syncViews();
    }, delay);
  }

  private syncViews(): void {
    if (this.disposed) return;

    let leaves: WorkspaceLeaf[] = [];
    try {
      leaves = this.app.workspace.getLeavesOfType(PDF_VIEW_TYPE);
    } catch (error) {
      console.error("PDF Textbox: could not enumerate PDF leaves", error);
      return;
    }

    const liveLeaves = new Set(leaves);

    for (const [leaf, state] of [...this.states]) {
      if (!liveLeaves.has(leaf) || leaf.view.getViewType() !== PDF_VIEW_TYPE) {
        this.destroyState(state);
      }
    }

    for (const leaf of leaves) {
      this.tryAttach(leaf, 0);
    }
  }

  private retryAttach(leaf: WorkspaceLeaf, attempt: number): void {
    if (this.disposed || attempt >= MAX_ATTACH_ATTEMPTS) return;
    if (this.retryTimers.has(leaf)) return;

    const timer = window.setTimeout(() => {
      this.retryTimers.delete(leaf);
      this.tryAttach(leaf, attempt + 1);
    }, Math.min(150 + attempt * 100, 900));

    this.retryTimers.set(leaf, timer);
  }

  private tryAttach(leaf: WorkspaceLeaf, attempt: number): void {
    if (this.disposed) return;
    if (leaf.view.getViewType() !== PDF_VIEW_TYPE) return;

    const view = leaf.view as PdfView;
    const resolved = resolvePdfHost(view);

    if (!resolved) {
      this.retryAttach(leaf, attempt);
      return;
    }

    const { host, pdfViewer, rootEl, filePath } = resolved;
    const viewerContainerEl = rootEl.querySelector<HTMLElement>(".pdf-viewer-container");
    const viewerEl = rootEl.querySelector<HTMLElement>(".pdfViewer");
    const toolbarEl =
      rootEl.querySelector<HTMLElement>(".pdf-toolbar-right") ??
      rootEl.querySelector<HTMLElement>(".pdf-toolbar-left");

    if (!viewerContainerEl || !viewerEl || !toolbarEl) {
      this.retryAttach(leaf, attempt);
      return;
    }

    const existing = this.states.get(leaf);
    if (
      existing &&
      (existing.view !== view ||
        existing.host !== host ||
        existing.pdfViewer !== pdfViewer ||
        existing.viewerContainerEl !== viewerContainerEl ||
        existing.viewerEl !== viewerEl)
    ) {
      this.destroyState(existing);
    }

    let state = this.states.get(leaf);

    if (!state) {
      state = this.createState(
        leaf,
        view,
        host,
        rootEl,
        viewerContainerEl,
        viewerEl,
        pdfViewer,
        filePath,
      );
      this.states.set(leaf, state);
    } else {
      if (state.filePath !== filePath) {
        if (state.editing) this.commitEditing(state);
        state.filePath = filePath;
      }
      state.viewerContainerEl = viewerContainerEl;
      state.viewerEl = viewerEl;
    }

    this.ensureToolbar(state);
    this.renderAll(state);
  }

  private createState(
    leaf: WorkspaceLeaf,
    view: PdfView,
    host: PdfViewerHost,
    rootEl: HTMLElement,
    viewerContainerEl: HTMLElement,
    viewerEl: HTMLElement,
    pdfViewer: PdfViewer,
    filePath: string,
  ): PdfViewState {
    const component = new Component();
    component.load();

    const state: PdfViewState = {
      leaf,
      view,
      host,
      rootEl,
      viewerContainerEl,
      viewerEl,
      pdfViewer,
      eventBus: pdfViewer.eventBus ?? host.eventBus ?? null,
      filePath,
      editMode: this.data.settings.editModeEnabled,
      createMode: false,
      component,
      createButton: null,
      editButton: null,
      colorButton: null,
      sizeButton: null,
      cleanups: [],
      observer: null,
      resizeObserver: null,
      popupObserver: null,
      editing: null,
      placement: null,
      activeBurnedAnnotationId: null,
      renderFrame: null,
      renderTimer: null,
    };

    viewerContainerEl.classList.toggle(EDIT_MODE_CLASS, state.editMode);

    const ownerDocument = viewerContainerEl.ownerDocument;
    const onPointerDown = (event: PointerEvent) =>
      this.handlePlacementPointerDown(state, event);
    const onPointerMove = (event: PointerEvent) =>
      this.handlePlacementPointerMove(state, event);
    const onPointerUp = (event: PointerEvent) =>
      this.handlePlacementPointerUp(state, event);
    const onPointerCancel = (event: PointerEvent) =>
      this.cancelPlacement(state, event);
    viewerContainerEl.addEventListener("pointerdown", onPointerDown, true);
    ownerDocument.addEventListener("pointermove", onPointerMove, true);
    ownerDocument.addEventListener("pointerup", onPointerUp, true);
    ownerDocument.addEventListener("pointercancel", onPointerCancel, true);
    state.cleanups.push(() => {
      viewerContainerEl.removeEventListener("pointerdown", onPointerDown, true);
      ownerDocument.removeEventListener("pointermove", onPointerMove, true);
      ownerDocument.removeEventListener("pointerup", onPointerUp, true);
      ownerDocument.removeEventListener("pointercancel", onPointerCancel, true);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || state.editing) return;
      const activeElement = ownerDocument.activeElement;
      const focusInPdf =
        (activeElement !== null && state.rootEl.contains(activeElement)) ||
        this.app.workspace.activeLeaf === state.leaf;
      if (!focusInPdf) return;

      if (state.createMode) {
        event.preventDefault();
        event.stopPropagation();
        this.setCreateMode(state, false);
        return;
      }

      if (state.editMode) {
        event.preventDefault();
        event.stopPropagation();
        this.setEditMode(state, false);
      }
    };
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    state.cleanups.push(() =>
      ownerDocument.removeEventListener("keydown", onKeyDown, true),
    );

    // Obsidian/PDF.js may listen for navigation keys in the capture phase on
    // window/document. Intercept them before those handlers so arrow keys move
    // the caret inside our textarea instead of turning PDF pages.
    const navigationKeys = new Set([
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "PageUp",
      "PageDown",
      "Home",
      "End",
    ]);
    const win = ownerDocument.defaultView;
    const onEarlyNavigationKey = (event: KeyboardEvent) => {
      if (!state.editing || !state.editing.editorView.dom.contains(event.target as Node)) {
        return;
      }
      if (!navigationKeys.has(event.key)) return;
      event.stopImmediatePropagation();
    };
    win?.addEventListener("keydown", onEarlyNavigationKey, true);
    win?.addEventListener("keyup", onEarlyNavigationKey, true);
    state.cleanups.push(() => {
      win?.removeEventListener("keydown", onEarlyNavigationKey, true);
      win?.removeEventListener("keyup", onEarlyNavigationKey, true);
    });

    const onEditorShortcut = (event: KeyboardEvent) => {
      const session = state.editing;
      if (!session) return;
      if (!session.editorView.dom.contains(event.target as Node)) return;

      const key = event.key.toLowerCase();
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.commitEditing(state, true);
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (key === "enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.commitEditing(state);
        return;
      }

      let handled = true;
      if (key === "b" && !event.shiftKey) {
        this.toggleMarkdownFormat(session.editorView, "**");
      } else if (key === "i" && !event.shiftKey) {
        this.toggleMarkdownFormat(session.editorView, "*");
      } else if (key === "e" && !event.shiftKey) {
        this.toggleMarkdownFormat(session.editorView, "`");
      } else if (key === "x" && event.shiftKey) {
        this.toggleMarkdownFormat(session.editorView, "~~");
      } else if (key === "h" && event.shiftKey) {
        this.toggleMarkdownFormat(session.editorView, "==");
      } else if (key === "k" && !event.shiftKey) {
        this.insertMarkdownLink(session.editorView);
      } else {
        handled = false;
      }

      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    win?.addEventListener("keydown", onEditorShortcut, true);
    state.cleanups.push(() => {
      win?.removeEventListener("keydown", onEditorShortcut, true);
    });

    const findStampAtPoint = (
      clientX: number,
      clientY: number,
      target: Element | null,
    ): HTMLElement | null => {
      const direct = target?.closest?.(".stampAnnotation");
      if (direct instanceof HTMLElement) return direct;

      const page = target?.closest?.(PAGE_SELECTOR);
      if (!(page instanceof HTMLElement)) return null;
      const stamps = Array.from(
        page.querySelectorAll<HTMLElement>(".stampAnnotation"),
      );
      for (let index = stamps.length - 1; index >= 0; index -= 1) {
        const stamp = stamps[index];
        if (!stamp) continue;
        const rect = stamp.getBoundingClientRect();
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          return stamp;
        }
      }
      return null;
    };

    const activateStamp = (
      clientX: number,
      clientY: number,
      target: Element | null,
    ): void => {
      const stamp = findStampAtPoint(clientX, clientY, target);
      if (!stamp) return;
      state.activeBurnedAnnotationId = stamp.getAttribute(
        "data-annotation-id",
      );
    };

    const onStampPointer = (event: PointerEvent) => {
      activateStamp(event.clientX, event.clientY, event.target as Element);
    };
    const onStampClick = (event: MouseEvent) => {
      activateStamp(event.clientX, event.clientY, event.target as Element);
    };
    const onStampFocus = (event: FocusEvent) => {
      const target = event.target as Element | null;
      const stamp = target?.closest?.(".stampAnnotation");
      if (!(stamp instanceof HTMLElement)) return;
      state.activeBurnedAnnotationId = stamp.getAttribute(
        "data-annotation-id",
      );
    };
    viewerContainerEl.addEventListener("pointerdown", onStampPointer, true);
    viewerContainerEl.addEventListener("click", onStampClick, true);
    viewerContainerEl.addEventListener("focusin", onStampFocus, true);
    state.cleanups.push(() => {
      viewerContainerEl.removeEventListener(
        "pointerdown",
        onStampPointer,
        true,
      );
      viewerContainerEl.removeEventListener("click", onStampClick, true);
      viewerContainerEl.removeEventListener("focusin", onStampFocus, true);
    });

    const onAnnotationKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (!state.activeBurnedAnnotationId) return;
      const target = event.target as Element | null;
      if (!target?.closest?.(".stampAnnotation, .popup")) return;
      event.preventDefault();
      event.stopPropagation();
      void this.deleteBurnedPdfAnnotation(
        state,
        state.activeBurnedAnnotationId,
      );
    };
    viewerContainerEl.addEventListener("keydown", onAnnotationKeyDown, true);
    state.cleanups.push(() =>
      viewerContainerEl.removeEventListener(
        "keydown",
        onAnnotationKeyDown,
        true,
      ),
    );

    const Observer = ownerDocument.defaultView?.MutationObserver;
    if (Observer) {
      const observer = new Observer(() => this.scheduleRenderAll(state));
      observer.observe(viewerEl, { childList: true });
      state.observer = observer;
      state.cleanups.push(() => observer.disconnect());

      const popupObserver = new Observer(() =>
        this.enhanceAnnotationPopups(state),
      );
      popupObserver.observe(viewerContainerEl, {
        childList: true,
        subtree: true,
      });
      state.popupObserver = popupObserver;
      state.cleanups.push(() => popupObserver.disconnect());
    }

    const ViewResizeObserver = ownerDocument.defaultView?.ResizeObserver;
    if (ViewResizeObserver) {
      const resizeObserver = new ViewResizeObserver(() =>
        this.scheduleRenderAll(state),
      );
      resizeObserver.observe(viewerContainerEl);
      resizeObserver.observe(viewerEl);
      state.resizeObserver = resizeObserver;
      state.cleanups.push(() => resizeObserver.disconnect());
    }

    if (state.eventBus) {
      const bus = state.eventBus;
      const handler = () => this.scheduleRenderAll(state);
      const events = [
        "pagesinit",
        "documentloaded",
        "pagerendered",
        "scalechanging",
        "rotationchanging",
        "resize",
      ];

      for (const eventName of events) {
        if (typeof bus.on === "function") {
          bus.on(eventName, handler);
          state.cleanups.push(() => bus.off?.(eventName, handler));
        } else if (typeof bus._on === "function") {
          bus._on(eventName, handler);
          state.cleanups.push(() => bus._off?.(eventName, handler));
        }
      }
    }

    return state;
  }

  private destroyState(state: PdfViewState): void {
    if (state.editing) this.commitEditing(state);
    this.cancelPlacement(state);
    this.closeAnnotationColorMenu();
    this.states.delete(state.leaf);

    const retryTimer = this.retryTimers.get(state.leaf);
    if (retryTimer !== undefined) {
      window.clearTimeout(retryTimer);
      this.retryTimers.delete(state.leaf);
    }

    if (state.renderFrame !== null) {
      state.viewerContainerEl.ownerDocument.defaultView?.cancelAnimationFrame(
        state.renderFrame,
      );
      state.renderFrame = null;
    }
    if (state.renderTimer !== null) {
      state.viewerContainerEl.ownerDocument.defaultView?.clearTimeout(
        state.renderTimer,
      );
      state.renderTimer = null;
    }

    for (const cleanup of state.cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        console.error("PDF Textbox: cleanup failed", error);
      }
    }

    state.observer?.disconnect();
    state.resizeObserver?.disconnect();
    state.popupObserver?.disconnect();
    state.createButton?.remove();
    state.editButton?.remove();
    state.colorButton?.remove();
    state.sizeButton?.remove();
    state.createButton = null;
    state.editButton = null;
    state.colorButton = null;
    state.sizeButton = null;

    state.viewerContainerEl.classList.remove(EDIT_MODE_CLASS, CREATE_MODE_CLASS);
    state.viewerEl
      .querySelectorAll<HTMLElement>(`.${LAYER_CLASS}`)
      .forEach((layer) => layer.remove());
    state.component.unload();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const state of [...this.states.values()]) {
      if (state.editing) this.commitEditing(state);
      this.destroyState(state);
    }

    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    for (const timer of this.retryTimers.values()) window.clearTimeout(timer);
    this.retryTimers.clear();

    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.flushSave();
  }

  private getActivePdfState(): PdfViewState | null {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf || leaf.view.getViewType() !== PDF_VIEW_TYPE) return null;

    this.tryAttach(leaf, 0);
    return this.states.get(leaf) ?? null;
  }

  /* -------------------------------- toolbar ------------------------------- */

  private ensureToolbar(state: PdfViewState): void {
    // There are two elements with `.pdf-toolbar`: the real toolbar and the
    // hidden find bar. Anchoring on `.pdf-toolbar-right` avoids the find bar.
    const host =
      state.rootEl.querySelector<HTMLElement>(".pdf-toolbar-right") ??
      state.rootEl.querySelector<HTMLElement>(".pdf-toolbar-left");
    if (!host) return;

    const toolbar = host.closest<HTMLElement>(".pdf-toolbar") ?? host;

    const ensureButton = (
      buttonClass: string,
      icon: string,
      label: string,
      active: boolean,
      onActivate: () => void,
    ): HTMLElement => {
      let button = toolbar.querySelector<HTMLElement>(`.${buttonClass}`);

      if (!button) {
        button = host.createDiv({
          cls: `clickable-icon ${TOOL_CLASS} ${buttonClass}`,
        });
        button.setAttr("role", "button");
        button.setAttr("tabindex", "0");
        button.setAttr("aria-label", label);
        button.setAttr("title", label);
        setIcon(button, icon);

        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          onActivate();
        });

        button.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onActivate();
        });
      } else if (button.parentElement !== host) {
        host.appendChild(button);
      }

      button.toggleClass("is-active", active);
      button.setAttr("aria-pressed", active ? "true" : "false");
      return button;
    };

    state.createButton = ensureButton(
      CREATE_TOOL_CLASS,
      "type",
      "Place textbox (one-shot)",
      state.createMode,
      () => this.setCreateMode(state, !state.createMode),
    );
    state.editButton = ensureButton(
      EDIT_TOOL_CLASS,
      "pencil",
      "Edit textboxes",
      state.editMode,
      () => this.setEditMode(state, !state.editMode),
    );

    let colorButton = toolbar.querySelector<HTMLInputElement>(
      `.${COLOR_TOOL_CLASS}`,
    );
    if (!colorButton) {
      colorButton = host.createEl("input", {
        type: "color",
        cls: COLOR_TOOL_CLASS,
      });
      colorButton.setAttr("aria-label", "Default color for new textboxes");
      colorButton.setAttr("title", "Default color for new textboxes");
      colorButton.addEventListener("input", () => {
        this.setSettings({
          backgroundColor: normalizeHexColor(colorButton?.value),
        });
      });
    } else if (colorButton.parentElement !== host) {
      host.appendChild(colorButton);
    }
    colorButton.value = this.data.settings.backgroundColor;
    state.colorButton = colorButton;

    let sizeButton = toolbar.querySelector<HTMLSelectElement>(
      `.${SIZE_TOOL_CLASS}`,
    );
    if (!sizeButton) {
      sizeButton = host.createEl("select", { cls: SIZE_TOOL_CLASS });
      sizeButton.setAttr("aria-label", "Default font size for new textboxes");
      sizeButton.setAttr("title", "Default font size for new textboxes");
      const sizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48];
      for (const size of sizes) {
        const option = sizeButton.createEl("option", {
          text: `${size} pt`,
          value: String(size),
        });
        option.value = String(size);
      }
      sizeButton.addEventListener("change", () => {
        this.setSettings({
          defaultFontSize: finiteNumber(
            sizeButton?.value,
            DEFAULT_SETTINGS.defaultFontSize,
          ),
        });
      });
    } else if (sizeButton.parentElement !== host) {
      host.appendChild(sizeButton);
    }

    const currentSize = String(this.data.settings.defaultFontSize);
    if (
      !Array.from(sizeButton.options).some(
        (option) => option.value === currentSize,
      )
    ) {
      const option = sizeButton.createEl("option", {
        text: `${currentSize} pt`,
        value: currentSize,
      });
      option.value = currentSize;
      sizeButton.appendChild(option);
    }
    sizeButton.value = currentSize;
    state.sizeButton = sizeButton;
  }

  private setEditMode(
    state: PdfViewState,
    enabled: boolean,
    persist = true,
  ): void {
    if (!enabled) this.commitEditing(state);

    state.editMode = enabled;
    state.viewerContainerEl.classList.toggle(EDIT_MODE_CLASS, enabled);
    state.editButton?.toggleClass("is-active", enabled);
    state.editButton?.setAttr("aria-pressed", enabled ? "true" : "false");

    if (!persist) return;

    this.data.settings.editModeEnabled = enabled;
    this.requestSave();

    for (const otherState of this.states.values()) {
      if (otherState !== state) {
        this.setEditMode(otherState, enabled, false);
      }
    }
  }

  private setCreateMode(state: PdfViewState, enabled: boolean): void {
    if (enabled) {
      this.commitEditing(state);
      this.closeAnnotationColorMenu();
    }
    if (!enabled) this.cancelPlacement(state);

    state.createMode = enabled;
    state.viewerContainerEl.classList.toggle(CREATE_MODE_CLASS, enabled);
    state.createButton?.toggleClass("is-active", enabled);
    state.createButton?.setAttr("aria-pressed", enabled ? "true" : "false");
  }

  /* ------------------------------ interaction ----------------------------- */

  private handlePlacementPointerDown(
    state: PdfViewState,
    event: PointerEvent,
  ): void {
    if (!state.createMode || state.placement || event.button !== 0) return;

    const target = event.target as Element | null;
    if (!target || typeof target.closest !== "function") return;

    const pageEl = target.closest<HTMLElement>(PAGE_SELECTOR);
    if (!pageEl || !state.viewerEl.contains(pageEl)) return;

    const metrics = this.getPageMetrics(state, pageEl);
    const pageRect = this.getPageContentRect(pageEl);
    if (!metrics || pageRect.width <= 0 || pageRect.height <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    const preview = state.viewerEl.ownerDocument.createElement("div");
    preview.className = "pdf-textbox-placement";
    this.ensureLayer(pageEl).appendChild(preview);

    state.placement = {
      pointerId: event.pointerId,
      pageEl,
      pageNumber: metrics.pageNumber,
      metrics,
      pageRect,
      startClientX: event.clientX,
      startClientY: event.clientY,
      preview,
      moved: false,
    };

    try {
      state.viewerContainerEl.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a best-effort enhancement.
    }
  }

  private handlePlacementPointerMove(
    state: PdfViewState,
    event: PointerEvent,
  ): void {
    const session = state.placement;
    if (!session || event.pointerId !== session.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    const deltaX = event.clientX - session.startClientX;
    const deltaY = event.clientY - session.startClientY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      session.moved = true;
    }

    const left = clamp(
      Math.min(session.startClientX, event.clientX) - session.pageRect.left,
      0,
      session.pageRect.width,
    );
    const top = clamp(
      Math.min(session.startClientY, event.clientY) - session.pageRect.top,
      0,
      session.pageRect.height,
    );
    const width = clamp(
      Math.abs(deltaX),
      0,
      session.pageRect.width - left,
    );
    const height = clamp(
      Math.abs(deltaY),
      0,
      session.pageRect.height - top,
    );

    session.preview.style.left = `${(left / session.pageRect.width) * 100}%`;
    session.preview.style.top = `${(top / session.pageRect.height) * 100}%`;
    session.preview.style.width = `${(width / session.pageRect.width) * 100}%`;
    session.preview.style.height = `${(height / session.pageRect.height) * 100}%`;
  }

  private handlePlacementPointerUp(
    state: PdfViewState,
    event: PointerEvent,
  ): void {
    const session = state.placement;
    if (!session || event.pointerId !== session.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    const displayWidth = Math.abs(event.clientX - session.startClientX);
    const displayHeight = Math.abs(event.clientY - session.startClientY);
    const didDrag =
      session.moved && displayWidth >= 6 && displayHeight >= 6;

    this.finishPlacement(state);

    let created = false;
    if (didDrag) {
      const left = Math.min(session.startClientX, event.clientX);
      const top = Math.min(session.startClientY, event.clientY);
      const right = Math.max(session.startClientX, event.clientX);
      const bottom = Math.max(session.startClientY, event.clientY);
      const startPoint = this.screenToPagePoint(
        left,
        top,
        session.pageEl,
        session.metrics,
      );
      const endPoint = this.screenToPagePoint(
        right,
        bottom,
        session.pageEl,
        session.metrics,
      );

      created = this.createAnnotationInBounds(
        state,
        session.pageEl,
        session.metrics,
        startPoint.x,
        startPoint.y,
        endPoint.x - startPoint.x,
        endPoint.y - startPoint.y,
      );
    } else {
      created = this.createAnnotationAt(
        state,
        session.pageEl,
        session.startClientX,
        session.startClientY,
      );
    }

    if (created) this.setCreateMode(state, false);
  }

  private finishPlacement(state: PdfViewState): void {
    const session = state.placement;
    if (!session) return;
    state.placement = null;
    try {
      state.viewerContainerEl.releasePointerCapture(session.pointerId);
    } catch {
      // The pointer may already have been released.
    }
    session.preview.remove();
  }

  private cancelPlacement(
    state: PdfViewState,
    event?: PointerEvent,
  ): void {
    const session = state.placement;
    if (!session) return;
    if (event && event.pointerId !== session.pointerId) return;
    event?.preventDefault();
    event?.stopPropagation();
    this.finishPlacement(state);
  }

  private createAnnotationAt(
    state: PdfViewState,
    pageEl: HTMLElement,
    clientX: number,
    clientY: number,
  ): boolean {
    if (!state.filePath) return false;

    const metrics = this.getPageMetrics(state, pageEl);
    if (!metrics) return false;

    const point = this.screenToPagePoint(clientX, clientY, pageEl, metrics);
    const widthPercent = clamp(this.data.settings.defaultWidthPercent, 5, 80);
    const width = clamp(
      (metrics.baseWidth * widthPercent) / 100,
      Math.min(24, metrics.baseWidth),
      metrics.baseWidth,
    );
    const height = clamp(
      MIN_HEIGHT_PDF,
      12,
      Math.max(12, metrics.baseHeight * 0.08),
    );

    return this.createAnnotationInBounds(
      state,
      pageEl,
      metrics,
      point.x,
      point.y,
      width,
      height,
    );
  }

  private createAnnotationInBounds(
    state: PdfViewState,
    pageEl: HTMLElement,
    metrics: PdfPageMetrics,
    x: number,
    y: number,
    width: number,
    height: number,
  ): boolean {
    if (!state.filePath) return false;

    // Finish an open editor before adding a new box. Committing triggers a
    // re-render, so this must happen before the new element is appended.
    if (state.editing) this.commitEditing(state);

    const safeWidth = clamp(
      width,
      Math.min(24, metrics.baseWidth),
      metrics.baseWidth,
    );
    const safeHeight = clamp(
      height,
      12,
      metrics.baseHeight,
    );
    const safeX = clamp(x, 0, Math.max(0, metrics.baseWidth - safeWidth));
    const safeY = clamp(y, 0, Math.max(0, metrics.baseHeight - safeHeight));

    const annotation: PdfTextboxAnnotation = {
      id: createId(),
      file: state.filePath,
      page: metrics.pageNumber,
      x: safeX,
      y: safeY,
      width: safeWidth,
      height: safeHeight,
      nx: safeX / metrics.baseWidth,
      ny: safeY / metrics.baseHeight,
      nw: safeWidth / metrics.baseWidth,
      nh: safeHeight / metrics.baseHeight,
      rotation: metrics.rotation,
      text: "",
      fontSize: this.data.settings.defaultFontSize,
      color: this.data.settings.backgroundColor,
      collapsed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const layer = this.ensureLayer(pageEl);
    const element = this.createAnnotationElement(state, annotation);
    layer.appendChild(element);
    this.applyAnnotationGeometry(element, annotation, metrics);
    this.startEditing(state, annotation, element, pageEl, true);
    return true;
  }

  private createAnnotationElement(
    state: PdfViewState,
    annotation: PdfTextboxAnnotation,
  ): HTMLElement {
    const ownerDocument = state.viewerEl.ownerDocument;
    const element = ownerDocument.createElement("div");
    element.className = ANNOTATION_CLASS;
    element.dataset.id = annotation.id;
    element.dataset.pageNumber = String(annotation.page);

    const body = ownerDocument.createElement("div");
    body.className = "pdf-textbox-body markdown-rendered";
    element.appendChild(body);

    const grip = ownerDocument.createElement("div");
    grip.className = "pdf-textbox-grip";
    grip.setAttribute("aria-hidden", "true");
    element.appendChild(grip);

    const deleteButton = ownerDocument.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "pdf-textbox-delete";
    deleteButton.setAttribute("aria-label", "Delete textbox");
    deleteButton.setAttribute("title", "Delete textbox");
    setIcon(deleteButton, "x");
    element.appendChild(deleteButton);

    const collapseButton = ownerDocument.createElement("button");
    collapseButton.type = "button";
    collapseButton.className = "pdf-textbox-collapse";
    collapseButton.setAttribute("aria-label", "Collapse textbox");
    collapseButton.setAttribute("title", "Collapse textbox");
    setIcon(collapseButton, "minus");
    element.appendChild(collapseButton);

    const collapsedIcon = ownerDocument.createElement("button");
    collapsedIcon.type = "button";
    collapsedIcon.className = "pdf-textbox-collapsed-icon";
    collapsedIcon.setAttribute("aria-label", "Expand textbox");
    collapsedIcon.setAttribute("title", "Expand textbox");
    setIcon(collapsedIcon, "type");
    element.appendChild(collapsedIcon);

    const resizeHandle = ownerDocument.createElement("div");
    resizeHandle.className = "pdf-textbox-resize";
    resizeHandle.setAttribute("aria-hidden", "true");
    element.appendChild(resizeHandle);

    deleteButton.addEventListener("pointerdown", (event) => {
      // Prevent the textarea from committing before the click handler runs.
      event.preventDefault();
      event.stopPropagation();
    });
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.deleteAnnotation(state, annotation.id);
    });

    collapseButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    collapseButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!state.editMode) return;
      annotation.collapsed = true;
      annotation.updatedAt = Date.now();
      this.applyCollapsedState(element, annotation);
      this.requestSave();
    });

    collapsedIcon.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    collapsedIcon.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      annotation.collapsed = false;
      annotation.updatedAt = Date.now();
      this.applyCollapsedState(element, annotation);
      this.requestSave();
    });

    element.addEventListener("pointerenter", () => {
      if (annotation.collapsed) element.classList.add("is-hover-expanded");
    });
    element.addEventListener("pointerleave", () => {
      if (annotation.collapsed) element.classList.remove("is-hover-expanded");
    });

    grip.addEventListener("pointerdown", (event) => {
      this.startDragging(state, annotation, element, event);
    });

    resizeHandle.addEventListener("pointerdown", (event) => {
      this.startResizing(state, annotation, element, event);
    });

    element.addEventListener("contextmenu", (event) => {
      if (!state.editMode && state.editing?.annotation.id !== annotation.id) {
        return;
      }
      const target = event.target as Element | null;
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest(
          ".pdf-textbox-input, .pdf-textbox-delete, .pdf-textbox-grip, .pdf-textbox-resize, .pdf-textbox-collapse, .pdf-textbox-collapsed-icon",
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.openAnnotationColorMenu(
        state,
        annotation,
        element,
        event.clientX,
        event.clientY,
      );
    });

    element.addEventListener("click", (event) => {
      if (!state.editMode) return;
      const target = event.target as Element | null;
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest(
          ".pdf-textbox-input, .pdf-textbox-delete, .pdf-textbox-grip, .pdf-textbox-resize, .pdf-textbox-collapse, .pdf-textbox-collapsed-icon",
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (state.editing?.annotation.id === annotation.id) return;
      this.startEditing(state, annotation, element, this.findPageElement(state, annotation.page), false);
    });

    return element;
  }

  private startDragging(
    state: PdfViewState,
    annotation: PdfTextboxAnnotation,
    element: HTMLElement,
    event: PointerEvent,
  ): void {
    if (!state.editMode || state.editing) return;

    const pageEl = this.findPageElement(state, annotation.page);
    if (!pageEl) return;

    const metrics = this.getPageMetrics(state, pageEl);
    const pageRect = this.getPageContentRect(pageEl);
    if (!metrics || pageRect.width <= 0 || pageRect.height <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startNormalized = rotateNormalizedRect(
      annotation.nx,
      annotation.ny,
      annotation.nw,
      annotation.nh,
      annotation.rotation,
      metrics.rotation,
    );

    const ownerDocument = element.ownerDocument;
    element.classList.add("is-dragging");

    const onMove = (moveEvent: PointerEvent): void => {
      const deltaX = (moveEvent.clientX - startX) / pageRect.width;
      const deltaY = (moveEvent.clientY - startY) / pageRect.height;
      const movedX = clamp(
        startNormalized.x + deltaX,
        0,
        Math.max(0, 1 - startNormalized.width),
      );
      const movedY = clamp(
        startNormalized.y + deltaY,
        0,
        Math.max(0, 1 - startNormalized.height),
      );

      const back = rotateNormalizedRect(
        movedX,
        movedY,
        startNormalized.width,
        startNormalized.height,
        metrics.rotation,
        annotation.rotation,
      );

      annotation.nx = back.x;
      annotation.ny = back.y;
      this.applyAnnotationGeometry(element, annotation, metrics);
    };

    const onUp = (): void => {
      ownerDocument.removeEventListener("pointermove", onMove);
      ownerDocument.removeEventListener("pointerup", onUp);
      ownerDocument.removeEventListener("pointercancel", onUp);
      element.classList.remove("is-dragging");
      this.updatePdfCoordinates(annotation, metrics);
      annotation.updatedAt = Date.now();
      this.requestSave();
    };

    ownerDocument.addEventListener("pointermove", onMove);
    ownerDocument.addEventListener("pointerup", onUp);
    ownerDocument.addEventListener("pointercancel", onUp);
  }

  private startResizing(
    state: PdfViewState,
    annotation: PdfTextboxAnnotation,
    element: HTMLElement,
    event: PointerEvent,
  ): void {
    if (!state.editMode || state.editing) return;

    const pageEl = this.findPageElement(state, annotation.page);
    if (!pageEl) return;

    const metrics = this.getPageMetrics(state, pageEl);
    const pageRect = this.getPageContentRect(pageEl);
    if (!metrics || pageRect.width <= 0 || pageRect.height <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startNormalized = rotateNormalizedRect(
      annotation.nx,
      annotation.ny,
      annotation.nw,
      annotation.nh,
      annotation.rotation,
      metrics.rotation,
    );

    const ownerDocument = element.ownerDocument;
    element.classList.add("is-resizing");

    const onMove = (moveEvent: PointerEvent): void => {
      const deltaX = (moveEvent.clientX - startX) / pageRect.width;
      const deltaY = (moveEvent.clientY - startY) / pageRect.height;
      const width = clamp(
        startNormalized.width + deltaX,
        0.04,
        Math.max(0.04, 1 - startNormalized.x),
      );
      const height = clamp(
        startNormalized.height + deltaY,
        0.005,
        Math.max(0.005, 1 - startNormalized.y),
      );

      const back = rotateNormalizedRect(
        startNormalized.x,
        startNormalized.y,
        width,
        height,
        metrics.rotation,
        annotation.rotation,
      );

      annotation.nx = clamp(back.x, 0, Math.max(0, 1 - back.width));
      annotation.ny = clamp(back.y, 0, Math.max(0, 1 - back.height));
      annotation.nw = clamp(back.width, 0.04, 1);
      annotation.nh = clamp(back.height, 0.005, 1);
      this.applyAnnotationGeometry(element, annotation, metrics);
    };

    const onUp = (): void => {
      ownerDocument.removeEventListener("pointermove", onMove);
      ownerDocument.removeEventListener("pointerup", onUp);
      ownerDocument.removeEventListener("pointercancel", onUp);
      element.classList.remove("is-resizing");
      this.updateNormalizedRectFromElement(annotation, element, pageEl, metrics);
      this.updatePdfCoordinates(annotation, metrics);
      annotation.updatedAt = Date.now();
      this.requestSave();
    };

    ownerDocument.addEventListener("pointermove", onMove);
    ownerDocument.addEventListener("pointerup", onUp);
    ownerDocument.addEventListener("pointercancel", onUp);
  }

  private startEditing(
    state: PdfViewState,
    annotation: PdfTextboxAnnotation,
    element: HTMLElement,
    pageEl: HTMLElement | null,
    isNew: boolean,
  ): void {
    void this.startEditingAsync(
      state,
      annotation,
      element,
      pageEl,
      isNew,
    ).catch((error) => {
      console.error("PDF Textbox: could not open the textbox editor", error);
    });
  }

  private async startEditingAsync(
    state: PdfViewState,
    annotation: PdfTextboxAnnotation,
    element: HTMLElement,
    pageEl: HTMLElement | null,
    isNew: boolean,
  ): Promise<void> {
    if (!pageEl) return;
    const requestId = ++this.editorRequestId;
    if (state.editing) this.commitEditing(state);

    const body = element.querySelector<HTMLElement>(".pdf-textbox-body");
    if (!body) return;

    if (annotation.collapsed) {
      annotation.collapsed = false;
      annotation.updatedAt = Date.now();
      this.applyCollapsedState(element, annotation);
      this.requestSave();
    }

    const markdownLanguage = await this.ensureMarkdownLanguage();
    if (
      requestId !== this.editorRequestId ||
      !element.isConnected ||
      state.editing
    ) {
      return;
    }

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      EditorView.theme({
        "&": {
          height: "auto",
          backgroundColor: "transparent",
          color: "inherit",
          fontFamily: "inherit",
          fontSize: "inherit",
          lineHeight: "inherit",
        },
        "&.cm-focused": {
          outline: "none",
        },
        ".cm-scroller": {
          overflow: "visible",
          fontFamily: "inherit",
          lineHeight: "inherit",
        },
        ".cm-content": {
          padding: "0",
          caretColor: "currentColor",
          color: "inherit",
          fontFamily: "inherit",
        },
        ".cm-line": {
          padding: "0",
        },
        ".cm-gutters": {
          display: "none",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: "currentColor",
          borderLeftWidth: "2px",
        },
        ".cm-selectionBackground": {
          backgroundColor: "rgba(127, 127, 127, 0.3)",
        },
      }),
      editorLivePreviewField,
    ];

    if (markdownLanguage) extensions.push(markdownLanguage);

    const latexSuiteExtensions = this.getLatexSuiteExtensions();
    if (markdownLanguage && latexSuiteExtensions) {
      extensions.push(latexSuiteExtensions);
    }

    extensions.push(
      Prec.high(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              this.commitEditing(state);
              return true;
            },
          },
          {
            key: "Escape",
            run: () => {
              this.commitEditing(state, true);
              return true;
            },
          },
          {
            key: "Mod-b",
            run: (view) => this.toggleMarkdownFormat(view, "**"),
          },
          {
            key: "Mod-i",
            run: (view) => this.toggleMarkdownFormat(view, "*"),
          },
          {
            key: "Mod-e",
            run: (view) => this.toggleMarkdownFormat(view, "`"),
          },
          {
            key: "Mod-Shift-x",
            run: (view) => this.toggleMarkdownFormat(view, "~~"),
          },
          {
            key: "Mod-Shift-h",
            run: (view) => this.toggleMarkdownFormat(view, "=="),
          },
          {
            key: "Mod-k",
            run: (view) => this.insertMarkdownLink(view),
          },
        ]),
      ),
      keymap.of([...defaultKeymap, ...historyKeymap]),
    );

    const editorView = new EditorView({
      state: EditorState.create({
        doc: annotation.text,
        selection: EditorSelection.cursor(annotation.text.length),
        extensions,
      }),
      parent: element,
    });
    editorView.dom.classList.add("pdf-textbox-input", "pdf-textbox-editor");

    body.classList.add("is-hidden");
    element.classList.add("is-editing");
    element.style.height = "auto";

    const session: EditingSession = {
      annotation,
      element,
      editorView,
      pageEl,
      pageNumber: annotation.page,
      isNew,
      committing: false,
      original: {
        text: annotation.text,
        nx: annotation.nx,
        ny: annotation.ny,
        nw: annotation.nw,
        nh: annotation.nh,
      },
    };
    state.editing = session;

    editorView.dom.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (
          state.editing === session &&
          !session.committing &&
          !editorView.hasFocus
        ) {
          this.commitEditing(state);
        }
      }, 0);
    });

    editorView.focus();
    window.setTimeout(() => {
      if (state.editing === session) editorView.focus();
    }, 60);
  }

  private toggleMarkdownFormat(
    view: EditorView,
    before: string,
    after = before,
  ): boolean {
    const state = view.state;
    const spec = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      const outerStart = range.from - before.length;
      const outerEnd = range.to + after.length;

      if (range.empty) {
        return {
          changes: { from: range.from, insert: `${before}${after}` },
          range: EditorSelection.cursor(range.from + before.length),
        };
      }

      if (
        outerStart >= 0 &&
        outerEnd <= state.doc.length &&
        state.sliceDoc(outerStart, range.from) === before &&
        state.sliceDoc(range.to, outerEnd) === after
      ) {
        return {
          changes: {
            from: outerStart,
            to: outerEnd,
            insert: selected,
          },
          range: EditorSelection.range(
            outerStart,
            outerStart + selected.length,
          ),
        };
      }

      return {
        changes: {
          from: range.from,
          to: range.to,
          insert: `${before}${selected}${after}`,
        },
        range: EditorSelection.range(
          range.from + before.length,
          range.to + before.length,
        ),
      };
    });

    view.dispatch(
      state.update({
        changes: spec.changes,
        selection: spec.selection,
        scrollIntoView: true,
      }),
    );
    view.focus();
    return true;
  }

  private insertMarkdownLink(view: EditorView): boolean {
    const state = view.state;
    const spec = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to) || "text";
      const insert = `[${selected}](url)`;
      const urlStart = range.from + selected.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlStart, urlStart + 3),
      };
    });

    view.dispatch(
      state.update({
        changes: spec.changes,
        selection: spec.selection,
        scrollIntoView: true,
      }),
    );
    view.focus();
    return true;
  }

  private getLatexSuiteExtensions(): Extension | null {
    const plugins = (
      this.app as unknown as {
        plugins?: {
          plugins?: Record<string, { editorExtensions?: unknown }>;
        };
      }
    ).plugins?.plugins;
    const extensions = plugins?.["obsidian-latex-suite"]?.editorExtensions;
    return extensions ? (extensions as Extension) : null;
  }

  private async ensureMarkdownLanguage(): Promise<Extension | null> {
    if (this.markdownLanguage) return this.markdownLanguage;
    if (!this.markdownLanguagePromise) {
      this.markdownLanguagePromise = this.loadMarkdownLanguage().catch(
        (error) => {
          // Never cache a failed load: a rejected promise would make every
          // later attempt to open a textbox fail as well.
          console.error("PDF Textbox: could not load Markdown language", error);
          this.markdownLanguagePromise = null;
          return null;
        },
      );
    }
    return this.markdownLanguagePromise;
  }

  private findMarkdownLanguage(): Extension | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      try {
        // Markdown leaves can exist without a loaded editor, e.g. a note in a
        // collapsed sidebar or a leaf that is still deferred. Reading
        // `view.editor.cm` would throw for those and abort the whole textbox
        // editor start, so skip them.
        const view = leaf.view as MarkdownView | undefined;
        const editor = view?.editor as unknown as
          | { cm?: EditorView }
          | undefined;
        const editorView = editor?.cm;
        const languageExtension = editorView?.state.facet(language);
        if (languageExtension) return languageExtension as Extension;
      } catch {
        // Ignore leaves that are not ready yet.
      }
    }
    return null;
  }

  private async loadMarkdownLanguage(): Promise<Extension | null> {
    const existing = this.findMarkdownLanguage();
    if (existing) {
      this.markdownLanguage = existing;
      return existing;
    }

    const file = this.app.vault.getMarkdownFiles()[0];
    if (!file) return null;

    const previousLeaf = this.app.workspace.activeLeaf;
    const temporaryLeaf = this.app.workspace.getLeaf("tab");

    try {
      await temporaryLeaf.openFile(file);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        const languageExtension = this.findMarkdownLanguage();
        if (languageExtension) {
          this.markdownLanguage = languageExtension;
          return languageExtension;
        }
      }
    } catch (error) {
      console.error("PDF Textbox: could not load Markdown language", error);
    } finally {
      temporaryLeaf.detach();
      if (previousLeaf) {
        try {
          this.app.workspace.setActiveLeaf(previousLeaf, { focus: true });
        } catch {
          // The previous leaf may no longer exist.
        }
      }
    }

    return null;
  }

  private commitEditing(state: PdfViewState, cancel = false): void {
    const session = state.editing;
    if (!session) return;

    state.editing = null;
    session.committing = true;

    const { annotation, element, editorView, pageEl, isNew, original } = session;
    const value = editorView.state.doc.toString();
    const metrics = this.getPageMetrics(state, pageEl);
    const pageRect = this.getPageContentRect(pageEl);
    const elementRect = element.getBoundingClientRect();

    if (cancel) {
      if (!isNew) {
        annotation.text = original.text;
        annotation.nx = original.nx;
        annotation.ny = original.ny;
        annotation.nw = original.nw;
        annotation.nh = original.nh;
        if (metrics) this.updatePdfCoordinates(annotation, metrics);
      }
    } else if (value.trim().length === 0) {
      if (!isNew) {
        const index = this.data.annotations.findIndex(
          (entry) => entry.id === annotation.id,
        );
        if (index >= 0) {
          this.data.annotations.splice(index, 1);
          this.requestSave();
        }
      }
    } else {
      annotation.text = value;

      if (metrics && pageRect.width > 0 && pageRect.height > 0) {
        const measuredX = (elementRect.left - pageRect.left) / pageRect.width;
        const measuredY = (elementRect.top - pageRect.top) / pageRect.height;
        const measuredWidth = elementRect.width / pageRect.width;
        const measuredHeight = elementRect.height / pageRect.height;

        const back = rotateNormalizedRect(
          measuredX,
          measuredY,
          measuredWidth,
          measuredHeight,
          metrics.rotation,
          annotation.rotation,
        );

        annotation.nw = clamp(back.width, 0.02, 1);
        annotation.nh = clamp(back.height, 0.005, 1);
        annotation.nx = clamp(back.x, 0, Math.max(0, 1 - annotation.nw));
        annotation.ny = clamp(back.y, 0, Math.max(0, 1 - annotation.nh));
        this.updatePdfCoordinates(annotation, metrics);
      }

      annotation.updatedAt = Date.now();
      if (isNew) this.data.annotations.push(annotation);
      this.requestSave();
    }

    element.remove();
    editorView.destroy();

    const currentPageEl = this.findPageElement(state, session.pageNumber);
    if (currentPageEl) this.renderPage(state, currentPageEl);
  }

  private deleteAnnotation(state: PdfViewState, id: string): void {
    const session = state.editing;
    if (session?.annotation.id === id) {
      session.committing = true;
      state.editing = null;
      session.editorView.destroy();
    }

    const element = state.viewerEl.querySelector<HTMLElement>(
      `.${ANNOTATION_CLASS}[data-id="${escapeSelectorValue(id)}"]`,
    );
    element?.remove();

    const index = this.data.annotations.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.data.annotations.splice(index, 1);
      this.requestSave();
    }

    this.renderAll(state);
  }

  private confirmClearCurrentPdf(state: PdfViewState): void {
    const count = this.data.annotations.filter(
      (annotation) => annotation.file === state.filePath,
    ).length;

    if (count === 0) {
      new Notice("This PDF contains no textboxes.");
      return;
    }

    new ConfirmModal(
      this.app,
      `Remove ${count} textbox${count === 1 ? "" : "es"} from this PDF?`,
      () => {
        this.data.annotations = this.data.annotations.filter(
          (annotation) => annotation.file !== state.filePath,
        );
        this.requestSave();
        for (const otherState of this.states.values()) {
          if (otherState.filePath === state.filePath) this.renderAll(otherState);
        }
        new Notice(`${count} textbox${count === 1 ? "" : "es"} removed.`);
      },
    ).open();
  }

  /* -------------------------------- burning ------------------------------- */

  private confirmBurnCurrentPdf(state: PdfViewState): void {
    if (state.editing) this.commitEditing(state);

    const count = this.data.annotations.filter(
      (annotation) =>
        annotation.file === state.filePath && annotation.text.trim().length > 0,
    ).length;

    if (count === 0) {
      new Notice("This PDF contains no textboxes.");
      return;
    }

    const run = (skipWarning: boolean): void => {
      if (skipWarning) this.setSettings({ confirmBeforeBurn: false });
      void this.burnCurrentPdf(state.filePath);
    };

    if (this.data.settings.confirmBeforeBurn) {
      new BurnModal(this.app, count, run).open();
    } else {
      run(false);
    }
  }

  private confirmBurnSingleTextbox(
    state: PdfViewState,
    annotation: PdfTextboxAnnotation,
  ): void {
    if (state.editing) this.commitEditing(state);
    if (annotation.text.trim().length === 0) {
      new Notice("This textbox is empty.");
      return;
    }

    const run = (skipWarning: boolean): void => {
      if (skipWarning) this.setSettings({ confirmBeforeBurn: false });
      void this.burnCurrentPdf(state.filePath, [annotation]);
    };

    if (this.data.settings.confirmBeforeBurn) {
      new BurnModal(this.app, 1, run).open();
    } else {
      run(false);
    }
  }

  private async burnCurrentPdf(
    filePath: string,
    only?: readonly PdfTextboxAnnotation[],
  ): Promise<void> {
    if (this.burning) {
      new Notice("A burn operation is already running.");
      return;
    }

    const annotations = (only ?? this.data.annotations).filter(
      (annotation) =>
        annotation.file === filePath && annotation.text.trim().length > 0,
    );
    const sourceFile = this.app.vault.getAbstractFileByPath(filePath);
    if (!(sourceFile instanceof TFile) || sourceFile.extension !== "pdf") {
      new Notice("The current PDF could not be found.");
      return;
    }

    this.burning = true;
    const progress = new Notice("Burning textboxes into the PDF…", 0);

    try {
      const sourceBytes = await this.app.vault.readBinary(sourceFile);
      const pdf = await PDFDocument.load(sourceBytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      const pages = pdf.getPages();
      let burnedCount = 0;
      const burnedIds = new Set<string>();

      for (const annotation of annotations) {
        const page = pages[annotation.page - 1];
        if (!page) continue;

        const { width: pageWidth, height: pageHeight } = page.getSize();
        const rotation = normalizeRotation(page.getRotation().angle);
        const rotated = rotation === 90 || rotation === 270;
        const baseWidth = rotated ? pageHeight : pageWidth;
        const baseHeight = rotated ? pageWidth : pageHeight;

        const display = rotateNormalizedRect(
          annotation.nx,
          annotation.ny,
          annotation.nw,
          annotation.nh,
          annotation.rotation,
          rotation,
        );

        let width = clamp(display.width * baseWidth, 12, baseWidth);
        const left = clamp(
          display.x * baseWidth,
          0,
          Math.max(0, baseWidth - width),
        );
        const minHeight = clamp(
          display.height * baseHeight,
          8,
          baseHeight,
        );
        let top = clamp(
          display.y * baseHeight,
          0,
          Math.max(0, baseHeight - minHeight),
        );

        const burn = await this.createBurnElement(
          filePath,
          annotation.text,
          width,
          annotation.fontSize,
          annotation.color,
          minHeight,
        );

        try {
          const height = clamp(
            Math.max(
              minHeight,
              burn.element.offsetHeight,
              burn.element.scrollHeight,
            ),
            8,
            baseHeight,
          );
          if (top + height > baseHeight) {
            top = Math.max(0, baseHeight - height);
          }

          const canvas = await html2canvas(burn.element, {
            backgroundColor: null,
            scale: 3,
            logging: false,
            useCORS: true,
            width: burn.element.offsetWidth,
            height: burn.element.offsetHeight,
          });
          const rotatedCanvas = this.rotateCanvasForPdf(canvas, rotation);
          const pngBytes = await this.canvasToPngBytes(rotatedCanvas);
          const image = await pdf.embedPng(pngBytes);
          const rect = this.annotationRectForRotation(
            rotation,
            pageWidth,
            pageHeight,
            left,
            top,
            width,
            height,
          );

          const appearance = pdf.context.stream(
            `q\n${rect.width} 0 0 ${rect.height} 0 0 cm\n/Im0 Do\nQ\n`,
            {
              Type: "XObject",
              Subtype: "Form",
              FormType: 1,
              BBox: [0, 0, rect.width, rect.height],
              Resources: { XObject: { Im0: image.ref } },
            },
          );
          const appearanceRef = pdf.context.register(appearance);

          const annotationDict = pdf.context.obj({
            Type: "Annot",
            Subtype: "Stamp",
            Rect: [rect.x0, rect.y0, rect.x1, rect.y1],
            P: page.ref,
            Border: [0, 0, 0],
            F: 4,
            AP: { N: appearanceRef },
            NM: PDFString.of(annotation.id),
            T: PDFHexString.fromText("PDF Textbox"),
            Contents: PDFHexString.fromText(annotation.text),
          });
          const annotationRef = pdf.context.register(annotationDict);

          let pageAnnotations = page.node.lookupMaybe(
            PDFName.of("Annots"),
            PDFArray,
          );
          if (!pageAnnotations) {
            pageAnnotations = pdf.context.obj([]);
            page.node.set(PDFName.of("Annots"), pageAnnotations);
          }
          pageAnnotations.push(annotationRef);

          burnedCount += 1;
          burnedIds.add(annotation.id);
        } finally {
          burn.host.remove();
        }
      }

      if (burnedCount === 0) {
        new Notice("No textboxes could be burned into the PDF.");
        return;
      }

      const bytes = await pdf.save();
      const targetBytes = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      await this.app.vault.modifyBinary(sourceFile, targetBytes);

      // The burned textboxes are now part of the PDF. Remove only the
      // annotations that were actually baked so the same boxes do not appear
      // twice on top of the replaced file.
      this.data.annotations = this.data.annotations.filter(
        (annotation) => !burnedIds.has(annotation.id),
      );
      this.dirty = true;
      await this.flushSave();

      // Reload open views of this file so the old overlays disappear and the
      // newly written PDF is shown.
      for (const otherState of [...this.states.values()]) {
        if (otherState.filePath !== filePath) continue;
        if (typeof otherState.view.loadFile === "function") {
          try {
            await otherState.view.loadFile(sourceFile);
          } catch (error) {
            console.error("PDF Textbox: could not reload burned PDF", error);
          }
        }
      }

      new Notice(
        `${burnedCount} textbox${burnedCount === 1 ? "" : "es"} permanently burned into the PDF.`,
        8000,
      );
      this.scheduleSync(0);
    } catch (error) {
      console.error("PDF Textbox: burning failed", error);
      new Notice(
        `Burning failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        8000,
      );
    } finally {
      progress.hide();
      this.burning = false;
    }
  }

  private async createBurnElement(
    sourcePath: string,
    markdown: string,
    width: number,
    fontSize: number,
    color: string,
    minHeight: number,
  ): Promise<{ host: HTMLElement; element: HTMLElement }> {
    const host = document.createElement("div");
    host.className = "pdf-textbox-burn-host";

    const element = document.createElement("div");
    element.className = "pdf-textbox-annotation pdf-textbox-burn-box";
    element.style.position = "relative";
    element.style.left = "0";
    element.style.top = "0";
    element.style.width = `${width}px`;
    element.style.minHeight = `${minHeight}px`;
    element.style.fontSize = `${fontSize}px`;
    element.style.padding = "2.5px 4.5px";
    element.style.borderRadius = "3px";
    element.style.backgroundColor = hexToRgba(
      color,
      this.data.settings.backgroundColorOpacity,
    );
    element.style.color = textColorForBackground(color);

    const body = document.createElement("div");
    body.className = "pdf-textbox-body markdown-rendered";
    element.appendChild(body);
    host.appendChild(element);
    document.body.appendChild(host);

    try {
      await MarkdownRenderer.render(
        this.app,
        markdown,
        body,
        sourcePath,
        this,
      );
      await this.waitForBurnContent(body);
    } catch (error) {
      host.remove();
      throw error;
    }

    return { host, element };
  }

  private async waitForBurnContent(container: HTMLElement): Promise<void> {
    const doc = container.ownerDocument;

    try {
      await doc.fonts?.ready;
    } catch {
      // Font loading is best effort.
    }

    const images = Array.from(container.querySelectorAll("img"));
    await Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolve) => {
            if (image.complete) {
              resolve();
              return;
            }
            const finish = (): void => resolve();
            image.addEventListener("load", finish, { once: true });
            image.addEventListener("error", finish, { once: true });
            window.setTimeout(finish, 1500);
          }),
      ),
    );

    const mathNodes = Array.from(container.querySelectorAll(".math"));
    if (mathNodes.length > 0) {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const pending = mathNodes.some(
          (node) => !node.querySelector("mjx-container, svg"),
        );
        if (!pending) break;
        await new Promise((resolve) => window.setTimeout(resolve, 40));
      }
    }

    await new Promise<void>((resolve) => {
      const view = doc.defaultView;
      if (!view) {
        resolve();
        return;
      }
      view.requestAnimationFrame(() =>
        view.requestAnimationFrame(() => resolve()),
      );
    });
  }

  private canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Could not export the canvas as PNG."));
          return;
        }
        void blob
          .arrayBuffer()
          .then((buffer) => resolve(new Uint8Array(buffer)))
          .catch(reject);
      }, "image/png");
    });
  }

  private enhanceAnnotationPopups(state: PdfViewState): void {
    if (this.states.get(state.leaf) !== state) return;

    const popups = state.viewerEl.querySelectorAll<HTMLElement>(".popup");
    for (const popup of Array.from(popups)) {
      if (popup.querySelector(".pdf-textbox-annotation-delete")) continue;
      const title = popup.querySelector(".popupTitle")?.textContent?.trim();
      if (title !== "PDF Textbox") continue;
      if (!state.activeBurnedAnnotationId) continue;

      const doc = popup.ownerDocument;
      let actions =
        popup.querySelector<HTMLElement>(
          ".pdf-plus-annotation-icon-container",
        ) ?? null;

      if (!actions) {
        const meta = popup.querySelector<HTMLElement>(".popupMeta");
        if (!meta) continue;
        actions = doc.createElement("div");
        actions.className = "pdf-textbox-popup-actions";
        meta.appendChild(actions);
      }

      const button = doc.createElement("div");
      button.className = "clickable-icon pdf-textbox-annotation-delete";
      button.setAttribute("role", "button");
      button.tabIndex = 0;
      button.setAttribute("aria-label", "Delete textbox annotation");
      button.setAttribute("title", "Delete textbox annotation");
      setIcon(button, "trash-2");

      const deleteCurrent = (): void => {
        const id = state.activeBurnedAnnotationId;
        if (id) void this.deleteBurnedPdfAnnotation(state, id);
      };

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        deleteCurrent();
      });
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        deleteCurrent();
      });

      actions.appendChild(button);
      popup.dataset.pdfTextboxDelete = "1";
    }
  }

  private async deleteBurnedPdfAnnotation(
    state: PdfViewState,
    pdfAnnotationId: string,
  ): Promise<void> {
    if (this.burning) {
      new Notice("A burn operation is already running.");
      return;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(state.filePath);
    if (!(sourceFile instanceof TFile) || sourceFile.extension !== "pdf") {
      new Notice("The current PDF could not be found.");
      return;
    }

    const match = /^(\d+)R(\d*)$/.exec(pdfAnnotationId);
    if (!match) {
      new Notice("The burned textbox annotation could not be identified.");
      return;
    }
    const objectNumber = Number(match[1]);
    const generationNumber = match[2] ? Number(match[2]) : 0;

    try {
      const sourceBytes = await this.app.vault.readBinary(sourceFile);
      const pdf = await PDFDocument.load(sourceBytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      let removed = false;

      for (const page of pdf.getPages()) {
        const annotations = page.node.lookupMaybe(
          PDFName.of("Annots"),
          PDFArray,
        );
        if (!annotations) continue;

        for (let index = annotations.size() - 1; index >= 0; index -= 1) {
          const ref = annotations.get(index);
          if (!(ref instanceof PDFRef)) continue;
          if (
            ref.objectNumber !== objectNumber ||
            ref.generationNumber !== generationNumber
          ) {
            continue;
          }

          const annotation = pdf.context.lookup(ref, PDFDict);
          const author = annotation.lookup(PDFName.of("T"));
          const authorText =
            author instanceof PDFHexString || author instanceof PDFString
              ? author.decodeText()
              : "";
          if (authorText !== "PDF Textbox") continue;

          annotations.remove(index);
          pdf.context.delete(ref);
          removed = true;
        }
      }

      if (!removed) {
        new Notice("The burned textbox annotation could not be found.");
        return;
      }

      const saved = await pdf.save();
      const targetBytes = saved.buffer.slice(
        saved.byteOffset,
        saved.byteOffset + saved.byteLength,
      ) as ArrayBuffer;
      await this.app.vault.modifyBinary(sourceFile, targetBytes);
      new Notice("Burned textbox annotation deleted.");

      for (const otherState of [...this.states.values()]) {
        if (otherState.filePath !== state.filePath) continue;
        if (typeof otherState.view.loadFile === "function") {
          try {
            await otherState.view.loadFile(sourceFile);
          } catch (error) {
            console.error("PDF Textbox: could not reload PDF", error);
          }
        }
      }
      this.scheduleSync(0);
    } catch (error) {
      console.error("PDF Textbox: could not delete annotation", error);
      new Notice(
        `Could not delete the textbox annotation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        8000,
      );
    }
  }

  private rotateCanvasForPdf(
    canvas: HTMLCanvasElement,
    rotation: number,
  ): HTMLCanvasElement {
    const normalized = normalizeRotation(rotation);
    if (normalized === 0) return canvas;

    const doc = canvas.ownerDocument ?? document;
    const rotated = doc.createElement("canvas");
    const swapDimensions = normalized === 90 || normalized === 270;
    rotated.width = swapDimensions ? canvas.height : canvas.width;
    rotated.height = swapDimensions ? canvas.width : canvas.height;

    const context = rotated.getContext("2d");
    if (!context) return canvas;

    context.translate(rotated.width / 2, rotated.height / 2);
    context.rotate((-normalized * Math.PI) / 180);
    context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return rotated;
  }

  private annotationRectForRotation(
    rotation: number,
    pageWidth: number,
    pageHeight: number,
    left: number,
    top: number,
    width: number,
    height: number,
  ): { x0: number; y0: number; x1: number; y1: number; width: number; height: number } {
    let x0 = left;
    let y0 = pageHeight - top - height;
    let x1 = left + width;
    let y1 = pageHeight - top;

    switch (rotation) {
      case 90:
        x0 = top;
        y0 = left;
        x1 = top + height;
        y1 = left + width;
        break;
      case 180:
        x0 = pageWidth - left - width;
        y0 = top;
        x1 = pageWidth - left;
        y1 = top + height;
        break;
      case 270:
        x0 = pageWidth - top - height;
        y0 = pageHeight - left - width;
        x1 = pageWidth - top;
        y1 = pageHeight - left;
        break;
      default:
        break;
    }

    return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
  }

  /* ------------------------------- rendering ------------------------------ */

  private scheduleRenderAll(state: PdfViewState): void {
    if (this.states.get(state.leaf) !== state || this.disposed) return;

    const win = state.viewerContainerEl.ownerDocument.defaultView ?? window;

    if (state.renderFrame === null) {
      state.renderFrame = win.requestAnimationFrame(() => {
        state.renderFrame = null;
        this.renderAll(state);
      });
    }

    if (state.renderTimer !== null) win.clearTimeout(state.renderTimer);
    state.renderTimer = win.setTimeout(() => {
      state.renderTimer = null;
      this.renderAll(state);
    }, 120);
  }

  private renderAll(state: PdfViewState): void {
    if (this.states.get(state.leaf) !== state || this.disposed) return;

    this.ensureToolbar(state);

    const pages = state.viewerEl.querySelectorAll<HTMLElement>(PAGE_SELECTOR);
    pages.forEach((pageEl) => this.renderPage(state, pageEl));
  }

  private renderPage(state: PdfViewState, pageEl: HTMLElement): void {
    const metrics = this.getPageMetrics(state, pageEl);
    if (!metrics) return;

    const layer = this.ensureLayer(pageEl);
    const annotations = this.annotationsForPage(state.filePath, metrics.pageNumber);

    const existingElements = new Map<string, HTMLElement>();
    for (const child of Array.from(layer.children)) {
      if ((child as Element).nodeType !== 1) continue;
      const element = child as HTMLElement;
      if (!element.classList.contains(ANNOTATION_CLASS)) continue;
      const id = element.dataset.id;
      if (id) existingElements.set(id, element);
    }

    const liveIds = new Set<string>();

    for (const annotation of annotations) {
      liveIds.add(annotation.id);

      let element = existingElements.get(annotation.id);
      if (!element) {
        element = this.createAnnotationElement(state, annotation);
        layer.appendChild(element);
      }

      existingElements.delete(annotation.id);
      this.applyAnnotationGeometry(element, annotation, metrics);

      if (state.editing?.annotation.id !== annotation.id) {
        this.renderAnnotationBody(state, element, annotation);
      }
    }

    for (const [id, element] of existingElements) {
      if (liveIds.has(id)) continue;
      if (state.editing?.element === element) continue;
      element.remove();
    }
  }

  private renderAnnotationBody(
    state: PdfViewState,
    element: HTMLElement,
    annotation: PdfTextboxAnnotation,
  ): void {
    const body = element.querySelector<HTMLElement>(".pdf-textbox-body");
    if (!body) return;
    if (body.dataset.renderedText === annotation.text) return;

    body.dataset.renderedText = annotation.text;
    const token = `${Date.now()}-${Math.random()}`;
    body.dataset.renderToken = token;
    body.empty();

    void MarkdownRenderer.render(
      this.app,
      annotation.text,
      body,
      state.filePath,
      state.component,
    )
      .then(() => {
        if (body.dataset.renderToken !== token) return;
        body.classList.add("is-rendered");
      })
      .catch((error) => {
        if (body.dataset.renderToken === token) {
          delete body.dataset.renderedText;
        }
        console.error("PDF Textbox: Markdown could not be rendered", error);
      });
  }

  private ensureLayer(pageEl: HTMLElement): HTMLElement {
    for (const child of Array.from(pageEl.children)) {
      if ((child as Element).nodeType !== 1) continue;
      const element = child as HTMLElement;
      if (element.classList.contains(LAYER_CLASS)) return element;
    }

    const layer = pageEl.ownerDocument.createElement("div");
    layer.className = LAYER_CLASS;
    pageEl.appendChild(layer);
    return layer;
  }

  private applyAnnotationGeometry(
    element: HTMLElement,
    annotation: PdfTextboxAnnotation,
    metrics: PdfPageMetrics,
  ): void {
    const rectangle = rotateNormalizedRect(
      annotation.nx,
      annotation.ny,
      annotation.nw,
      annotation.nh,
      annotation.rotation,
      metrics.rotation,
    );

    element.style.left = `${rectangle.x * 100}%`;
    element.style.top = `${rectangle.y * 100}%`;
    element.style.width = `${Math.max(0.5, rectangle.width * 100)}%`;
    element.style.minHeight = `${Math.max(0.2, rectangle.height * 100)}%`;
    element.style.fontSize = `${annotation.fontSize * metrics.scale}px`;
    element.style.padding = `${2.5 * metrics.scale}px ${4.5 * metrics.scale}px`;
    element.style.borderRadius = `${3 * metrics.scale}px`;
    this.applyAnnotationColors(element, annotation);
    this.applyCollapsedState(element, annotation);
  }

  private applyAnnotationColors(
    element: HTMLElement,
    annotation: PdfTextboxAnnotation,
  ): void {
    const background = hexToRgba(
      annotation.color,
      this.data.settings.backgroundColorOpacity,
    );
    const textColor = textColorForBackground(annotation.color);
    element.style.backgroundColor = background;
    element.style.color = textColor;

    const collapsedIcon = element.querySelector<HTMLElement>(
      ".pdf-textbox-collapsed-icon",
    );
    if (collapsedIcon) {
      collapsedIcon.style.backgroundColor = hexToRgba(
        annotation.color,
        Math.max(0.7, this.data.settings.backgroundColorOpacity),
      );
      collapsedIcon.style.color = textColor;
    }
  }

  private applyCollapsedState(
    element: HTMLElement,
    annotation: PdfTextboxAnnotation,
  ): void {
    element.classList.toggle("is-collapsed", annotation.collapsed);
    if (!annotation.collapsed) {
      element.classList.remove("is-hover-expanded");
    }
    const collapsedIcon = element.querySelector<HTMLElement>(
      ".pdf-textbox-collapsed-icon",
    );
    if (collapsedIcon) {
      collapsedIcon.setAttribute(
        "aria-label",
        annotation.collapsed ? "Expand textbox" : "Collapse textbox",
      );
    }
  }

  private openAnnotationColorMenu(
    state: PdfViewState,
    annotation: PdfTextboxAnnotation,
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ): void {
    this.closeAnnotationColorMenu();

    const doc = element.ownerDocument;
    const win = doc.defaultView ?? window;
    const menu = doc.createElement("div");
    menu.className = "pdf-textbox-color-menu";
    menu.setAttribute("role", "menu");

    const title = doc.createElement("div");
    title.className = "pdf-textbox-color-menu-title";
    title.textContent = "Background color";
    menu.appendChild(title);

    const presetColors = [
      "#ffd54f",
      "#ffcc80",
      "#f8bbd0",
      "#b2dfdb",
      "#bbdefb",
      "#d1c4e9",
      "#d4d4d4",
      "#ffffff",
    ];

    const applyColor = (value: string): void => {
      annotation.color = normalizeHexColor(value);
      annotation.updatedAt = Date.now();
      this.applyAnnotationColors(element, annotation);
      this.requestSave();
    };

    const grid = doc.createElement("div");
    grid.className = "pdf-textbox-color-grid";

    for (const color of presetColors) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "pdf-textbox-color-swatch";
      button.style.setProperty("--pdf-textbox-swatch", color);
      button.style.backgroundColor = color;
      button.style.backgroundImage = "none";
      button.setAttribute("aria-label", `Color ${color}`);
      button.setAttribute("title", color);
      button.setAttribute("role", "menuitem");
      if (annotation.color === color) button.classList.add("is-selected");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyColor(color);
        cleanup();
      });
      grid.appendChild(button);
    }
    menu.appendChild(grid);

    const custom = doc.createElement("label");
    custom.className = "pdf-textbox-color-custom";
    custom.textContent = "Custom color…";
    const customInput = doc.createElement("input");
    customInput.type = "color";
    customInput.className = "pdf-textbox-color-custom-input";
    customInput.value = annotation.color;
    customInput.addEventListener("input", () => {
      applyColor(customInput.value);
    });
    customInput.addEventListener("change", () => {
      applyColor(customInput.value);
      cleanup();
    });
    custom.appendChild(customInput);
    menu.appendChild(custom);

    const sizeRow = doc.createElement("div");
    sizeRow.className = "pdf-textbox-size-row";
    const sizeLabel = doc.createElement("span");
    sizeLabel.className = "pdf-textbox-size-label";
    sizeLabel.textContent = "Text size";
    sizeRow.appendChild(sizeLabel);

    const sizeMinus = doc.createElement("button");
    sizeMinus.type = "button";
    sizeMinus.className = "pdf-textbox-size-button";
    sizeMinus.textContent = "−";
    sizeMinus.setAttribute("aria-label", "Decrease text size");
    sizeRow.appendChild(sizeMinus);

    const sizeValue = doc.createElement("span");
    sizeValue.className = "pdf-textbox-size-value";
    sizeValue.textContent = String(annotation.fontSize);
    sizeRow.appendChild(sizeValue);

    const sizePlus = doc.createElement("button");
    sizePlus.type = "button";
    sizePlus.className = "pdf-textbox-size-button";
    sizePlus.textContent = "+";
    sizePlus.setAttribute("aria-label", "Increase text size");
    sizeRow.appendChild(sizePlus);

    const applyFontSize = (delta: number): void => {
      annotation.fontSize = clamp(annotation.fontSize + delta, 6, 96);
      annotation.updatedAt = Date.now();
      const pageEl = this.findPageElement(state, annotation.page);
      const metrics = pageEl ? this.getPageMetrics(state, pageEl) : null;
      if (metrics) {
        this.applyAnnotationGeometry(element, annotation, metrics);
      } else {
        element.style.fontSize = `${annotation.fontSize}px`;
      }
      sizeValue.textContent = String(annotation.fontSize);
      this.requestSave();
    };

    sizeMinus.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyFontSize(-1);
    });
    sizePlus.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyFontSize(1);
    });
    menu.appendChild(sizeRow);

    const separator = doc.createElement("div");
    separator.className = "pdf-textbox-menu-separator";
    menu.appendChild(separator);

    const burnButton = doc.createElement("button");
    burnButton.type = "button";
    burnButton.className = "pdf-textbox-menu-item";
    burnButton.textContent = "Burn this textbox into PDF";
    burnButton.setAttribute("role", "menuitem");
    burnButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      this.confirmBurnSingleTextbox(state, annotation);
    });
    menu.appendChild(burnButton);

    menu.style.visibility = "hidden";
    doc.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    const left = clamp(
      clientX,
      8,
      Math.max(8, win.innerWidth - menuRect.width - 8),
    );
    const top = clamp(
      clientY,
      8,
      Math.max(8, win.innerHeight - menuRect.height - 8),
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";

    const onOutsidePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && menu.contains(target)) return;
      cleanup();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    };

    const timer = win.setTimeout(() => {
      doc.addEventListener("pointerdown", onOutsidePointerDown, true);
      doc.addEventListener("keydown", onKeyDown, true);
    }, 0);

    const cleanup = (): void => {
      win.clearTimeout(timer);
      doc.removeEventListener("pointerdown", onOutsidePointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      menu.remove();
      if (this.colorMenuCleanup === cleanup) this.colorMenuCleanup = null;
    };

    this.colorMenuCleanup = cleanup;

    // Keep the enclosing edit session alive when the user clicks the menu.
    menu.addEventListener("pointerdown", (event) => event.stopPropagation());
    menu.addEventListener("click", (event) => event.stopPropagation());
  }

  private closeAnnotationColorMenu(): void {
    const cleanup = this.colorMenuCleanup;
    this.colorMenuCleanup = null;
    cleanup?.();
  }

  private annotationsForPage(
    filePath: string,
    pageNumber: number,
  ): PdfTextboxAnnotation[] {
    if (!filePath) return [];
    const normalizedPath = normalizePath(filePath);
    return this.data.annotations.filter(
      (annotation) =>
        annotation.file === normalizedPath && annotation.page === pageNumber,
    );
  }

  private findPageElement(
    state: PdfViewState,
    pageNumber: number,
  ): HTMLElement | null {
    return state.viewerEl.querySelector<HTMLElement>(
      `.page[data-page-number="${pageNumber}"]`,
    );
  }

  /* ---------------------------- coordinate maths -------------------------- */

  private getPageContentRect(pageEl: HTMLElement): DOMRect {
    const canvasWrapper = pageEl.querySelector<HTMLElement>(".canvasWrapper");
    return (canvasWrapper ?? pageEl).getBoundingClientRect();
  }

  /**
   * Resolves PDF-space metrics for a page.
   *
   * The viewer scroll offset is not added manually: `getBoundingClientRect()`
   * is already viewport-relative and therefore contains the current scroll
   * position of `.pdf-viewer-container`. This is exactly what keeps the
   * screen-to-page conversion stable while scrolling. The zoom is handled by
   * dividing the measured CSS size by the unscaled PDF page size.
   */
  private getPageMetrics(
    state: PdfViewState,
    pageEl: HTMLElement,
  ): PdfPageMetrics | null {
    const pageNumber = Number(pageEl.dataset.pageNumber);
    if (!Number.isFinite(pageNumber) || pageNumber < 1) return null;

    const rect = this.getPageContentRect(pageEl);
    if (rect.width <= 0 || rect.height <= 0) return null;

    const pageView = state.pdfViewer.getPageView?.(pageNumber - 1);
    const viewport = pageView?.viewport;
    let baseWidth = 0;
    let baseHeight = 0;
    let rotation = 0;

    if (
      viewport &&
      Number.isFinite(viewport.width) &&
      Number.isFinite(viewport.height) &&
      viewport.width > 0 &&
      viewport.height > 0
    ) {
      // `viewport.scale` includes PDF.js' 96/72 CSS unit conversion, so this
      // division yields the unscaled size in PDF points.
      const viewportScale = finiteNumber(viewport.scale, 0);
      if (viewportScale > 0) {
        baseWidth = viewport.width / viewportScale;
        baseHeight = viewport.height / viewportScale;
        rotation = normalizeRotation(finiteNumber(viewport.rotation, 0));
      }
    }

    if (baseWidth <= 0 || baseHeight <= 0) {
      // Fallback for the brief moment before PDF.js exposes the page viewport.
      const fallbackScale = finiteNumber(state.pdfViewer.currentScale, 1);
      if (fallbackScale <= 0) return null;
      baseWidth = rect.width / (fallbackScale * CSS_UNITS);
      baseHeight = rect.height / (fallbackScale * CSS_UNITS);
      rotation = 0;
    }

    return {
      pageNumber,
      baseWidth,
      baseHeight,
      displayedWidth: rect.width,
      displayedHeight: rect.height,
      scale: rect.width / baseWidth,
      rotation,
    };
  }

  private screenToPagePoint(
    clientX: number,
    clientY: number,
    pageEl: HTMLElement,
    metrics: PdfPageMetrics,
  ): { x: number; y: number } {
    const rect = this.getPageContentRect(pageEl);

    // `rect` is relative to the visible viewport (scroll already included).
    const localX = clamp(clientX - rect.left, 0, rect.width);
    const localY = clamp(clientY - rect.top, 0, rect.height);

    const scaleX = rect.width / metrics.baseWidth;
    const scaleY = rect.height / metrics.baseHeight;

    return {
      x: scaleX > 0 ? localX / scaleX : 0,
      y: scaleY > 0 ? localY / scaleY : 0,
    };
  }

  private updatePdfCoordinates(
    annotation: PdfTextboxAnnotation,
    metrics: PdfPageMetrics,
  ): void {
    const base = baseSizeForRotation(
      metrics.baseWidth,
      metrics.baseHeight,
      metrics.rotation,
      annotation.rotation,
    );

    annotation.x = annotation.nx * base.width;
    annotation.y = annotation.ny * base.height;
    annotation.width = annotation.nw * base.width;
    annotation.height = annotation.nh * base.height;
  }

  private updateNormalizedRectFromElement(
    annotation: PdfTextboxAnnotation,
    element: HTMLElement,
    pageEl: HTMLElement,
    metrics: PdfPageMetrics,
  ): void {
    const pageRect = this.getPageContentRect(pageEl);
    if (pageRect.width <= 0 || pageRect.height <= 0) return;

    const elementRect = element.getBoundingClientRect();
    const back = rotateNormalizedRect(
      (elementRect.left - pageRect.left) / pageRect.width,
      (elementRect.top - pageRect.top) / pageRect.height,
      elementRect.width / pageRect.width,
      elementRect.height / pageRect.height,
      metrics.rotation,
      annotation.rotation,
    );

    annotation.nw = clamp(back.width, 0.02, 1);
    annotation.nh = clamp(back.height, 0.005, 1);
    annotation.nx = clamp(back.x, 0, Math.max(0, 1 - annotation.nw));
    annotation.ny = clamp(back.y, 0, Math.max(0, 1 - annotation.nh));
  }
}

/* -------------------------------------------------------------------------- */
/*  Settings                                                                   */
/* -------------------------------------------------------------------------- */

class PdfTextboxSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: PdfTextboxPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.getSettings();
    containerEl.empty();

    containerEl.createEl("h2", { text: "PDF Textbox" });

    new Setting(containerEl).setName("New textboxes").setHeading();

    new Setting(containerEl)
      .setName("Default width")
      .setDesc(
        "Width of new textboxes as a percentage of the page width (5–80%). Existing textboxes can be resized from the bottom-right handle in edit mode.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(5, 80, 1)
          .setValue(settings.defaultWidthPercent)
          .setDynamicTooltip()
          .onChange((value) =>
            this.plugin.setSettings({ defaultWidthPercent: value }),
          ),
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Font size of new textboxes in PDF points (6–48).")
      .addSlider((slider) =>
        slider
          .setLimits(6, 48, 1)
          .setValue(settings.defaultFontSize)
          .setDynamicTooltip()
          .onChange((value) =>
            this.plugin.setSettings({ defaultFontSize: value }),
          ),
      );

    new Setting(containerEl).setName("Background").setHeading();

    new Setting(containerEl)
      .setName("Background color")
      .setDesc(
        "Default color for new textboxes. Right-click a textbox in edit mode to change its color individually.",
      )
      .addColorPicker((picker) =>
        picker
          .setValue(settings.backgroundColor)
          .onChange((value) =>
            this.plugin.setSettings({ backgroundColor: value }),
          ),
      );

    new Setting(containerEl)
      .setName("Opacity")
      .setDesc("Opacity of the background color (10–100%).")
      .addSlider((slider) =>
        slider
          .setLimits(10, 100, 5)
          .setValue(Math.round(settings.backgroundColorOpacity * 100))
          .setDynamicTooltip()
          .onChange((value) =>
            this.plugin.setSettings({ backgroundColorOpacity: value / 100 }),
          ),
      );

    new Setting(containerEl).setName("Burning").setHeading();

    new Setting(containerEl)
      .setName("Confirm before burning")
      .setDesc(
        "Show the overwrite warning before burning textboxes into the PDF.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.confirmBeforeBurn).onChange((value) =>
          this.plugin.setSettings({ confirmBeforeBurn: value }),
        ),
      );
  }
}
