import {
  EditorSelection,
  EditorState,
  Prec,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
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
  TFolder,
  View,
  WorkspaceLeaf,
  editorLivePreviewField,
  finishRenderMath,
  loadMathJax,
  normalizePath,
  renderMath,
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
const BURN_MODE_CLASS = "pdf-textbox-burning";
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
  livePreviewWhileEditing: true,
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
  editorRequestId: number;
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

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Parses hex/rgb/rgba and, as a fallback, any colour the browser understands. */
function parseColor(value: string): RgbColor | null {
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

function relativeLuminance(color: RgbColor): number {
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

function contrastRatio(first: RgbColor, second: RgbColor): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Keeps a theme colour when it is readable on the textbox background and
 * falls back to the high-contrast black/white text colour otherwise.
 */
function readableColor(
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

function rgbToHex(color: RgbColor): string {
  const toHex = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

interface ThemeMarkdownColors {
  strong: string;
  em: string;
  /** Computed colour for h1 … h6. */
  headings: string[];
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
/*  Live Markdown formatting while editing                                    */
/* -------------------------------------------------------------------------- */

/**
 * Obsidian's Live Preview decorations are installed only on Markdown views, so
 * a custom CodeMirror editor shows raw Markdown. These decorations provide the
 * essential part of that experience inside a textbox: formatting is applied
 * while typing, markers are hidden, and inline LaTeX is rendered with MathJax.
 * Markers reappear for the construct that contains the caret, so the source
 * stays editable.
 */

const LIVE_CODE_PATTERN = /`([^`\n]+)`/g;
const LIVE_BLOCK_MATH_PATTERN = /^[ \t]*\$\$([\s\S]+?)\$\$[ \t]*$/gm;
const LIVE_DISPLAY_MATH_PATTERN = /\$\$([^$\n]+)\$\$/g;
const LIVE_INLINE_MATH_PATTERN =
  /(?<!\\)\$(?!\s)([^$\n]*?[^\s$])\$(?!\d)/g;
const LIVE_LINK_PATTERN = /(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const LIVE_HEADING_PATTERN = /^(#{1,6})[ \t]+/gm;
const LIVE_FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/;

const LIVE_INLINE_RULES: Array<{
  pattern: RegExp;
  className: string;
  /** Number of marker characters to hide before and after the content. */
  markers: [number, number];
}> = [
  {
    pattern: /\*\*\*(?![\s*])([^*\n]*?[^\s*])\*\*\*/g,
    className: "pdf-textbox-live-strong pdf-textbox-live-em",
    markers: [3, 3],
  },
  {
    pattern: /(?<![\w])___(?![\s_])([^_\n]*?[^\s_])___(?![\w])/g,
    className: "pdf-textbox-live-strong pdf-textbox-live-em",
    markers: [3, 3],
  },
  {
    pattern: /\*\*(?![\s*])([^*\n]*?[^\s*])\*\*/g,
    className: "pdf-textbox-live-strong",
    markers: [2, 2],
  },
  {
    pattern: /(?<![\w])__(?![\s_])([^_\n]*?[^\s_])__(?![\w])/g,
    className: "pdf-textbox-live-strong",
    markers: [2, 2],
  },
  {
    pattern: /~~(?![\s~])([^~\n]*?[^\s~])~~/g,
    className: "pdf-textbox-live-strike",
    markers: [2, 2],
  },
  {
    pattern: /==(?![\s=])([^=\n]*?[^\s=])==/g,
    className: "pdf-textbox-live-highlight",
    markers: [2, 2],
  },
  {
    pattern: /\*(?![\s*])([^*\n]*?[^\s*])\*/g,
    className: "pdf-textbox-live-em",
    markers: [1, 1],
  },
  {
    pattern: /(?<![\w])_(?![\s_])([^_\n]*?[^\s_])_(?![\w])/g,
    className: "pdf-textbox-live-em",
    markers: [1, 1],
  },
];

class TextboxMathWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly displayMode: boolean,
    private readonly isBlock = false,
  ) {
    super();
  }

  eq(other: TextboxMathWidget): boolean {
    return (
      other.source === this.source &&
      other.displayMode === this.displayMode &&
      other.isBlock === this.isBlock
    );
  }

  toDOM(view: EditorView): HTMLElement {
    try {
      const element = renderMath(this.source, this.displayMode);
      element.classList.add("pdf-textbox-live-math");
      if (this.isBlock) element.classList.add("is-block");
      void finishRenderMath().catch(() => undefined);
      return element;
    } catch (error) {
      // Invalid LaTeX must not break the editor; fall back to the source.
      console.error("PDF Textbox: LaTeX could not be rendered", error);
      const fallback = view.dom.ownerDocument.createElement("span");
      fallback.className = "pdf-textbox-live-math";
      fallback.textContent = this.source;
      return fallback;
    }
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** Ranges of fenced code blocks, whose content stays raw. */
function findFencedCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fenceStart = -1;
  let offset = 0;

  for (const line of text.split("\n")) {
    if (LIVE_FENCE_PATTERN.test(line)) {
      if (fenceStart < 0) {
        fenceStart = offset;
      } else {
        ranges.push([fenceStart, offset + line.length]);
        fenceStart = -1;
      }
    }
    offset += line.length + 1;
  }

  if (fenceStart >= 0) ranges.push([fenceStart, text.length]);
  return ranges;
}

export function buildLiveFormattingDecorations(
  view: EditorView,
): DecorationSet {
  const text = view.state.doc.toString();
  if (text.length === 0) return Decoration.none;
  // Keep editing responsive even for unusually large boxes: the decoration
  // scan is quadratic in the number of matches because overlaps are resolved
  // against the already accepted ranges.
  if (text.length > 20000) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  const occupied: Array<[number, number]> = [];
  const opaque = findFencedCodeRanges(text);
  const selection = view.state.selection.ranges;

  const isRevealed = (from: number, to: number): boolean =>
    selection.some((range) => range.from < to && range.to > from);

  const isOccupied = (from: number, to: number): boolean =>
    occupied.some(([start, end]) => from < end && to > start);

  const isOpaque = (from: number, to: number): boolean =>
    opaque.some(([start, end]) => from >= start && to <= end);

  const addMark = (
    from: number,
    to: number,
    className: string,
    markers: Array<[number, number]>,
    opaqueContent = false,
  ): void => {
    if (isOpaque(from, to)) return;
    const revealed = isRevealed(from, to);
    // Markers are only hidden when the caret is outside the construct, so the
    // source stays editable without losing the formatting itself.
    if (!revealed && markers.some(([start, end]) => isOccupied(start, end))) {
      return;
    }

    ranges.push(Decoration.mark({ class: className }).range(from, to));
    if (revealed) return;

    for (const [start, end] of markers) {
      if (end <= start) continue;
      ranges.push(Decoration.replace({}).range(start, end));
      occupied.push([start, end]);
    }
    if (opaqueContent) opaque.push([from, to]);
  };

  const addMath = (
    from: number,
    to: number,
    source: string,
    display: boolean,
  ): void => {
    if (source.trim().length === 0) return;
    if (isRevealed(from, to) || isOpaque(from, to) || isOccupied(from, to)) {
      return;
    }

    ranges.push(
      Decoration.replace({
        widget: new TextboxMathWidget(source, display),
      }).range(from, to),
    );
    occupied.push([from, to]);
  };

  // Multi-line display math is replaced as a block: CodeMirror only allows
  // block replacements that cover complete lines.
  for (const match of text.matchAll(LIVE_BLOCK_MATH_PATTERN)) {
    if (!match[0].includes("\n")) continue;
    const from = match.index ?? 0;
    const source = match[1] ?? "";
    if (source.trim().length === 0) continue;

    const blockFrom = view.state.doc.lineAt(from).from;
    const blockTo = view.state.doc.lineAt(
      from + Math.max(0, match[0].length - 1),
    ).to;
    if (
      isRevealed(blockFrom, blockTo) ||
      isOpaque(blockFrom, blockTo) ||
      isOccupied(blockFrom, blockTo)
    ) {
      continue;
    }

    ranges.push(
      Decoration.replace({
        widget: new TextboxMathWidget(source, true, true),
        block: true,
      }).range(blockFrom, blockTo),
    );
    occupied.push([blockFrom, blockTo]);
  }

  // Inline code first: nothing inside it may be formatted.
  for (const match of text.matchAll(LIVE_CODE_PATTERN)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    addMark(
      from,
      to,
      "pdf-textbox-live-code",
      [
        [from, from + 1],
        [to - 1, to],
      ],
      true,
    );
  }

  for (const match of text.matchAll(LIVE_DISPLAY_MATH_PATTERN)) {
    const from = match.index ?? 0;
    addMath(from, from + match[0].length, match[1] ?? "", true);
  }

  for (const match of text.matchAll(LIVE_INLINE_MATH_PATTERN)) {
    const from = match.index ?? 0;
    addMath(from, from + match[0].length, match[1] ?? "", false);
  }

  for (const rule of LIVE_INLINE_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      const [leading, trailing] = rule.markers;
      addMark(from, to, rule.className, [
        [from, from + leading],
        [to - trailing, to],
      ]);
    }
  }

  for (const match of text.matchAll(LIVE_LINK_PATTERN)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    const contentFrom = from + (match[1]?.length ?? 0) + 1;
    const contentTo = contentFrom + (match[2]?.length ?? 0);
    addMark(from, to, "pdf-textbox-live-link", [
      [from, contentFrom],
      [contentTo, to],
    ]);
  }

  for (const match of text.matchAll(LIVE_HEADING_PATTERN)) {
    const from = match.index ?? 0;
    const markerEnd = from + match[0].length;
    const line = view.state.doc.lineAt(from);
    if (isOpaque(from, markerEnd) || isOccupied(from, markerEnd)) continue;

    // Heading styling always applies; only the hashes are hidden while the
    // caret is elsewhere.
    ranges.push(
      Decoration.line({
        class: `pdf-textbox-live-h${match[1]?.length ?? 1}`,
      }).range(line.from),
    );
    if (isRevealed(line.from, line.to)) continue;

    ranges.push(Decoration.replace({}).range(from, markerEnd));
    occupied.push([from, markerEnd]);
  }

  return Decoration.set(ranges, true);
}

const liveFormattingExtension: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildLiveFormattingDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildLiveFormattingDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

/** Characters that wrap a selection instead of replacing it when typed. */
const SELECTION_WRAPPING_CHARACTERS = new Set(["*", "_", "`", "$", "=", "~"]);

const wrapSelectionExtension: Extension = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (from === to || text.length !== 1) return false;
    if (!SELECTION_WRAPPING_CHARACTERS.has(text)) return false;

    view.dispatch(
      view.state.changeByRange((range) => {
        if (range.empty) {
          return {
            changes: { from: range.from, insert: text },
            range: EditorSelection.cursor(range.from + 1),
          };
        }
        return {
          changes: [
            { from: range.from, insert: text },
            { from: range.to, insert: text },
          ],
          range: EditorSelection.range(range.from + 1, range.to + 1),
        };
      }),
    );
    return true;
  },
);

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
  private saveRetryCount = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  private dirty = false;
  private disposed = false;
  private burning = false;
  private colorMenuCleanup: (() => void) | null = null;
  private markdownLanguage: Extension | null = null;
  private markdownLanguagePromise: Promise<Extension | null> | null = null;
  /** Cached theme colours per document; cleared when the theme changes. */
  private themeColors = new WeakMap<Document, ThemeMarkdownColors>();

  async onload(): Promise<void> {
    await this.loadStore();

    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        this.themeColors = new WeakMap();
        for (const state of this.states.values()) this.renderAll(state);
      }),
    );

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
    this.app.workspace.onLayoutReady(() => {
      this.scheduleSync(0);
      this.scheduleSync(300);
      this.scheduleSync(1000);
      this.scheduleSync(2500);
    });
  }

  async onunload(): Promise<void> {
    await this.dispose();
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
    this.saveRetryCount = 0;
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
      this.saveRetryCount = 0;
    } catch (error) {
      this.dirty = true;
      console.error("PDF Textbox: could not save data.json", error);
      this.scheduleSaveRetry();
    }
  }

  private scheduleSaveRetry(): void {
    if (this.disposed || this.saveTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.saveRetryCount, 30_000);
    this.saveRetryCount += 1;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, delay);
  }

  private onFileRenamed(file: TAbstractFile, oldPath: string): void {
    const normalizedOldPath = normalizePath(oldPath);
    const newPath = normalizePath(file.path);
    const isFolder = file instanceof TFolder;
    let changed = false;

    for (const annotation of this.data.annotations) {
      if (isFolder) {
        if (
          annotation.file === normalizedOldPath ||
          annotation.file.startsWith(`${normalizedOldPath}/`)
        ) {
          annotation.file =
            newPath + annotation.file.slice(normalizedOldPath.length);
          annotation.updatedAt = Date.now();
          changed = true;
        }
      } else if (annotation.file === normalizedOldPath) {
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
    const isFolder = file instanceof TFolder;
    const previousLength = this.data.annotations.length;
    this.data.annotations = this.data.annotations.filter((annotation) => {
      if (isFolder) {
        return !(
          annotation.file === path || annotation.file.startsWith(`${path}/`)
        );
      }
      return annotation.file !== path;
    });

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
      editorRequestId: 0,
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
      if (
        event.key === "Tab" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        // Obsidian's default Tab handling moves focus out of the PDF viewer
        // before CodeMirror can see the key. Indent in-place instead.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) {
          indentLess(session.editorView);
        } else {
          indentMore(session.editorView);
        }
        session.editorView.focus();
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

      let popupTimer: number | null = null;
      const popupObserver = new Observer(() => {
        const activeAnnotationId = state.activeBurnedAnnotationId;
        if (activeAnnotationId) {
          for (const popup of Array.from(
            state.viewerEl.querySelectorAll<HTMLElement>(".popup"),
          )) {
            if (
              popup.querySelector(".popupTitle")?.textContent?.trim() ===
                "PDF Textbox" &&
              !popup.dataset.pdfTextboxAnnotationId
            ) {
              popup.dataset.pdfTextboxAnnotationId = activeAnnotationId;
            }
          }
        }
        if (popupTimer !== null) window.clearTimeout(popupTimer);
        popupTimer = window.setTimeout(() => {
          popupTimer = null;
          this.enhanceAnnotationPopups(state);
        }, 150);
      });
      popupObserver.observe(viewerContainerEl, {
        childList: true,
        subtree: true,
      });
      state.popupObserver = popupObserver;
      state.cleanups.push(() => {
        if (popupTimer !== null) window.clearTimeout(popupTimer);
        popupObserver.disconnect();
      });
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

  private async dispose(): Promise<void> {
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
    await this.flushSave();
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
    if (enabled && this.burning) return;
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
    if (this.burning || !state.createMode || state.placement || event.button !== 0) return;

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
      Math.min(12, metrics.baseHeight),
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

    // Links are clickable whenever the rendered body is visible, even while
    // edit mode is on. stopImmediatePropagation keeps the edit-mode click
    // handler from opening the editor at the same time. The rest of the
    // textbox stays click-through (see CSS).
    element.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      if (!target || typeof target.closest !== "function") return;
      const anchor = target.closest("a");
      if (!anchor) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.openTextboxLink(anchor as HTMLAnchorElement, state);
    });

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
      if (this.burning || !state.editMode) return;
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
      if (this.burning) return;
      annotation.collapsed = false;
      annotation.updatedAt = Date.now();
      this.applyCollapsedState(element, annotation);
      this.requestSave();
    });

    element.addEventListener("pointerenter", () => {
      if (annotation.collapsed) element.classList.add("is-hover-expanded");
    });
    element.addEventListener("pointerleave", () => {
      element.classList.remove("is-hover-expanded");
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
    if (this.burning || !state.editMode || state.editing) return;

    const initialPageEl = this.findPageElement(state, annotation.page);
    if (!initialPageEl) return;

    const initialMetrics = this.getPageMetrics(state, initialPageEl);
    const initialPageRect = this.getPageContentRect(initialPageEl);
    const initialElementRect = element.getBoundingClientRect();
    if (
      !initialMetrics ||
      initialPageRect.width <= 0 ||
      initialPageRect.height <= 0
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    // Drag by the absolute screen rectangle instead of page-relative deltas.
    // That way the same pointer movement can carry the box across page borders.
    const offsetX = event.clientX - initialElementRect.left;
    const offsetY = event.clientY - initialElementRect.top;
    const elementWidth = initialElementRect.width;
    const elementHeight = initialElementRect.height;

    let currentPageEl = initialPageEl;

    const ownerDocument = element.ownerDocument;
    element.classList.add("is-dragging");

    const onMove = (moveEvent: PointerEvent): void => {
      const left = moveEvent.clientX - offsetX;
      const top = moveEvent.clientY - offsetY;

      // Use the centre of the box to decide which page it currently belongs
      // to. Crossing that border moves the annotation to the other page.
      const targetPageEl =
        this.findPageElementAtPoint(
          state,
          left + elementWidth / 2,
          top + elementHeight / 2,
        ) ?? currentPageEl;

      if (targetPageEl !== currentPageEl) {
        currentPageEl = targetPageEl;
        this.ensureLayer(currentPageEl).appendChild(element);
        const targetPageNumber = Number(currentPageEl.dataset.pageNumber);
        if (Number.isFinite(targetPageNumber)) {
          element.dataset.pageNumber = String(targetPageNumber);
        }
      }

      const metrics = this.getPageMetrics(state, currentPageEl);
      const pageRect = this.getPageContentRect(currentPageEl);
      if (!metrics || pageRect.width <= 0 || pageRect.height <= 0) return;

      const clampedLeft = clamp(
        left,
        pageRect.left,
        Math.max(pageRect.left, pageRect.right - elementWidth),
      );
      const clampedTop = clamp(
        top,
        pageRect.top,
        Math.max(pageRect.top, pageRect.bottom - elementHeight),
      );

      const width = clamp(elementWidth / pageRect.width, 0.02, 1);
      const height = clamp(elementHeight / pageRect.height, 0.005, 1);

      annotation.page = metrics.pageNumber;
      // The box is now positioned in the target page's display coordinate
      // system, so store its coordinates for that rotation directly.
      annotation.rotation = metrics.rotation;
      annotation.nw = width;
      annotation.nh = height;
      annotation.nx = clamp(
        (clampedLeft - pageRect.left) / pageRect.width,
        0,
        Math.max(0, 1 - width),
      );
      annotation.ny = clamp(
        (clampedTop - pageRect.top) / pageRect.height,
        0,
        Math.max(0, 1 - height),
      );

      this.applyAnnotationGeometry(element, annotation, metrics);
    };

    const onUp = (): void => {
      ownerDocument.removeEventListener("pointermove", onMove);
      ownerDocument.removeEventListener("pointerup", onUp);
      ownerDocument.removeEventListener("pointercancel", onUp);
      element.classList.remove("is-dragging");

      const metrics = this.getPageMetrics(state, currentPageEl);
      if (metrics) {
        annotation.page = metrics.pageNumber;
        annotation.rotation = metrics.rotation;
        annotation.nw = clamp(annotation.nw, 0.02, 1);
        annotation.nh = clamp(annotation.nh, 0.005, 1);
        annotation.nx = clamp(annotation.nx, 0, Math.max(0, 1 - annotation.nw));
        annotation.ny = clamp(annotation.ny, 0, Math.max(0, 1 - annotation.nh));
        this.updatePdfCoordinates(annotation, metrics);
        this.applyAnnotationGeometry(element, annotation, metrics);
      }

      annotation.updatedAt = Date.now();
      this.requestSave();
      this.renderAll(state);
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
    if (this.burning || !state.editMode || state.editing) return;

    const pageEl = this.findPageElement(state, annotation.page);
    if (!pageEl || this.burning) return;

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
    const requestId = ++state.editorRequestId;
    if (state.editing) this.commitEditing(state);

    const body = element.querySelector<HTMLElement>(".pdf-textbox-body");
    if (!body) return;

    const markdownLanguage = await this.ensureMarkdownLanguage();
    if (
      requestId !== state.editorRequestId ||
      !element.isConnected ||
      state.editing ||
      this.burning
    ) {
      return;
    }

    if (annotation.collapsed) {
      annotation.collapsed = false;
      annotation.updatedAt = Date.now();
      this.applyCollapsedState(element, annotation);
      this.requestSave();
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
      Prec.high(
        EditorView.domEventHandlers({
          paste: (event, view) =>
            this.handleImagePaste(event, view, state.filePath),
        }),
      ),
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
            key: "Enter",
            run: (view) => this.handleListEnter(view),
          },
          {
            key: "Tab",
            run: (view) => indentMore(view),
          },
          {
            key: "Shift-Tab",
            run: (view) => indentLess(view),
          },
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

    if (this.data.settings.livePreviewWhileEditing) {
      extensions.push(liveFormattingExtension);
      // Inline LaTeX needs MathJax; loading it is idempotent and lazy.
      void loadMathJax().catch(() => undefined);
    }
    extensions.push(wrapSelectionExtension);

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
          !editorView.hasFocus &&
          !(editorView.dom.ownerDocument.activeElement?.closest?.(
            ".pdf-textbox-color-menu",
          ))
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

  /**
   * Continues Markdown bullet and numbered lists when Enter is pressed.
   * Pressing Enter on an empty list item removes the marker instead.
   */
  private handleListEnter(view: EditorView): boolean {
    const state = view.state;
    const range = state.selection.main;
    if (!range.empty) return false;

    const line = state.doc.lineAt(range.head);
    const before = state.sliceDoc(line.from, range.head);
    const after = state.sliceDoc(range.head, line.to);

    const match =
      /^([ \t]*)(?:([-+*])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/.exec(
        before,
      );
    if (!match) return false;

    const indent = match[1] ?? "";
    const bullet = match[2];
    const number = match[3];
    const delimiter = match[4] ?? ".";
    const spacing = match[5] ?? " ";
    const taskMarker = match[6] ? "[ ] " : "";
    const contentBeforeCursor = before.slice(match[0].length);
    const itemIsEmpty =
      contentBeforeCursor.trim().length === 0 && after.trim().length === 0;

    if (itemIsEmpty) {
      // Leave the list and keep the indentation instead of creating a new,
      // permanently empty bullet point.
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: indent },
        selection: EditorSelection.cursor(line.from + indent.length),
        scrollIntoView: true,
      });
      view.focus();
      return true;
    }

    const marker = bullet ?? `${Number(number) + 1}${delimiter}`;
    const insert = `\n${indent}${marker}${spacing}${taskMarker}`;
    view.dispatch({
      changes: { from: range.head, insert },
      selection: EditorSelection.cursor(range.head + insert.length),
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }

  /**
   * Saves images from the clipboard to the vault and inserts an embed link
   * (`![[Pasted image ....png]]`) at the cursor.
   */
  private handleImagePaste(
    event: ClipboardEvent,
    view: EditorView,
    sourcePath: string,
  ): boolean {
    const clipboard = event.clipboardData;
    if (!clipboard) return false;

    const files: File[] = [];
    const items = Array.from(clipboard.items ?? []);
    for (const item of items) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }

    if (files.length === 0) {
      for (const file of Array.from(clipboard.files ?? [])) {
        if (file.type.startsWith("image/")) files.push(file);
      }
    }

    if (files.length === 0) return false;

    event.preventDefault();
    event.stopPropagation();

    const range = view.state.selection.main;
    const from = range.from;
    const to = range.to;
    const originalDocument = view.state.doc.toString();
    void this.pasteImages(files, sourcePath, view, from, to, originalDocument).catch((error) => {
      console.error("PDF Textbox: could not paste image", error);
    });
    return true;
  }

  private async pasteImages(
    files: readonly File[],
    sourcePath: string,
    view: EditorView,
    from: number,
    to: number,
    originalDocument: string,
  ): Promise<void> {
    const links: string[] = [];
    let index = 0;

    for (const file of files) {
      index += 1;
      try {
        const bytes = await file.arrayBuffer();
        const extension = this.extensionForImage(file.type, file.name);
        const filename = `Pasted image ${this.timestampForFilename()}${
          files.length > 1 ? ` ${index}` : ""
        }.${extension}`;
        const path = await this.app.fileManager.getAvailablePathForAttachment(
          filename,
          sourcePath || undefined,
        );
        const created = await this.app.vault.createBinary(path, bytes);
        let link = this.app.fileManager.generateMarkdownLink(
          created,
          sourcePath,
        );
        if (!link.startsWith("!")) link = `!${link}`;
        links.push(link);
      } catch (error) {
        console.error("PDF Textbox: could not save pasted image", error);
        new Notice(
          `Could not save pasted image: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (links.length === 0) return;
    if (!view.dom.isConnected) return;

    const insert = links.join("\n");
    const docLength = view.state.doc.length;
    const documentUnchanged = view.state.doc.toString() === originalDocument;
    const insertionRange = documentUnchanged
      ? { from, to }
      : view.state.selection.main;
    const safeFrom = clamp(insertionRange.from, 0, docLength);
    const safeTo = clamp(insertionRange.to, safeFrom, docLength);
    view.dispatch({
      changes: { from: safeFrom, to: safeTo, insert },
      selection: EditorSelection.cursor(safeFrom + insert.length),
      scrollIntoView: true,
    });
    view.focus();
  }

  private extensionForImage(mimeType: string, filename: string): string {
    switch (mimeType.toLowerCase()) {
      case "image/png":
        return "png";
      case "image/jpeg":
      case "image/jpg":
        return "jpg";
      case "image/gif":
        return "gif";
      case "image/webp":
        return "webp";
      case "image/svg+xml":
        return "svg";
      case "image/bmp":
        return "bmp";
      case "image/tiff":
        return "tiff";
      case "image/avif":
        return "avif";
      default: {
        const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1];
        return extension ? extension.toLowerCase() : "png";
      }
    }
  }

  private timestampForFilename(): string {
    const now = new Date();
    const pad = (value: number, length = 2): string =>
      String(value).padStart(length, "0");
    return (
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
      `${pad(now.getMilliseconds(), 3)}`
    );
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
    state.editorRequestId += 1;
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
    if (this.burning) return;
    const session = state.editing;
    if (session?.annotation.id === id) {
      session.committing = true;
      state.editing = null;
      state.editorRequestId += 1;
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
    const lockedStates = [...this.states.values()].filter(
      (state) => state.filePath === filePath,
    );
    const fileAnnotationSnapshot = this.data.annotations
      .filter((annotation) => annotation.file === filePath)
      .map((annotation) => ({ ...annotation }));
    const progress = new Notice("Burning textboxes into the PDF…", 0);

    try {
      this.closeAnnotationColorMenu();
      for (const state of lockedStates) {
        if (state.editing) this.commitEditing(state);
        this.setCreateMode(state, false);
        this.cancelPlacement(state);
        state.viewerContainerEl.classList.add(BURN_MODE_CLASS);
      }

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

        const burnDocument =
          [...this.states.values()].find((s) => s.filePath === filePath)
            ?.viewerEl.ownerDocument ?? document;

        const burn = await this.createBurnElement(
          burnDocument,
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

          const linkTargets = this.collectBurnLinkTargets(
            burn.element,
            filePath,
            width,
            height,
          );

          if (
            burn.element.offsetWidth <= 0 ||
            burn.element.offsetHeight <= 0
          ) {
            throw new Error("Burn element has no measurable size.");
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

          // Make links clickable in the burned PDF by adding invisible PDF
          // Link annotations over the rendered link text.
          for (const target of linkTargets) {
            const linkRect = this.annotationRectForRotation(
              rotation,
              pageWidth,
              pageHeight,
              left + target.x,
              top + target.y,
              target.width,
              target.height,
            );
            const linkDict = pdf.context.obj({
              Type: "Annot",
              Subtype: "Link",
              Rect: [linkRect.x0, linkRect.y0, linkRect.x1, linkRect.y1],
              Border: [0, 0, 0],
              F: 4,
              A: {
                Type: "Action",
                S: "URI",
                URI: PDFString.of(target.href),
              },
            });
            pageAnnotations.push(pdf.context.register(linkDict));
          }

          burnedCount += 1;
          burnedIds.add(annotation.id);
        } finally {
          burn.host.remove();
          burn.component.unload();
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
      const currentFileAnnotations = this.data.annotations.filter(
        (annotation) => annotation.file === filePath,
      );
      if (
        JSON.stringify(currentFileAnnotations) !==
        JSON.stringify(fileAnnotationSnapshot)
      ) {
        throw new Error("Textbox data changed while burning; no PDF changes were written.");
      }
      const currentSourceBytes = await this.app.vault.readBinary(sourceFile);
      const originalBytes = new Uint8Array(sourceBytes);
      const latestBytes = new Uint8Array(currentSourceBytes);
      if (
        originalBytes.length !== latestBytes.length ||
        originalBytes.some((byte, index) => byte !== latestBytes[index])
      ) {
        throw new Error("The PDF changed while burning; no PDF changes were written.");
      }

      await this.app.vault.modifyBinary(sourceFile, targetBytes);

      // The burned textboxes are now part of the PDF. Remove only the
      // annotations that were actually baked so the same boxes do not appear
      // twice on top of the replaced file.
      this.data.annotations = this.data.annotations.filter(
        (annotation) =>
          annotation.file !== filePath || !burnedIds.has(annotation.id),
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
      for (const state of lockedStates) {
        state.viewerContainerEl.classList.remove(BURN_MODE_CLASS);
      }
      progress.hide();
      this.burning = false;
    }
  }

  private async createBurnElement(
    ownerDocument: Document,
    sourcePath: string,
    markdown: string,
    width: number,
    fontSize: number,
    color: string,
    minHeight: number,
  ): Promise<{ host: HTMLElement; element: HTMLElement; component: Component }> {
    const component = new Component();
    component.load();
    const host = ownerDocument.createElement("div");
    host.className = "pdf-textbox-burn-host";

    const element = ownerDocument.createElement("div");
    element.className = "pdf-textbox-annotation pdf-textbox-burn-box";
    element.style.position = "relative";
    element.style.left = "0";
    element.style.top = "0";
    element.style.width = `${width}px`;
    element.style.minHeight = `${minHeight}px`;
    element.style.setProperty("font-size", `${fontSize}px`, "important");
    element.style.padding = "2.5px 4.5px";
    element.style.borderRadius = "3px";
    element.style.backgroundColor = hexToRgba(
      color,
      this.data.settings.backgroundColorOpacity,
    );
    element.style.color = textColorForBackground(color);
    this.applyThemeTextColors(element, color);

    const body = ownerDocument.createElement("div");
    body.className = "pdf-textbox-body markdown-rendered";
    element.appendChild(body);
    host.appendChild(element);
    ownerDocument.body.appendChild(host);

    try {
      await MarkdownRenderer.render(
        this.app,
        markdown,
        body,
        sourcePath,
        component,
      );
      await this.waitForBurnContent(body);
    } catch (error) {
      host.remove();
      component.unload();
      throw error;
    }

    return { host, element, component };
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
      const popupAnnotationId =
        popup.dataset.pdfTextboxAnnotationId ?? state.activeBurnedAnnotationId;
      if (!popupAnnotationId) continue;
      popup.dataset.pdfTextboxAnnotationId = popupAnnotationId;

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
        void this.deleteBurnedPdfAnnotation(state, popupAnnotationId);
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

  /** Link rectangles inside a burn element, in PDF points relative to the box. */
  private collectBurnLinkTargets(
    element: HTMLElement,
    sourcePath: string,
    width: number,
    height: number,
  ): Array<{ href: string; x: number; y: number; width: number; height: number }> {
    const targets: Array<{
      href: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    const base = element.getBoundingClientRect();
    if (base.width <= 0 || base.height <= 0) return targets;

    const scaleX = width / base.width;
    const scaleY = height / base.height;

    for (const anchor of Array.from(element.querySelectorAll("a"))) {
      const href = this.resolveBurnLinkHref(anchor, sourcePath);
      if (!href) continue;
      const rect = anchor.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      targets.push({
        href,
        x: (rect.left - base.left) * scaleX,
        y: (rect.top - base.top) * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      });
    }

    return targets;
  }

  /** Resolves an anchor to a URI that can be stored in a PDF Link annotation. */
  private resolveBurnLinkHref(
    anchor: HTMLAnchorElement,
    sourcePath: string,
  ): string | null {
    const href = (anchor.getAttribute("href") ?? "").trim();
    const dataHref = (anchor.getAttribute("data-href") ?? "").trim();
    const isInternal =
      dataHref.length > 0 || anchor.classList.contains("internal-link");

    if (!isInternal) {
      return /^(https?:|mailto:|obsidian:)/i.test(href) ? href : null;
    }

    const raw = dataHref || href;
    if (!raw) return null;

    const hashIndex = raw.indexOf("#");
    const linkPath = (hashIndex >= 0 ? raw.slice(0, hashIndex) : raw).trim();
    const subpath = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";
    const file = linkPath
      ? this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath)
      : null;
    const targetPath = file?.path ?? linkPath;
    if (!targetPath) return null;

    const vault = encodeURIComponent(this.app.vault.getName());
    const fileParam = encodeURIComponent(targetPath);
    const anchorParam = subpath ? `#${encodeURIComponent(subpath)}` : "";
    return `obsidian://open?vault=${vault}&file=${fileParam}${anchorParam}`;
  }

  /* ------------------------------- rendering ------------------------------ */

  private scheduleRenderAll(state: PdfViewState): void {
    if (this.states.get(state.leaf) !== state || this.disposed) return;
    // Do not re-render while a textbox is being edited: zooming would destroy
    // the editor and corrupt its geometry. The textbox is re-rendered when
    // editing ends.
    if (state.editing) return;

    const win = state.viewerContainerEl.ownerDocument.defaultView ?? window;

    if (state.renderFrame === null) {
      state.renderFrame = win.requestAnimationFrame(() => {
        state.renderFrame = null;
        if (state.renderTimer !== null) {
          win.clearTimeout(state.renderTimer);
          state.renderTimer = null;
        }
        this.renderAll(state);
      });
    }

    if (state.renderTimer !== null) win.clearTimeout(state.renderTimer);
    state.renderTimer = win.setTimeout(() => {
      state.renderTimer = null;
      if (state.renderFrame !== null) {
        win.cancelAnimationFrame(state.renderFrame);
        state.renderFrame = null;
      }
      this.renderAll(state);
    }, 120);
  }

  private renderAll(state: PdfViewState): void {
    if (this.states.get(state.leaf) !== state || this.disposed) return;
    if (state.editing) return;

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

      const reused = existingElements.has(annotation.id);
      let element = existingElements.get(annotation.id);
      if (!element) {
        element = this.createAnnotationElement(state, annotation);
        layer.appendChild(element);
      }

      existingElements.delete(annotation.id);

      const isEditingThis = state.editing?.annotation.id === annotation.id;

      this.applyAnnotationGeometry(element, annotation, metrics);

      // If the page was re-rendered while this box was being edited, the
      // original editor element is gone. Persist its text and leave edit mode
      // instead of keeping a detached/teleported editor.
      if (isEditingThis && (!reused || !element.isConnected)) {
        const session = state.editing!;
        const value = session.editorView.state.doc.toString();
        if (value.trim().length === 0) {
          if (!session.isNew) {
            const index = this.data.annotations.findIndex(
              (entry) => entry.id === annotation.id,
            );
            if (index >= 0) this.data.annotations.splice(index, 1);
            this.requestSave();
          }
          element.remove();
        } else {
          annotation.text = value;
          annotation.updatedAt = Date.now();
          this.requestSave();
          this.renderAnnotationBody(state, element, annotation);
        }
        state.editing = null;
        session.committing = true;
        try {
          session.editorView.destroy();
        } catch {
          // The editor may already be detached.
        }
        continue;
      }

      if (!isEditingThis) {
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
    if (
      body.dataset.renderedText === annotation.text &&
      body.dataset.renderedPath === state.filePath
    ) {
      return;
    }

    body.dataset.renderedText = annotation.text;
    body.dataset.renderedPath = state.filePath;
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
          delete body.dataset.renderedPath;
          body.empty();
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
    this.applyThemeTextColors(element, annotation.color);

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

  /**
   * Reads the active theme's colours for bold, italic and headings from a
   * hidden probe element and exposes them as CSS variables for this textbox.
   * Colours that would not be readable on the textbox background are replaced
   * with the high-contrast black/white text colour.
   */
  private applyThemeTextColors(
    element: HTMLElement,
    backgroundHex: string,
  ): void {
    const fallback = textColorForBackground(backgroundHex);
    const theme = this.getThemeMarkdownColors(element.ownerDocument);
    const apply = (
      property: string,
      candidate: string,
      minRatio: number,
    ): void => {
      element.style.setProperty(
        property,
        readableColor(candidate, backgroundHex, fallback, minRatio),
      );
    };

    apply("--pdf-textbox-strong-color", theme.strong, 4.5);
    apply("--pdf-textbox-em-color", theme.em, 4.5);
    theme.headings.forEach((color, index) => {
      apply(`--pdf-textbox-h${index + 1}-color`, color, 3);
    });
  }

  private getThemeMarkdownColors(doc: Document): ThemeMarkdownColors {
    const cached = this.themeColors.get(doc);
    if (
      cached &&
      (cached.strong || cached.em || cached.headings.some(Boolean))
    ) {
      return cached;
    }

    const colors: ThemeMarkdownColors = { strong: "", em: "", headings: [] };
    let probe: HTMLElement | null = null;

    try {
      // Prefer a real rendered Markdown view as the probe's parent when one is
      // open: theme CSS sometimes scopes its rules to the workspace leaf, so a
      // probe appended to <body> alone would miss them.
      const markdownLeaf = this.app.workspace.getLeavesOfType("markdown")[0];
      const parent =
        (markdownLeaf?.view?.containerEl?.querySelector(
          ".markdown-preview-view",
        ) as HTMLElement | null) ?? doc.body;

      const win = doc.defaultView ?? window;
      probe = doc.createElement("div");
      probe.className = "markdown-preview-view markdown-rendered";
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText =
        "position:absolute;left:-10000px;top:0;width:320px;visibility:hidden;pointer-events:none;";

      const strongEl = doc.createElement("strong");
      strongEl.textContent = "x";
      const emEl = doc.createElement("em");
      emEl.textContent = "x";
      const paragraph = doc.createElement("p");
      paragraph.append(strongEl, doc.createTextNode(" "), emEl);

      const content = doc.createElement("div");
      content.className = "markdown-preview-sizer markdown-preview-section";
      content.appendChild(paragraph);

      const headingEls: HTMLElement[] = [];
      for (let level = 1; level <= 6; level += 1) {
        const heading = doc.createElement(`h${level}`);
        heading.textContent = "x";
        content.appendChild(heading);
        headingEls.push(heading);
      }
      probe.appendChild(content);

      parent.appendChild(probe);
      colors.strong = win.getComputedStyle(strongEl).color || "";
      colors.em = win.getComputedStyle(emEl).color || "";
      colors.headings = headingEls.map(
        (heading) => win.getComputedStyle(heading).color || "",
      );

      // Fall back to the theme's CSS variables when the element probe did not
      // resolve a colour (some themes only set variables, not element rules).
      const readVar = (name: string): string => {
        const fromBody = win.getComputedStyle(doc.body).getPropertyValue(name).trim();
        const fromRoot = win
          .getComputedStyle(doc.documentElement)
          .getPropertyValue(name)
          .trim();
        return fromBody || fromRoot || "";
      };
      if (!colors.strong) colors.strong = readVar("--bold-color");
      if (!colors.em) colors.em = readVar("--italic-color");
      colors.headings = colors.headings.map((color, index) =>
        color ? color : readVar(`--h${index + 1}-color`),
      );
      for (let index = 0; index < 6; index += 1) {
        if (!colors.headings[index]) {
          colors.headings[index] = readVar("--text-normal");
        }
      }
      if (!colors.strong) colors.strong = readVar("--text-normal");
      if (!colors.em) colors.em = readVar("--text-normal");
    } catch {
      // Fall back to the inherited text colour when the probe cannot run.
    } finally {
      probe?.remove();
    }

    this.themeColors.set(doc, colors);
    return colors;
  }

  private openTextboxLink(
    anchor: HTMLAnchorElement,
    state: PdfViewState,
  ): void {
    const href = (anchor.getAttribute("href") ?? "").trim();
    const dataHref = (anchor.getAttribute("data-href") ?? "").trim();

    if (/^obsidian:/i.test(href)) {
      window.open(href, "_blank");
      return;
    }

    if (/^(https?:|mailto:)/i.test(href)) {
      window.open(href, "_blank");
      return;
    }

    const linkText = dataHref || href;
    if (!linkText) return;
    void this.app.workspace.openLinkText(linkText, state.filePath, false);
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
      if (this.burning) return;
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
      if (this.burning) return;
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
        annotation.file === normalizedPath &&
        annotation.page === pageNumber &&
        annotation.text.trim().length > 0,
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

  /** Returns the PDF page whose rendered content contains the screen point. */
  private findPageElementAtPoint(
    state: PdfViewState,
    clientX: number,
    clientY: number,
  ): HTMLElement | null {
    const pages = state.viewerEl.querySelectorAll<HTMLElement>(PAGE_SELECTOR);
    for (const pageEl of Array.from(pages)) {
      const rect = this.getPageContentRect(pageEl);
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return pageEl;
      }
    }
    return null;
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
      // Defer rendering until PDF.js exposes the real page viewport. The
      // previous fallback assumed rotation 0, which misaligned rotated
      // pages (and teleported editing boxes) during zoom.
      return null;
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

    new Setting(containerEl).setName("Editing").setHeading();

    new Setting(containerEl)
      .setName("Live formatting while editing")
      .setDesc(
        "Apply Markdown formatting and render LaTeX inside the textbox while you type. Markers become visible again while the cursor is inside them.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(settings.livePreviewWhileEditing)
          .onChange((value) =>
            this.plugin.setSettings({ livePreviewWhileEditing: value }),
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
