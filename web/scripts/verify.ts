// Node verification: runs the real pipeline on a folder (read-only), writes output to an out dir.
// usage: tsx scripts/verify.ts <input-folder> <out-dir> [--no-ocr]
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildNameSet, rewriteText } from "../src/names";
import { harvest, processFile, type Ctx } from "../src/pipeline";
import { assignIds, toCsv } from "../src/key";
import { classify, detectPatients } from "../src/scan";
import { createOcr, type OcrEngine } from "../src/process/ocr";
import { nodeIO } from "./nodeio";

const [input, out, ...flags] = process.argv.slice(2);
if (!input || !out) throw new Error("usage: verify.ts <input-folder> <out-dir> [--no-ocr]");

async function walk(dir: string): Promise<string[]> {
  const acc: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) acc.push(...(await walk(p)));
    else acc.push(p);
  }
  return acc;
}

const rootName = input.replace(/\/+$/, "").split("/").pop()!;
const files = (await walk(input)).map((abs) => ({ abs, path: rootName + "/" + relative(input, abs).split(sep).join("/") }));
const patients = detectPatients(files);

let engine: OcrEngine | undefined;
let ocrNote = "OCR disabled (--no-ocr)";
if (!flags.includes("--no-ocr")) {
  try {
    engine = await createOcr();
    ocrNote = "OCR enabled (tesseract.js)";
  } catch (e) {
    ocrNote = `OCR unavailable: ${(e as Error).message}`;
  }
}
console.log(ocrNote);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const ids = assignIds(patients.map((p) => p.name), []);
await writeFile(join(out, "..", "key.csv"), toCsv(patients.map((p) => ({ name: p.name, id: ids.get(p.name)!, folder: p.name }))));

const summary: Record<string, number> = {};
for (const p of patients) {
  const id = ids.get(p.name)!;
  let ns = buildNameSet([p.name]);
  const names = new Set<string>();
  for (const f of p.files) {
    const k = classify(f.relPath);
    if (k === "docx" || k === "pdf" || k === "text") for (const n of await harvest(f.relPath.split("/").pop()!, await openAsBlob(f.abs), ns)) names.add(n);
  }
  ns = buildNameSet([p.name, ...names]);
  console.log(`${id}: harvested ${names.size} extra name variant(s)`);
  const ctx: Ctx = { ns, id, io: engine ? nodeIO : undefined, ocr: engine ? async () => engine!.recognize : undefined };
  const used = new Set<string>();
  const manifest: unknown[] = [];
  for (const f of p.files) {
    const base = f.relPath.split("/").pop()!;
    const dirs = f.relPath.split("/").slice(0, -1).map((d) => rewriteText(d, ns, id));
    const r = await processFile(base, await openAsBlob(f.abs), ctx);
    const key = `${r.status}/${r.kind}`;
    summary[key] = (summary[key] ?? 0) + 1;
    if (r.status === "dropped") continue;
    let rel = [...dirs, r.outName].join("/");
    for (let n = 2; used.has(rel.toLowerCase()); n++) rel = [...dirs, r.outName.replace(/(\.[^.]*)?$/, ` (${n})$1`)].join("/");
    used.add(rel.toLowerCase());
    manifest.push({ path: rel, status: r.status, kind: r.kind, actions: r.actions, reason: r.reason });
    console.log(`  ${r.status.padEnd(7)} ${r.kind.padEnd(7)} ${rel}${r.reason ? "  [" + r.reason + "]" : ""}`);
    if (r.status === "ok" && r.data) {
      const dest = join(out, id, rel);
      await mkdir(join(dest, ".."), { recursive: true });
      const bytes = r.data instanceof Blob ? new Uint8Array(await r.data.arrayBuffer()) : r.data;
      await writeFile(dest, bytes);
    }
  }
  await writeFile(join(out, id, "manifest.json"), JSON.stringify({ id, files: manifest }, null, 2));
}
console.log("summary", JSON.stringify(summary));
await engine?.terminate();

