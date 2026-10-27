# PDF Textbox

An Obsidian plugin that adds editable Markdown/LaTeX textboxes to Obsidian's native PDF viewer. Textboxes are placed directly on PDF pages, stay anchored while zooming, scrolling, or rotating, and are stored per vault. When you are done, you can burn them permanently into the PDF.

## Features

- **Two toolbar buttons** in the native PDF toolbar (not the hidden find bar):
  - **Place textbox (one-shot)**: stays armed for one placement and deselects itself after a textbox is created.
  - **Edit textboxes**: stays active until you turn it off. In this mode you can move, edit, resize, recolor, and delete existing textboxes.
- **Drag to size**: After clicking **Place textbox**, click once for the default size or drag a rectangle over the page to define the exact size of the new textbox.
- **Immediate editing**: The new textbox is focused right away. In edit mode, clicking an existing textbox opens its editor again.
- **Markdown & LaTeX**: Content is rendered through Obsidian's `MarkdownRenderer`. Headings, bold/italic text, lists, tables, quotes, callouts, code blocks, images, and formulas such as `$e^{i\pi}+1=0$` work like they do in a note.
- **Per-textbox styling**: Right-click a textbox in edit mode to change its background color, adjust its text size, or burn only that textbox into the PDF.
- **Toolbar defaults**: A color picker and a font-size dropdown in the PDF toolbar define the defaults for new textboxes.
- **Zoom- and scroll-stable**: Positions are stored in PDF coordinates (scale 1) and as normalized values. Overlays live inside the PDF page DOM and are realigned on zoom, rotation, scrolling, and page rendering.
- **Persistent**: All textboxes are saved in the plugin's `data.json` (vault path, page, coordinates, size, text, color, and font size).
- **Burn into PDF**: The **Burn textboxes into PDF** command replaces the current PDF with a version that has all textboxes baked in as images. You can also burn a single textbox from its context menu.
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
   - Right-click a textbox to change its background color, change its text size, or choose **Burn this textbox into PDF**.
   - Use the × button to delete it.
   - The mode stays active until you turn it off or press **Esc**.
7. The color picker and font-size dropdown in the PDF toolbar set the defaults for new textboxes.
8. The **Burn textboxes into PDF** command in the command palette (`Ctrl/Cmd + P`) writes all textboxes directly into the current PDF.

Textboxes are visible outside edit mode but pass clicks through, so the PDF remains normally usable.

While editing, keyboard input stays inside the textbox: arrow keys move the caret instead of turning PDF pages. **Esc** cancels and **Ctrl/Cmd + Enter** saves.

## Settings

Under **Settings → PDF Textbox**:

- **Default width**: Width of new textboxes as a percentage of the page width.
- **Font size**: Font size of new textboxes in PDF points (also available from the toolbar dropdown).
- **Background color**: Default color for new textboxes. Individual textboxes can be changed via right-click in edit mode.
- **Opacity**: Transparency of the background color.
- **Confirm before burning**: Warn before overwriting the PDF. The warning dialog also offers **Don't show again**.

Existing textboxes can be individually adjusted in edit mode for width, height, color, and text size.

## Burning into PDF

The **Burn textboxes into PDF** command:

1. renders every textbox with Obsidian's Markdown renderer (including MathJax/LaTeX),
2. converts it into a PNG with a transparent surround,
3. places the image at the correct position and rotation using `pdf-lib`,
4. overwrites the open PDF file and removes the corresponding textbox entries from `data.json`.

Use **Right-click → Burn this textbox into PDF** to burn only a single textbox.

No copy is created. After burning, the textbox content is an image inside the PDF; the rest of the PDF remains unchanged. Because the original file is replaced directly, make a backup first if needed. The warning can be disabled permanently with **Don't show again** in the dialog or **Confirm before burning** in the settings.

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
    "confirmBeforeBurn": true
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
- File paths are updated automatically when a PDF is renamed or moved; deleting a PDF removes its textboxes.

## Technical notes

Obsidian does not expose a public API for its PDF viewer. The plugin accesses internal structures through narrow, optional types:

- `leaf.view.pdfViewer` (`getPageView()`, `currentScale`, `eventBus`)
- `.pdf-viewer-container`, `.pdfViewer`, `.page[data-page-number]`
- `.pdf-toolbar-right` as the anchor for the toolbar controls
- events `pagesinit`, `pagerendered`, `scalechanging`, `rotationchanging`, and `resize`

Markdown is rendered with `MarkdownRenderer.render()` and a view-scoped `Component`. For burning, textboxes are rendered off-screen with the same CSS classes, captured as PNGs with `html2canvas`, and embedded into the PDF pages with `pdf-lib`. The file is then overwritten via `vault.modifyBinary` and the burned entries are removed from `data.json`.

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
   git tag 0.1.0
   git push origin 0.1.0
   ```
3. The GitHub workflow builds the plugin and attaches `main.js`, `manifest.json`, `styles.css`, and `versions.json` to the release.
4. BRAT picks up the release automatically.

## Limitations

- Textboxes only (no freehand drawing, highlights, or shapes).
- Interactive Markdown elements such as checkboxes and links are visible but not clickable in the PDF view, because overlays pass clicks through outside edit mode.
- Burning writes textboxes as images directly into the current PDF; they are no longer selectable as text, and the original PDF is overwritten.
- Data lives per vault in `data.json`; it is only written into a PDF through the burn command.
- No device sync beyond normal vault synchronization.
- Internal PDF.js structures can change with Obsidian updates.
