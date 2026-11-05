import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  PageAnnotationIndex,
  baseSizeForRotation,
  coerceStoredData,
  mergeAnnotations,
  normalizeRotation,
  normalizeVaultPath,
  rotateNormalizedRect,
  shardIdForPath,
  type PdfTextboxAnnotation,
} from "../src/core";

function annotation(
  id: string,
  page: number,
  text = "Hello",
  overrides: Partial<PdfTextboxAnnotation> = {},
): PdfTextboxAnnotation {
  return {
    id,
    file: "Folder/Test.pdf",
    page,
    nx: 0.1,
    ny: 0.1,
    nw: 0.2,
    nh: 0.1,
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

test("normalizeRotation snaps and wraps", () => {
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(Number.NaN), 0);
});

test("rotateNormalizedRect rotates clockwise and round-trips", () => {
  const rotated = rotateNormalizedRect(0.1, 0.2, 0.3, 0.4, 0, 90);
  assert.ok(Math.abs(rotated.x - 0.4) < 1e-9);
  assert.ok(Math.abs(rotated.y - 0.1) < 1e-9);
  assert.ok(Math.abs(rotated.width - 0.4) < 1e-9);
  assert.ok(Math.abs(rotated.height - 0.3) < 1e-9);

  const back = rotateNormalizedRect(
    rotated.x,
    rotated.y,
    rotated.width,
    rotated.height,
    90,
    0,
  );
  assert.ok(Math.abs(back.x - 0.1) < 1e-9);
  assert.ok(Math.abs(back.y - 0.2) < 1e-9);
  assert.ok(Math.abs(back.width - 0.3) < 1e-9);
  assert.ok(Math.abs(back.height - 0.4) < 1e-9);
});

test("baseSizeForRotation swaps dimensions", () => {
  assert.deepEqual(baseSizeForRotation(600, 800, 0, 90), {
    width: 800,
    height: 600,
  });
  assert.deepEqual(baseSizeForRotation(600, 800, 90, 180), {
    width: 800,
    height: 600,
  });
  assert.deepEqual(baseSizeForRotation(600, 800, 0, 180), {
    width: 600,
    height: 800,
  });
});

test("PageAnnotationIndex groups, moves and removes", () => {
  const index = new PageAnnotationIndex();
  const first = annotation("a", 1);
  const second = annotation("b", 1);
  const third = annotation("c", 2);
  index.add(first);
  index.add(second);
  index.add(third);

  assert.equal(index.size, 3);
  assert.deepEqual(index.get(1).map((entry) => entry.id), ["a", "b"]);
  assert.deepEqual(index.get(2).map((entry) => entry.id), ["c"]);

  index.moveToPage(first, 2);
  assert.deepEqual(index.get(1).map((entry) => entry.id), ["b"]);
  assert.deepEqual(
    index.get(2).map((entry) => entry.id).sort(),
    ["a", "c"],
  );

  assert.equal(index.remove("b"), true);
  assert.deepEqual(index.get(1), []);
  assert.equal(index.remove("missing"), false);
  assert.equal(index.size, 2);
});

test("mergeAnnotations keeps the newest entry per id", () => {
  const older = annotation("a", 1, "old", { updatedAt: 10 });
  const newer = annotation("a", 1, "new", { updatedAt: 20 });
  const extra = annotation("b", 2, "extra", { updatedAt: 5 });

  const merged = mergeAnnotations([older], [newer, extra]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((entry) => entry.id === "a")?.text, "new");
  assert.equal(merged.find((entry) => entry.id === "b")?.text, "extra");
});

test("coerceStoredData migrates v1 annotations and filters empty boxes", () => {
  const stored = coerceStoredData({
    version: 1,
    settings: { backgroundColor: "#ABCDEF" },
    annotations: [
      {
        id: "a",
        file: "Folder\\Doc.pdf",
        page: 1,
        nx: 0.1,
        ny: 0.2,
        nw: 0.3,
        nh: 0.1,
        text: "**Hello**",
        color: "#123456",
      },
      {
        id: "b",
        file: "Folder/Doc.pdf",
        page: 1,
        nx: 0.1,
        ny: 0.2,
        nw: 0.3,
        nh: 0.1,
        text: "   ",
      },
    ],
  });

  assert.equal(stored.version, 1);
  assert.equal(stored.settings.backgroundColor, "#abcdef");
  assert.equal(stored.annotations.length, 1);
  assert.equal(stored.annotations[0]?.file, "Folder/Doc.pdf");
  assert.equal(stored.annotations[0]?.color, "#123456");
  assert.deepEqual(stored.shards, {});
});

test("coerceStoredData reads v2 index and keeps downgrade residue", () => {
  const stored = coerceStoredData({
    version: 2,
    settings: DEFAULT_SETTINGS,
    shards: { "Folder/Doc.pdf": "abc-Doc", "Other.pdf": "bad/id" },
    annotations: [
      {
        id: "residue",
        file: "New.pdf",
        page: 1,
        nx: 0,
        ny: 0,
        nw: 0.2,
        nh: 0.1,
        text: "residue",
      },
    ],
  });

  assert.equal(stored.version, 2);
  assert.deepEqual(stored.shards, { "Folder/Doc.pdf": "abc-Doc" });
  assert.equal(stored.annotations.length, 1);
  assert.equal(stored.annotations[0]?.id, "residue");
});

test("shard ids are deterministic, human readable and path safe", () => {
  const first = shardIdForPath("Folder/My Paper.pdf");
  const second = shardIdForPath("Folder/My Paper.pdf");
  const other = shardIdForPath("Folder/Other Paper.pdf");

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{16}-My Paper$/);
  assert.ok(!first.includes("/"));
});

test("normalizeVaultPath normalises separators and edges", () => {
  assert.equal(normalizeVaultPath("\\Folder\\Doc.pdf"), "Folder/Doc.pdf");
  assert.equal(normalizeVaultPath("/Folder//Doc.pdf/"), "Folder/Doc.pdf");
});
