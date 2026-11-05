import esbuild from "esbuild";
import { mkdir, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const testsDir = "tests";
const outDir = ".test-build";

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const entries = (await readdir(testsDir))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();

if (entries.length === 0) {
  console.error("No tests found in tests/.");
  process.exit(1);
}

for (const entry of entries) {
  await esbuild.build({
    entryPoints: [path.join(testsDir, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: path.join(outDir, entry.replace(/\.ts$/, ".cjs")),
    sourcemap: "inline",
    logLevel: "silent",
  });
}

const compiled = (await readdir(outDir))
  .filter((name) => name.endsWith(".cjs"))
  .sort()
  .map((name) => path.join(outDir, name));

const result = spawnSync(process.execPath, ["--test", ...compiled], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
