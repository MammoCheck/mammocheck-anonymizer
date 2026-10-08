// Thin tesseract.js wrapper. Works in browsers/Web Workers and in Node.
import { createWorker, type Worker } from "tesseract.js";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface OcrWord extends Box {
  text: string;
}
export interface OcrLine extends Box {
  text: string;
  words: OcrWord[];
}
export type Ocr = (png: Uint8Array) => Promise<OcrLine[]>;

export interface OcrEngine {
  recognize: Ocr;
  terminate(): Promise<void>;
}

// Two page-segmentation passes (automatic, sparse text): table borders in forms make a single pass miss text.
const PASSES = ["3", "12"];

async function words(worker: Worker, img: Buffer | Blob, psm: string): Promise<OcrWord[]> {
  await worker.setParameters({ tessedit_pageseg_mode: psm as never });
  const { data } = await worker.recognize(img, {}, { blocks: true });
  const out: OcrWord[] = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines) for (const w of l.words) if (w.text.trim()) out.push({ text: w.text.trim(), ...w.bbox });
  return out;
}

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
function overlapRatio(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? (w * h) / Math.min(area(a), area(b)) : 0;
}

/** Group words (from any pass) into visual rows: same text row => same line, whatever tesseract's own blocks say. */
export function groupRows(all: OcrWord[]): OcrLine[] {
  const ws = [...all].sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const rows: { cy: number; h: number; words: OcrWord[] }[] = [];
  for (const w of ws) {
    const cy = (w.y0 + w.y1) / 2;
    const h = w.y1 - w.y0;
    let row = rows.length ? rows[rows.length - 1] : undefined;
    if (!row || Math.abs(cy - row.cy) > 0.6 * Math.min(h, row.h)) rows.push((row = { cy, h, words: [] }));
    if (row.words.some((o) => overlapRatio(o, w) > 0.5)) continue; // same word seen in another pass
    row.words.push(w);
    const n = row.words.length;
    row.cy += (cy - row.cy) / n;
    row.h += (h - row.h) / n;
  }
  return rows
    .filter((r) => r.words.length)
    .map((r) => {
      const words = r.words.sort((a, b) => a.x0 - b.x0);
      // row height = median word height (a stray tall box, e.g. a table border read as "|", must not inflate it)
      const hs = words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
      const h = hs[Math.floor(hs.length / 2)];
      return {
        text: words.map((w) => w.text).join(" "),
        words,
        x0: Math.min(...words.map((w) => w.x0)),
        x1: Math.max(...words.map((w) => w.x1)),
        y0: r.cy - h / 2,
        y1: r.cy + h / 2,
      };
    });
}

export async function createOcr(): Promise<OcrEngine> {
  const worker = await createWorker("eng");
  return {
    async recognize(png) {
      const img = typeof Buffer !== "undefined" ? Buffer.from(png) : new Blob([png as BlobPart]);
      const all: OcrWord[] = [];
      for (const psm of PASSES) all.push(...(await words(worker, img, psm)));
      return groupRows(all);
    },
    async terminate() {
      await worker.terminate();
    },
  };
}
