# PDF Textbox

An Obsidian plugin that adds editable Markdown/LaTeX textboxes to Obsidian's native PDF viewer. Textboxes are placed directly on PDF pages, stay anchored while zooming, scrolling, or rotating, and are stored per vault. When you are done, you can burn them into the PDF as standard PDF annotations, so they can be removed later in a PDF editor.

## Features

- **Two toolbar buttons** in the native PDF toolbar (not the hidden find bar):
  - **Place textbox (one-shot)**: stays armed for one placement and deselects itself after a textbox is created.
  - **Edit textboxes**: stays active until you turn it off. In this mode you can move, edit, resize, recolor, and delete existing textboxes. This state is remembered across PDF switches, plugin reloads, and Obsidian restarts.
- **Drag to size**: After clicking **Place textbox**, click once for the default size or drag a rectangle over the page to define the exact size of the new textbox.
- **Immediate editing**: The new textbox is focused right away. In edit mode, clicking an existing textbox opens its editor again.
- **Markdown & LaTeX**: Content is rendered through Obsidian's `MarkdownRenderer`. Headings, bold/italic text, lists, tables, quotes, callouts, code blocks, images, and formulas such as `$e^{i\pi}+1=0$` work like they do in a note.
- **Obsidian editor experience**: Textboxes use CodeMirror 6. If the **LaTeX Suite** plugin is installed and enabled, its snippets, autofractions, and other editor features work inside the textbox editor. Common Obsidian formatting hotkeys are supported: `Ctrl/Cmd+B` (bold), `Ctrl/Cmd+I` (italic), `Ctrl/Cmd+E` (inline code), `Ctrl/Cmd+Shift+X` (strikethrough), `Ctrl/Cmd+Shift+H` (highlight), and `Ctrl/Cmd+K` (link).
- **Live formatting while typing**: Markdown formatting is applied and LaTeX is rendered directly inside the editor as you type instead of only after leaving the textbox. Markdown markers reappear while the cursor is inside the formatted text, so the source stays editable. Can be turned off in the settings.
- **Wrap a selection**: With text selected, typing `*`, `_`, `` ` ``, `$`, `=` or `~` wraps the selection instead of replacing it. Typing the character twice gives bold, display math or a highlight.
- **Clickable links**: Links in a textbox open in the browser or resolve inside the vault. When burning, invisible PDF Link annotations are added on top of the rendered link text, so links also work in the burned PDF.
- **Theme-aware text colours**: Bold, italic and headings use the colours of the active Obsidian theme. If a theme colour would be hard to read on the textbox background, the plugin falls back to a high-contrast black or white.
- **Readable cursor**: The editor cursor follows the text contrast color and is rendered thicker, so it remains visible on light and dark backgrounds.
- **Collapsible textboxes**: In edit mode, the minus button collapses a textbox to a small T icon. Hovering the icon temporarily expands the content; clicking the icon expands it permanently. The collapsed state is saved.
- **Per-textbox styling**: Right-click a textbox in edit mode to change its background color, adjust its text size, or burn only that textbox into the PDF.
- **Toolbar defaults**: A color picker and a font-size dropdown in the PDF toolbar define the defaults for new textboxes.
- **Zoom- and scroll-stable**: Positions are stored in PDF coordinates (scale 1) and as normalized values. Overlays live inside the PDF page DOM and are realigned on zoom, rotation, scrolling, and page rendering.
- **Persistent**: All textboxes are saved in the plugin's `data.json` (vault path, page, coordinates, size, text, color, and font size).
- **Burn into PDF**: The **Burn textboxes into PDF** command replaces the current PDF with a version that stores all textboxes as standard PDF Stamp annotations. You can also burn a single textbox from its context menu. Clicking a burned annotation in Obsidian shows a trash button; you can also focus it and press **Delete** or **Backspace** to remove it.
- **Multiple PDF tabs** are supported at the same time.

## Installation via BRAT (beta)

1. Install and enable BRAT.
2. Open BRAT → **Add Beta plugin**.
3. Enter the repository URL:
   `https://github.com/xMoZz/pdf-textbox-obsidian-plugin`
4. Enable the plugin.

