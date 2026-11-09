import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const dirArgument = process.argv.find((argument) => argument.startsWith("--dir="));
const vaultDir = path.resolve(
  dirArgument ? dirArgument.slice("--dir=".length) : "test-vault",
);
const pluginDir = path.join(vaultDir, ".obsidian", "plugins", "pdf-textbox");
const annotationsDir = path.join(pluginDir, "annotations");
const stress = process.argv.includes("--stress");

/* -------------------------------------------------------------------------- */
/*  Visible test image (PNG)                                                   */
/* -------------------------------------------------------------------------- */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createTestImage(width = 240, height = 120) {
  const bytesPerRow = width * 3 + 1;
  const raw = Buffer.alloc(bytesPerRow * height);

  for (let y = 0; y < height; y += 1) {
    const row = y * bytesPerRow;
    raw[row] = 0; // no filter
    for (let x = 0; x < width; x += 1) {
      const border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
      const checker = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 === 0;
      const stripe = Math.abs(x - y * 2) < 6;

      let red = checker ? 255 : 33;
      let green = checker ? 213 : 150;
      let blue = checker ? 79 : 243;
      if (border) {
        red = 28;
        green = 28;
        blue = 28;
      } else if (stripe) {
        red = 255;
        green = 255;
        blue = 255;
      }

      const offset = row + 1 + x * 3;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}


await mkdir(pluginDir, { recursive: true });
await mkdir(path.join(vaultDir, ".obsidian"), { recursive: true });

// Always start from a clean legacy state so the automatic migration can be
// tested again. The plugin code itself is kept.
await rm(annotationsDir, { recursive: true, force: true });
await rm(path.join(pluginDir, "data.json"), { force: true });
await rm(path.join(pluginDir, "data.json.v1.bak"), { force: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await copyFile(file, path.join(pluginDir, file));
}

await writeFile(
  path.join(vaultDir, ".obsidian", "community-plugins.json"),
  JSON.stringify(["pdf-textbox"], null, 2),
);

for (const entry of await readdir(vaultDir)) {
  if (entry.startsWith("Pasted image ") || entry === "pixel.png") {
    await rm(path.join(vaultDir, entry), { force: true });
  }
}
await writeFile(path.join(vaultDir, "test-image.png"), createTestImage());

const font = await loadFont();
const boldFont = await loadBoldFont();

async function loadFont() {
  return StandardFonts.Helvetica;
}

async function loadBoldFont() {
  return StandardFonts.HelveticaBold;
}

function decoratePage(page, label, note, fontName, boldName) {
  const { width, height } = page.getSize();
  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height,
    borderColor: rgb(0.65, 0.65, 0.65),
    borderWidth: 1,
  });
  page.drawText(label, {
    x: 32,
    y: height - 54,
    size: 26,
    font: boldName,
    color: rgb(0.15, 0.15, 0.15),
  });
  page.drawText(note, {
    x: 32,
    y: height - 78,
    size: 11,
    font: fontName,
    color: rgb(0.35, 0.35, 0.35),
  });

  // A grid makes it easy to see whether overlays stay aligned while zooming.
  for (let x = 32; x < width; x += 64) {
    page.drawLine({
      start: { x, y: 32 },
      end: { x, y: height - 32 },
      thickness: 0.3,
      color: rgb(0.85, 0.85, 0.85),
    });
  }
  for (let y = 32; y < height; y += 64) {
    page.drawLine({
      start: { x: 32, y },
      end: { x: width - 32, y },
      thickness: 0.3,
      color: rgb(0.85, 0.85, 0.85),
    });
  }
  page.drawText(`Page ${label}`, {
    x: width - 110,
    y: 34,
    size: 10,
    font: fontName,
    color: rgb(0.5, 0.5, 0.5),
  });
}

async function createDemoPdf() {
  const pdf = await PDFDocument.create();
  const fontName = await pdf.embedFont(font);
  const boldName = await pdf.embedFont(boldFont);

  const pages = [
    {
      size: [595, 842],
      label: "1 - Portrait",
      note: "Default A4 portrait page. Zoom, scroll and drag textboxes here.",
    },
    {
      size: [595, 842],
      label: "2 - Portrait",
      note: "Second page: edit mode, collapse, colors and cross-page dragging.",
    },
    {
      size: [842, 595],
      label: "3 - Landscape",
      note: "Landscape page: geometry must stay stable when the page size changes.",
    },
    {
      size: [595, 842],
      label: "4 - Rotated 90",
      note: "Page rotation is 90 degrees. Textboxes must stay on the visible page.",
      rotation: 90,
    },
  ];

  for (const entry of pages) {
    const page = pdf.addPage(entry.size);
    if (entry.rotation) page.setRotation(degrees(entry.rotation));
    decoratePage(page, entry.label, entry.note, fontName, boldName);
  }

  return pdf.save();
}

async function createSecondPdf() {
  const pdf = await PDFDocument.create();
  const fontName = await pdf.embedFont(font);
  const boldName = await pdf.embedFont(boldFont);

  const first = pdf.addPage([595, 842]);
  decoratePage(
    first,
    "A - Second PDF",
    "Used for rename, delete and multi-tab tests.",
    fontName,
    boldName,
  );
  const second = pdf.addPage([595, 842]);
  decoratePage(
    second,
    "B - Second PDF",
    "Textboxes on this page should survive a restart.",
    fontName,
    boldName,
  );

  return pdf.save();
}

async function createStressPdf() {
  const pdf = await PDFDocument.create();
  const fontName = await pdf.embedFont(font);
  const boldName = await pdf.embedFont(boldFont);

  for (let index = 1; index <= 12; index += 1) {
    const page = pdf.addPage([595, 842]);
    decoratePage(
      page,
      `${index} - Stress`,
      "360 textboxes across this PDF; use it for scroll/zoom performance.",
      fontName,
      boldName,
    );
  }

  return pdf.save();
}

await rm(path.join(vaultDir, "Stress.pdf"), { force: true });
await writeFile(path.join(vaultDir, "Demo.pdf"), await createDemoPdf());
await writeFile(path.join(vaultDir, "Second.pdf"), await createSecondPdf());
if (stress) {
  await writeFile(path.join(vaultDir, "Stress.pdf"), await createStressPdf());
}

const now = Date.now();
const box = (id, file, page, nx, ny, nw, nh, text, extra = {}) => ({
  id,
  file,
  page,
  // Legacy v1 coordinate fields: the new code ignores them on purpose.
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  nx,
  ny,
  nw,
  nh,
  rotation: extra.rotation ?? 0,
  text,
  fontSize: extra.fontSize ?? 12,
  color: extra.color ?? "#ffd54f",
  collapsed: extra.collapsed ?? false,
  createdAt: now,
  updatedAt: now,
});

const annotations = [
  box(
    "demo-1",
    "Demo.pdf",
    1,
    0.07,
    0.1,
    0.4,
    0.12,
    "**Markdown** and $e^{i\\pi}+1=0$\n\n- First item\n- Second item\n\n> A quote.",
  ),
  box(
    "demo-2",
    "Demo.pdf",
    1,
    0.55,
    0.1,
    0.36,
    0.1,
    "A [link to Obsidian](https://obsidian.md) and `inline code`.\n\nAlso an internal link: [[TESTING|Testing notes]].",
    { color: "#bbdefb" },
  ),
  box(
    "demo-3",
    "Demo.pdf",
    1,
    0.07,
    0.38,
    0.4,
    0.12,
    "Longer text to test wrapping and automatic height. Resize this box with the bottom-right handle.",
    { fontSize: 14, color: "#f8bbd0" },
  ),
  box(
    "demo-4",
    "Demo.pdf",
    2,
    0.12,
    0.2,
    0.5,
    0.12,
    "![[test-image.png]]\n\nA visible test image. It should render after migration too.",
  ),
  box(
    "demo-5",
    "Demo.pdf",
    2,
    0.62,
    0.55,
    0.28,
    0.1,
    "Collapsed box. Hover the small T icon in edit mode.",
    { collapsed: true, color: "#b2dfdb" },
  ),
  box(
    "demo-6",
    "Demo.pdf",
    3,
    0.5,
    0.45,
    0.38,
    0.14,
    "Landscape page. Try zooming and rotating the PDF view.",
    { color: "#d1c4e9" },
  ),
  box(
    "demo-7",
    "Demo.pdf",
    4,
    0.12,
    0.12,
    0.4,
    0.12,
    "Rotated page. The box should stay at the top-left of the visible page.",
    { rotation: 90, color: "#ffcc80" },
  ),
  box(
    "second-1",
    "Second.pdf",
    1,
    0.1,
    0.15,
    0.55,
    0.1,
    "Second PDF, first page. Rename this PDF to verify that textboxes follow.",
  ),
  box(
    "second-2",
    "Second.pdf",
    2,
    0.1,
    0.3,
    0.55,
    0.1,
    "Second PDF, second page. Delete this PDF afterwards to test shard cleanup.",
    { color: "#d4d4d4" },
  ),
  // Kept intentionally: there is no Missing.pdf. The shard must survive without
  // showing an error inside an open PDF.
  box(
    "missing-1",
    "Missing.pdf",
    1,
    0.1,
    0.1,
    0.3,
    0.1,
    "This PDF does not exist. Used to test orphan shard handling.",
  ),
];

if (stress) {
  let index = 0;
  for (let page = 1; page <= 12; page += 1) {
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        index += 1;
        annotations.push(
          box(
            `stress-${index}`,
            "Stress.pdf",
            page,
            0.04 + column * 0.19,
            0.12 + row * 0.13,
            0.17,
            0.09,
            `Stress box ${index} on page ${page}.`,
            { fontSize: 8, color: column % 2 === 0 ? "#ffd54f" : "#bbdefb" },
          ),
        );
      }
    }
  }
}

