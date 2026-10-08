import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildNameSet, strictLeaks } from "../src/names";
import { leakCheckPdf } from "../src/process/pdf";
import { ocrBitmap, withoutBlackWords } from "../src/process/image";
import { createOcr } from "../src/process/ocr";
import { nodeIO } from "./nodeio";
const [out, ...names] = process.argv.slice(2);
const ns = buildNameSet(names);
const engine = await createOcr();
let total = 0;
for (const d of readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory()))
  for (const f of readdirSync(join(out, d.name))) {
    const p = join(out, d.name, f);
    if (f.endsWith(".pdf")) {
      const g = await leakCheckPdf(readFileSync(p), { ns, io: nodeIO, ocr: async () => engine.recognize });
      if (g.leaks) console.log("LEAK", f.replace(/\(.*\)/, ""), g.where.join(","));
      total += g.leaks;
    } else if (/\.(jpg|png)$/i.test(f) && !/^FLIR/.test(f)) {
      const bmp = await nodeIO.decode(readFileSync(p));
      const lines = withoutBlackWords(await ocrBitmap(bmp, nodeIO, engine.recognize), bmp);
      const n = lines.filter((l) => strictLeaks(l.text, ns).length).length;
      if (n) console.log("LEAK", f, n);
      total += n;
    }
  }
console.log("TOTAL", total);
await engine.terminate();