BRAT downloads `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release.

## Manual installation

1. Download a release or build it yourself (`npm install && npm run build`).
2. Create the folder `.obsidian/plugins/pdf-textbox/` in your vault.
3. Copy `main.js`, `manifest.json`, and `styles.css` into it.
4. Enable the plugin under **Settings → Community plugins**.

## Usage

1. Open a PDF in Obsidian.
2. Click **Place textbox** in the PDF toolbar. The button is armed for the next placement only.
3. Click a spot on the page for the default size, or hold the mouse button and drag a rectangle to define the size. The textbox is created and focused.
4. Enter content. Markdown and LaTeX are rendered after saving:
   - **Esc** cancels a new empty textbox or restores the previous text.
   - **Ctrl/Cmd + Enter** or clicking outside saves.
   - Clearing the text of an existing textbox removes it.
5. To add another textbox, click **Place textbox** again.
6. Turn on **Edit textboxes** for persistent editing:
   - Drag the handle at the top-left to move a textbox.
   - Drag the handle at the bottom-right to resize it horizontally and vertically.
   - Use the minus button at the top-right to collapse the textbox to a small T icon.
   - Hover the icon to preview the full textbox temporarily; click it to expand the textbox permanently.
   - Right-click a textbox to change its background color, change its text size, or choose **Burn this textbox into PDF**.
   - Use the × button to delete it.
   - The mode stays active until you turn it off or press **Esc**.
7. The color picker and font-size dropdown in the PDF toolbar set the defaults for new textboxes.
8. The **Burn textboxes into PDF** command in the command palette (`Ctrl/Cmd + P`) stores all textboxes as PDF annotations in the current PDF.
9. To remove a burned textbox later, click its annotation in Obsidian and use the trash button in the popup, or focus it and press **Delete** / **Backspace**. The PDF is rewritten without that annotation.

While editing, use the normal Markdown editor shortcuts (`Ctrl/Cmd+B`, `Ctrl/Cmd+I`, etc.). With **LaTeX Suite** installed and enabled, its math snippets and autofractions also work inside textboxes.

The **Edit textboxes** state is saved in the plugin settings and is restored after switching PDFs, reloading the plugin, or restarting Obsidian.

Textboxes are visible outside edit mode but pass clicks through, so the PDF remains normally usable.

While editing, keyboard input stays inside the textbox: arrow keys move the caret instead of turning PDF pages. **Esc** cancels and **Ctrl/Cmd + Enter** saves.

## Settings

Under **Settings → PDF Textbox**:

- **Default width**: Width of new textboxes as a percentage of the page width.
- **Font size**: Font size of new textboxes in PDF points (also available from the toolbar dropdown).
- **Background color**: Default color for new textboxes. Individual textboxes can be changed via right-click in edit mode.
- **Opacity**: Transparency of the background color.
- **Live formatting while editing**: Render Markdown formatting and LaTeX inside the textbox while typing. Disable it to always see the raw Markdown source.
- **Confirm before burning**: Warn before overwriting the PDF. The warning dialog also offers **Don't show again**.

Existing textboxes can be individually adjusted in edit mode for width, height, color, and text size.

## Burning into PDF

The **Burn textboxes into PDF** command:

1. renders every textbox with Obsidian's Markdown renderer (including MathJax/LaTeX),
2. converts it into a PNG with a transparent surround,
3. creates a standard PDF **Stamp annotation** with that image as its appearance stream, positioned at the correct location and rotation,
4. overwrites the open PDF file and removes the corresponding textbox entries from `data.json`.

Use **Right-click → Burn this textbox into PDF** to burn only a single textbox.

No copy is created. After burning, the textbox is a regular PDF annotation named **PDF Textbox**; the rest of the PDF remains unchanged. Because it is an annotation rather than page content, you can remove it later with any PDF annotation editor. In Obsidian, click the burned annotation and use the trash button in its popup, or press **Delete** / **Backspace** while it is focused. Because the original file is replaced directly, make a backup first if needed. The warning can be disabled permanently with **Don't show again** in the dialog or **Confirm before burning** in the settings.

## Data model

The plugin stores its data in `data.json`:

```json
{
  "version": 1,
  "settings": {
    "defaultWidthPercent": 22,
    "defaultFontSize": 12,
    "backgroundColor": "#ffd54f",
    "backgroundColorOpacity": 0.58,
    "confirmBeforeBurn": true,
    "livePreviewWhileEditing": true,
    "editModeEnabled": true
  },
  "annotations": [
    {
      "id": "7a5e…",
      "file": "Folder/Document.pdf",
      "page": 3,
      "x": 142.5,
      "y": 260.25,
      "width": 180,
      "height": 42,
      "nx": 0.2328,
      "ny": 0.3286,
      "nw": 0.2941,
      "nh": 0.0530,
      "rotation": 0,
      "text": "**Comment** with $x^2$",
      "fontSize": 12,
      "color": "#ffd54f",
      "collapsed": false,
      "createdAt": 1760000000000,
      "updatedAt": 1760000000000
    }
  ]
}
```

- `x`, `y`, `width`, and `height` are PDF page coordinates at scale 1 for the rotation that was active when the textbox was created.
- `nx`, `ny`, `nw`, and `nh` are normalized 0–1 values used for rendering.
- `text` contains the original Markdown/LaTeX source.
- `color` is the background color of that textbox.
- `collapsed` stores whether the textbox is minimized to its hoverable icon.
- `editModeEnabled` remembers whether edit mode should be on after reload or PDF switches.
- `livePreviewWhileEditing` controls whether formatting is applied while typing.
- File paths are updated automatically when a PDF is renamed or moved; deleting a PDF removes its textboxes.

## Technical notes

Obsidian does not expose a public API for its PDF viewer. The plugin accesses internal structures through narrow, optional types:

- `leaf.view.pdfViewer` (`getPageView()`, `currentScale`, `eventBus`)
- `.pdf-viewer-container`, `.pdfViewer`, `.page[data-page-number]`
- `.pdf-toolbar-right` as the anchor for the toolbar controls
- events `pagesinit`, `pagerendered`, `scalechanging`, `rotationchanging`, and `resize`

Markdown is rendered with `MarkdownRenderer.render()` and a view-scoped `Component`. The inline editor is a CodeMirror 6 `EditorView` using Obsidian's Markdown language facet and `editorLivePreviewField`; when the **LaTeX Suite** plugin is enabled, its registered editor extensions are added to the editor state. Because Obsidian's Live Preview decorations are only installed on Markdown views, the plugin adds its own decoration plugin for live formatting: it styles bold/italic/strikethrough/highlight/inline code, links, headings, and renders inline LaTeX with `renderMath`, while hiding the Markdown markers unless the cursor is inside the construct. Theme colours for bold, italic and headings are read from a hidden probe element that uses Obsidian's rendered-Markdown classes, so theme CSS applies unchanged. For burning, textboxes are rendered off-screen with the same CSS classes and captured as PNGs with `html2canvas`. `pdf-lib` creates a Form XObject appearance stream for each image and adds a `/Stamp` annotation to the page's `/Annots` array, plus one invisible `/Link` annotation per rendered link. The file is then overwritten via `vault.modifyBinary` and the burned entries are removed from `data.json`. The delete action in the annotation popup resolves the PDF.js annotation ID back to the PDF object and removes that annotation from `/Annots`.

Coordinates are measured with `getBoundingClientRect()` on `.canvasWrapper`. That rectangle is already viewport-relative, so the PDF container's scroll offset is included; scale is derived from `viewport.width / pageView.scale` or `rect.width / baseWidth`.

All internal accesses are typed and optional so an Obsidian update does not immediately produce a hard failure. If Obsidian changes the DOM structure, views are retried up to 40 times and then the plugin stays inactive for that view.

## Development

```bash
npm install
npm run dev      # Watch build
npm run build    # Typecheck + production build
```

The release version must match in `package.json`, `manifest.json`, and `versions.json`.

## Release

1. Bump the version in `package.json`, `manifest.json`, and `versions.json`.
2. Commit and push a tag:
   ```bash
   git tag 0.1.3
   git push origin 0.1.3
   ```
3. The GitHub workflow builds the plugin and attaches `main.js`, `manifest.json`, `styles.css`, and `versions.json` to the release.
4. BRAT picks up the release automatically.

## Limitations

- Textboxes only (no freehand drawing, highlights, or shapes).
- Interactive Markdown elements such as checkboxes are visible but not clickable in the PDF view, because overlays pass clicks through outside edit mode. Links are the exception and are clickable.
- LaTeX Suite integration requires the LaTeX Suite plugin to be installed and enabled. Other third-party editor extensions are not automatically included in the textbox editor.
- Live formatting while editing covers inline constructs (bold, italic, strikethrough, highlight, inline code, links, headings, and LaTeX). Block-level elements such as tables, callouts, and embedded images are shown in their rendered form after you leave the editor.
- Link annotations are only written when burning. PDFs that were burned with an older version of the plugin do not contain link targets and cannot be made clickable retroactively; re-add the textbox and burn it again.
- Burning stores textboxes as PDF Stamp annotations with image appearances; their text is not selectable, and the original PDF is overwritten.
- Burned annotations can be removed later with a PDF annotation editor or directly in Obsidian via the trash button / **Delete** / **Backspace** when the annotation is focused. They are no longer managed by the textbox editor after burning.
- Data lives per vault in `data.json`; it is only written into a PDF through the burn command.
- No device sync beyond normal vault synchronization.
- Internal PDF.js structures can change with Obsidian updates.