const legacy = {
  version: 1,
  settings: {
    defaultWidthPercent: 22,
    defaultFontSize: 12,
    backgroundColor: "#ffd54f",
    backgroundColorOpacity: 0.58,
    confirmBeforeBurn: true,
    livePreviewWhileEditing: true,
    editModeEnabled: false,
  },
  annotations,
};

await writeFile(
  path.join(pluginDir, "data.json"),
  JSON.stringify(legacy, null, 2),
);

await writeFile(
  path.join(vaultDir, "TESTING.md"),
  `# PDF Textbox test vault

Open this folder as a vault in Obsidian. Turn off Restricted Mode (Settings →
Community plugins) and make sure **PDF Textbox** is enabled. On the first PDF
open the plugin migrates \`data.json\` (v1) into \`.obsidian/plugins/pdf-textbox/annotations/\`
and keeps \`data.json.v1.bak\`.

## First check

1. Open **Demo.pdf**.
2. You should see one notice: "textbox storage was updated automatically".
3. Verify \`.obsidian/plugins/pdf-textbox/annotations/\` contains one shard per PDF
   and \`data.json\` no longer contains an \`annotations\` array.
4. Verify the textboxes appear on pages 1-4, including the landscape and the
   rotated page.

## Feature checks

- Zoom, scroll and rotate the PDF: boxes must stay on their page.
- Toggle **Edit textboxes** in the toolbar (Escape must not turn it off).
- Drag the top-left handle, resize from the bottom-right handle.
- Drag a box from page 1 to page 2.
- Right-click a box: change color, text size, collapse/expand it, burn one box.
- Collapse a box from the right-click menu; hover the T icon; expand it again.
- Place a new box, type Markdown/LaTeX and press Ctrl/Cmd+Enter.
- Paste an image with Ctrl/Cmd+V.
- Open Demo.pdf in a second tab.
- Restart Obsidian: all boxes and the edit mode state must persist.
- Rename Demo.pdf: boxes must follow.
- Delete Second.pdf: its shard must be removed.
- Run "Delete all textboxes in current PDF" on Demo.pdf.
- Burn textboxes into Demo.pdf, then delete a burned annotation via its popup.

## Reset

Run \`npm run test-vault:reset\` in the repository (with the vault closed). This
regenerates the PDFs, restores the legacy v1 data and removes all shards, so
migration can be tested again. Reload Obsidian afterwards.

For the separate performance vault with 360 boxes, run
\`npm run test-vault:stress\`. It is created as \`test-vault-stress\` and can be
opened as its own vault.
`,
);

console.log(`Test vault created at ${vaultDir}`);
console.log(
  stress
    ? "Includes Stress.pdf with 360 textboxes."
    : "Run with --stress to add a 360-textbox performance PDF.",
);
console.log("Open it in Obsidian and start with Demo.pdf.");
