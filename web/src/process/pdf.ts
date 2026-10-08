// PDF anonymization with mupdf (WASM): real redaction (text removed from content, image pixels blacked out).
import * as mupdf from "mupdf";
import { BLANK_VALUE_RE, byteNeedles, detect, findLabels, findNameHits, leaks, strictLeaks, type NameSet } from "../names";
import { scanBlobForNeedles } from "./flir";
import { ocrBitmap, boxesFromOcr, withoutBlackWords, type Bitmap, type ImageIO } from "./image";
import type { Ocr } from "./ocr";

export interface PdfCtx {
  ns: NameSet;
  io?: ImageIO;
  ocr?: () => Promise<Ocr>;
}

type R = [number, number, number, number];
interface PLine {
  text: string;
  starts: number[]; // string offset of each char
  quads: mupdf.Quad[];
  bbox: R;
}

const quadsRect = (qs: mupdf.Quad[]): R => {
  const xs = qs.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = qs.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

function pageContent(page: mupdf.Page): { lines: PLine[]; chars: number; imageArea: number } {
  const st = page.toStructuredText("preserve-images");
  const lines: PLine[] = [];
  let cur: PLine | null = null;
  let chars = 0;
  let imageArea = 0;
  st.walk({
    beginLine(bbox) {
      cur = { text: "", starts: [], quads: [], bbox };
    },
    onChar(c, _o, _f, _s, quad) {
      if (!cur) return;
      cur.starts.push(cur.text.length);
      cur.text += c;
      cur.quads.push(quad);
      if (c.trim()) chars++;
    },
    endLine() {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = null;
    },
    onImageBlock(bbox) {
      imageArea += Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
    },
  });
  st.destroy();
  return { lines, chars, imageArea };
}

const pageArea = (page: mupdf.Page) => {
  const b = page.getBounds();
  return (b[2] - b[0]) * (b[3] - b[1]);
};

const needsOcr = (page: mupdf.Page, c: { chars: number; imageArea: number }) =>
  c.chars < 30 || c.imageArea / pageArea(page) > 0.35;

function rangeRect(line: PLine, a: number, b: number): R | null {
  const qs = line.quads.filter((_, i) => line.starts[i] >= a && line.starts[i] < b && line.text[line.starts[i]].trim());
  return qs.length ? quadsRect(qs) : null;
}

/**
 * mupdf removes every glyph that touches a redaction rect, and line boxes of neighbouring lines overlap,
 * so shrink text rects to the central band of the line (and a hair horizontally).
 */
const shrink = (r: R): R => {
  const h = r[3] - r[1];
  return [r[0] + 0.4, r[1] + 0.28 * h, r[2] - 0.4, r[3] - 0.28 * h];
};

function textRects(lines: PLine[], ns: NameSet): R[] {
  const rects: R[] = [];
  for (const line of lines) {
    for (const h of detect(line.text, ns)) {
      const r = rangeRect(line, h.start, h.end);
      if (r) rects.push(r);
    }
    // label with blank value -> the nearest text to its right on the same band (typed field, other cell)
    for (const l of findLabels(line.text)) {
      if (!BLANK_VALUE_RE.test(line.text.slice(l.valueStart, l.valueEnd))) continue;
      const lr = rangeRect(line, l.start, l.end);
      if (!lr) continue;
      const h = lr[3] - lr[1];
      let best: PLine | null = null;
      for (const o of lines) {
        if (o === line || findLabels(o.text).length) continue;
        const overlap = Math.min(lr[3], o.bbox[3]) - Math.max(lr[1], o.bbox[1]);
        if (overlap < 0.5 * Math.min(h, o.bbox[3] - o.bbox[1]) || o.bbox[0] < lr[2] - 2) continue;
        if (!best || o.bbox[0] < best.bbox[0]) best = o;
      }
      if (best && best.text.length < 80) rects.push(best.bbox);
    }
  }
  return rects;
}

function renderBitmap(page: mupdf.Page): { bmp: Bitmap; scale: number; origin: [number, number] } {
  const b = page.getBounds();
  const scale = Math.min(200 / 72, 3500 / Math.max(b[2] - b[0], b[3] - b[1]));
  const pm = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const w = pm.getWidth();
  const h = pm.getHeight();
  const n = pm.getNumberOfComponents();
  const stride = pm.getStride();
  const src = pm.getPixels();
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * n;
      const o = (y * w + x) * 4;
      data[o] = src[i]; data[o + 1] = src[i + 1]; data[o + 2] = src[i + 2]; data[o + 3] = 255;
    }
  pm.destroy();
  return { bmp: { width: w, height: h, data }, scale, origin: [b[0], b[1]] };
}

function openPdf(bytes: Uint8Array): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  if (!doc) throw new Error("not a PDF");
  if (doc.needsPassword() && !doc.authenticatePassword("")) throw new Error("encrypted PDF");
  return doc;
}

function wipeMetadata(doc: mupdf.PDFDocument) {
  const trailer = doc.getTrailer();
  trailer.delete("Info");
  const root = trailer.get("Root");
  for (const k of ["Metadata", "PieceInfo", "Outlines"]) root.delete(k); // XMP, app-private data, bookmarks (carry names)
}

