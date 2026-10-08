import JSZip from "jszip";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { buildNameSet } from "../src/names";
import { anonymizeOffice, leakCheckOffice, officeParagraphs } from "../src/process/docx";
import { anonymizePdf, leakCheckPdf, pdfTextLines } from "../src/process/pdf";
import { processFile } from "../src/pipeline";

const ns = buildNameSet(["Jane Smithson"]);

async function makeDocx(): Promise<Uint8Array> {
  const z = new JSZip();
  z.file(
    "word/document.xml",
    `<w:document><w:body>
<w:p><w:r><w:t>Name: Ra</w:t></w:r><w:r><w:t>na SARB</w:t></w:r><w:r><w:t>AJI</w:t></w:r></w:p>
<w:p><w:r><w:t>Date of birth: 10/02/1987</w:t></w:r></w:p>
<w:p><w:r><w:t>Phone:</w:t></w:r></w:p><w:p><w:r><w:t>0049123456789</w:t></w:r></w:p>
<w:p><w:r><w:t>Diagnosis: Endometriosis &amp; radiculopathy, K.Brownn seen</w:t></w:r></w:p>
</w:body></w:document>`,
  );
  z.file("docProps/core.xml", `<cp:coreProperties><dc:creator>Dr Jane Smithson</dc:creator><cp:lastModifiedBy>Someone</cp:lastModifiedBy></cp:coreProperties>`);
  return z.generateAsync({ type: "uint8array" });
}

describe("docx", () => {
  it("redacts across split runs, keeps clinical text, wipes properties", async () => {
    const { bytes } = await anonymizeOffice(await makeDocx(), buildNameSet(["Jane Smithson", "Kim Brown"]));
    const { body, props } = await officeParagraphs(bytes);
    const all = body.join("\n");
    expect(all).not.toMatch(/Jane|SMITHSAN|1987|0049123456789|Brownn/i);
    expect(all).toContain("Endometriosis & radiculopathy");
    expect(props.join(" ")).not.toMatch(/Jane|Smithson|Someone/);
    expect(await leakCheckOffice(bytes, buildNameSet(["Jane Smithson", "Kim Brown"]))).toBe(0);
  });
  it("gate flags an unredacted file", async () => {
    expect(await leakCheckOffice(await makeDocx(), ns)).toBeGreaterThan(0);
  });
});

function makePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const lines = ["Name: Jane Smithson   Sex: F", "Date of birth: 10/02/1987", "Tel 0049123456789 mail info@clinic.org", "Diagnosis: Endometriosis with radiculopathy, age 44."];
  const content = "BT /F1 12 Tf 14 TL 50 780 Td " + lines.map((l) => `(${l}) Tj T*`).join(" ") + " ET";
  const page = doc.addPage([0, 0, 595, 842], 0, doc.newDictionary(), content);
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", font);
  res.put("Font", fonts);
  page.put("Resources", res);
  doc.insertPage(-1, page);
  doc.setMetaData("info:Author", "Jane Smithson");
  return doc.saveToBuffer("").asUint8Array().slice();
}

describe("pdf (mupdf)", () => {
  it("truly removes PII text, keeps clinical text, wipes metadata", async () => {
    const input = makePdf();
    expect(pdfTextLines(input).join(" ")).toContain("Smithson");
    const { bytes } = await anonymizePdf(input, { ns });
    const text = pdfTextLines(bytes).join("\n");
    expect(text).not.toMatch(/Jane|Smithson|1987|0049123456789|clinic\.org/i);
    expect(text).toContain("Endometriosis with radiculopathy, age 44.");
    expect(text).toContain("Sex: F");
    const g = await leakCheckPdf(bytes, { ns });
    expect(g).toEqual({ leaks: 0, metadata: false, where: [] });
    expect(Buffer.from(bytes).toString("latin1")).not.toMatch(/Smithson/i);
  });
  it("gate flags an unredacted file", async () => {
    expect((await leakCheckPdf(makePdf(), { ns })).leaks).toBeGreaterThan(0);
  });
});

describe("pipeline", () => {
  it("drops junk, skips unknown, passes video through after scan, blocks on name in bytes", async () => {
    const ctx = { ns, id: "MC-TEST22" };
    expect((await processFile("Thumbs.db", new Blob([]), ctx)).status).toBe("dropped");
    expect((await processFile("a.xyz", new Blob([]), ctx)).status).toBe("skipped");
    const clean = await processFile("clip R.Smithson.mp4", new Blob([new Uint8Array(1000)]), ctx);
    expect(clean.status).toBe("ok");
    expect(clean.outName).toBe("clip MC-TEST22.mp4");
    expect(clean.actions.join(" ")).toContain("not content-anonymized");
    const dirty = await processFile("clip.mov", new Blob([new TextEncoder().encode("xx Smithson xx")]), ctx);
    expect(dirty.status).toBe("blocked");
  });
});
