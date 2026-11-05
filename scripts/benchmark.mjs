import esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";

const outDir = ".test-build";
const bundle = path.join(outDir, "core.bench.mjs");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await esbuild.build({
  entryPoints: ["src/core.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: bundle,
  logLevel: "silent",
});

const { PageAnnotationIndex } = await import(pathToFileURL(bundle).href);

const TOTAL = 50_000;
const PAGES = 200;
const PER_PAGE = Math.ceil(TOTAL / PAGES);

const annotations = Array.from({ length: TOTAL }, (_, index) => ({
  id: `id-${index}`,
  file: "Bench.pdf",
  page: (index % PAGES) + 1,
  nx: 0.1,
  ny: 0.1,
  nw: 0.2,
  nh: 0.1,
  rotation: 0,
  text: `Textbox ${index}`,
  fontSize: 12,
  color: "#ffd54f",
  collapsed: false,
  createdAt: index,
  updatedAt: index,
}));

function measure(label, fn) {
  const start = performance.now();
  const value = fn();
  const elapsed = performance.now() - start;
  console.log(`${label.padEnd(48)} ${elapsed.toFixed(2)} ms`);
  return value;
}

console.log(`Annotations: ${TOTAL}, pages: ${PAGES}, per page: ~${PER_PAGE}\n`);

const index = measure("Build PageAnnotationIndex", () => {
  const next = new PageAnnotationIndex();
  for (const annotation of annotations) next.add(annotation);
  return next;
});

measure("Query every page via index", () => {
  let count = 0;
  for (let page = 1; page <= PAGES; page += 1) {
    count += index.get(page).length;
  }
  return count;
});

measure("Query every page via global filter (old path)", () => {
  let count = 0;
  for (let page = 1; page <= PAGES; page += 1) {
    count += annotations.filter(
      (annotation) => annotation.file === "Bench.pdf" && annotation.page === page,
    ).length;
  }
  return count;
});

measure("Move 10,000 annotations between pages", () => {
  for (let index2 = 0; index2 < 10_000; index2 += 1) {
    const annotation = annotations[index2];
    if (!annotation) continue;
    index.moveToPage(annotation, (index2 % PAGES) + 1);
  }
});

console.log("\nDone.");