function cleanWidgets(doc: mupdf.PDFDocument, ns: NameSet, notes: string[]) {
  let cleared = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    for (const w of doc.loadPage(i).getWidgets()) {
      if (w.isButton()) continue;
      const value = w.getValue();
      if (!value) continue;
      const prefix = (w.getName() || "") + ": ";
      if (detect(prefix + value, ns).some((h) => h.end > prefix.length)) {
        w.setTextValue("");
        cleared++;
      }
    }
  }
  if (cleared) notes.push(`${cleared} form field value(s) cleared`);
  try {
    doc.bake(false, true);
  } catch {
    /* no form */
  }
}

export async function anonymizePdf(bytes: Uint8Array, ctx: PdfCtx): Promise<{ bytes: Uint8Array; notes: string[]; ocrLeaks: number }> {
  const { ns } = ctx;
  const doc = openPdf(bytes);
  const notes: string[] = [];
  cleanWidgets(doc, ns, notes);
  let ocrPages = 0;
  let redactions = 0;
  let unverified = 0; // OCR lines still leaking after the last round
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    // drop annotations carrying names, clear annotation authors, drop mailto/name links
    for (const a of page.getAnnotations()) {
      const t = a.getType();
      if (t === "Link" || t === "Widget" || t === "Redact") continue;
      if (a.hasAuthor()) a.setAuthor("");
      if (detect(a.getContents() ?? "", ns).length) page.deleteAnnotation(a);
    }
    for (const l of page.getLinks()) if (detect(l.getURI(), ns).length) page.deleteLink(l);

    const content = pageContent(page);
    const rects: R[] = textRects(content.lines, ns).map(shrink);
    if (!needsOcr(page, content)) {
      for (const r of rects) page.createAnnotation("Redact").setRect(r);
      if (rects.length) page.applyRedactions(true);
      redactions += rects.length;
      continue;
    }
    // image page: OCR -> redact -> re-render and OCR again, until a round finds nothing. That last empty
    // round is this page's leak check, so the gate does not have to OCR it again.
    if (!ctx.io || !ctx.ocr) throw new Error("OCR required but not available");
    ocrPages++;
    let pending = 1;
    for (let round = 0; round < 3; round++) {
      const { bmp, scale, origin } = renderBitmap(page);
      const lines = withoutBlackWords(await ocrBitmap(bmp, ctx.io, await ctx.ocr()), bmp);
      const found = boxesFromOcr(lines, ns, bmp.width, round === 0); // label rows only once; later rounds are the check
      for (const b of found) rects.push([origin[0] + b.x0 / scale, origin[1] + b.y0 / scale, origin[0] + b.x1 / scale, origin[1] + b.y1 / scale]);
      if (rects.length === 0) {
        pending = 0;
        break;
      }
      for (const r of rects) page.createAnnotation("Redact").setRect(r);
      page.applyRedactions(true);
      redactions += rects.length;
      rects.length = 0;
      pending = lines.filter((l) => strictLeaks(l.text, ns).length > 0).length;
    }
    unverified += pending;
  }
  wipeMetadata(doc);
  const out = doc.saveToBuffer("garbage=compact,compress").asUint8Array();
  notes.push(`${redactions} redaction(s)`);
  if (ocrPages) notes.push(`${ocrPages} page(s) via OCR`);
  return { bytes: out.slice(), notes, ocrLeaks: unverified };
}

/** Plain text lines of a PDF text layer (harvesting / leak gate). */
export function pdfTextLines(bytes: Uint8Array): string[] {
  const doc = openPdf(bytes);
  const out: string[] = [];
  for (let i = 0; i < doc.countPages(); i++) for (const l of pageContent(doc.loadPage(i)).lines) out.push(l.text);
  return out;
}

/** Leak gate: number of leaking lines (text layer + OCR of image pages) and leftover metadata. */
export async function leakCheckPdf(bytes: Uint8Array, ctx: PdfCtx, opts: { skipOcr?: boolean } = {}): Promise<{ leaks: number; metadata: boolean; where: string[] }> {
  // raw bytes: catches names in uncompressed structure (bookmarks, field names, ...)
  const rawHit = await scanBlobForNeedles(new Blob([bytes as BlobPart]), byteNeedles(ctx.ns));
  const { ns } = ctx;
  const doc = openPdf(bytes);
  let count = 0;
  const where: string[] = []; // page + kind only, never the text itself
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const content = pageContent(page);
    for (const l of content.lines) for (const h of leaks(l.text, ns)) { count++; where.push(`p${i + 1} text ${h.kind}`); }
    if (!opts.skipOcr && needsOcr(page, content) && ctx.io && ctx.ocr) {
      const { bmp } = renderBitmap(page);
      const lines = withoutBlackWords(await ocrBitmap(bmp, ctx.io, await ctx.ocr()), bmp);
      for (const l of lines) for (const h of strictLeaks(l.text, ns)) { count++; where.push(`p${i + 1} ocr ${h.kind}`); }
    }
  }
  const t = doc.getTrailer();
  const metadata = !t.get("Info").isNull() || !t.get("Root", "Metadata").isNull() || findNameHits(String(doc.getMetaData("info:Author") ?? ""), ns).length > 0;
  if (rawHit) where.push("raw bytes");
  return { leaks: count + (rawHit ? 1 : 0), metadata, where };
}
