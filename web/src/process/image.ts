// Image anonymization: OCR -> black boxes -> re-encode (drops EXIF/GPS). No DOM: codec is injected.
import { findLabels, strictLeaks, type NameSet } from "../names";
import { groupRows, type Box, type Ocr, type OcrLine, type OcrWord } from "./ocr";

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA */
  data: Uint8ClampedArray;
}
export interface ImageIO {
  decode(bytes: Uint8Array): Promise<Bitmap>;
  encode(b: Bitmap, format: "png" | "jpeg"): Promise<Uint8Array>;
}

const OCR_MAX_DIM = 3000;

function downscale(b: Bitmap, factor: number): Bitmap {
  const w = Math.max(1, Math.round(b.width / factor));
  const h = Math.max(1, Math.round(b.height / factor));
  const data = new Uint8ClampedArray(w * h * 4);
  const step = Math.max(1, Math.ceil(factor));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x * factor);
      const sy = Math.floor(y * factor);
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let dy = 0; dy < step && sy + dy < b.height; dy++)
        for (let dx = 0; dx < step && sx + dx < b.width; dx++) {
          const i = ((sy + dy) * b.width + sx + dx) * 4;
          acc[0] += b.data[i]; acc[1] += b.data[i + 1]; acc[2] += b.data[i + 2]; acc[3] += b.data[i + 3];
          n++;
        }
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) data[o + k] = acc[k] / n;
    }
  return { width: w, height: h, data };
}

const STRIP_H = 800;
const STRIP_OVERLAP = 120;

function cropRows(b: Bitmap, y0: number, y1: number): Bitmap {
  return { width: b.width, height: y1 - y0, data: b.data.slice(y0 * b.width * 4, y1 * b.width * 4) };
}

/**
 * OCR a bitmap; coordinates are returned in the bitmap's own pixel space. Tall images are read in overlapping
 * horizontal strips: on a whole photographed page tesseract's layout analysis can drop entire header blocks
 * (patient name, DOB) that it reads fine once the page is cut into strips.
 */
export async function ocrBitmap(b: Bitmap, io: ImageIO, ocr: Ocr): Promise<OcrLine[]> {
  const factor = Math.max(b.width, b.height) / OCR_MAX_DIM;
  const src = factor > 1 ? downscale(b, factor) : b;
  const s = factor > 1 ? factor : 1;
  const words: OcrWord[] = [];
  for (let y = 0; ; y += STRIP_H - STRIP_OVERLAP) {
    const y1 = Math.min(src.height, y + STRIP_H);
    const part = y === 0 && y1 === src.height ? src : cropRows(src, y, y1);
    for (const l of await ocr(await io.encode(part, "png")))
      for (const w of l.words) words.push({ text: w.text, x0: w.x0 * s, x1: w.x1 * s, y0: (w.y0 + y) * s, y1: (w.y1 + y) * s });
    if (y1 === src.height) break;
  }
  return groupRows(words); // also drops the duplicate words read twice in the overlaps
}

const union = (bs: Box[]): Box => ({
  x0: Math.min(...bs.map((b) => b.x0)),
  y0: Math.min(...bs.map((b) => b.y0)),
  x1: Math.max(...bs.map((b) => b.x1)),
  y1: Math.max(...bs.map((b) => b.y1)),
});

/**
 * Boxes to black out: name/contact hits (word-precise) and label values. A label's value is the run of words
 * right after it (until a large gap or the next label); when the value is blank or handwritten (OCR can't read it)
 * the empty space up to the next word / right edge is covered.
 */
export function boxesFromOcr(lines: OcrLine[], ns: NameSet, imageWidth: number, withLabels = true): Box[] {
  const boxes: Box[] = [];
  for (const line of lines) {
    const offs: [number, number][] = [];
    let pos = 0;
    for (const w of line.words) { offs.push([pos, pos + w.text.length]); pos += w.text.length + 1; }
    const wordsIn = (a: number, b: number) => line.words.filter((_, i) => offs[i][0] < b && offs[i][1] > a);
    const h = line.y1 - line.y0;
    const padX = Math.max(3, h * 0.2);
    const padY = Math.max(2, h * 0.15);
    for (const hit of strictLeaks(line.text, ns)) {
      const ws = wordsIn(hit.start, hit.end);
      if (ws.length === 0) continue;
      const u = union(ws);
      // the words' own vertical extent (rows can be skewed in photos); fall back to the row if a word box is oversized
      const tall = u.y1 - u.y0 > 2.2 * h;
      boxes.push({ x0: u.x0 - padX, y0: (tall ? line.y0 : u.y0) - padY, x1: u.x1 + padX, y1: (tall ? line.y1 : u.y1) + padY });
    }
    const labels = withLabels ? findLabels(line.text, true) : [];
    labels.forEach((l, i) => {
      const lw = wordsIn(l.start, l.end);
      if (lw.length === 0) return;
      const lastLabel = lw[lw.length - 1];
      let j = line.words.indexOf(lastLabel) + 1;
      const nextLabelWord = labels[i + 1] ? wordsIn(labels[i + 1].start, labels[i + 1].end)[0] : undefined;
      const stop = nextLabelWord ? line.words.indexOf(nextLabelWord) : line.words.length;
      const x0 = lastLabel.x1 + 2;
      let prev = lastLabel.x1;
      const start = j;
      while (j < stop && line.words[j].x0 - prev <= 6 * h) prev = line.words[j++].x1;
      let x1: number;
      if (j > start) x1 = prev + padX;
      else x1 = j < stop ? line.words[j].x0 - 3 : nextLabelWord ? nextLabelWord.x0 - 3 : imageWidth * 0.98;
      const lu = union(lw);
      const lh = Math.min(lu.y1 - lu.y0, 1.6 * h);
      const cy = (lu.y0 + lu.y1) / 2;
      let y0 = cy - lh * 0.95;
      let y1 = cy + lh * 0.95;
      // tilted photos: value words drift above/below the label, so cover their own extent too (unless oversized)
      for (const w of line.words.slice(start, j)) {
        if (w.y1 - w.y0 > 2.2 * h) continue;
        y0 = Math.min(y0, w.y0 - padY);
        y1 = Math.max(y1, w.y1 + padY);
      }
      if (x1 > x0) boxes.push({ x0, y0, x1, y1 });
    });
  }
  return boxes;
}

/** Gate helper: OCR rows without words that sit on black (redaction boxes are read as digit garbage). */
export function withoutBlackWords(lines: OcrLine[], b: Bitmap): OcrLine[] {
  const dark = (w: Box) => {
    const x0 = Math.max(0, Math.floor(w.x0)), x1 = Math.min(b.width, Math.ceil(w.x1));
    const y0 = Math.max(0, Math.floor(w.y0)), y1 = Math.min(b.height, Math.ceil(w.y1));
    let darkPx = 0, n = 0;
    for (let y = y0; y < y1; y += 2)
      for (let x = x0; x < x1; x += 2) {
        const i = (y * b.width + x) * 4;
        if (b.data[i] + b.data[i + 1] + b.data[i + 2] < 150) darkPx++;
        n++;
      }
    return n > 0 && darkPx / n > 0.5; // mostly black: a redaction box
  };
  return lines.map((l) => {
    // also drop boxes far wider than their text (OCR stretching a "word" over a box plus table border)
    const stretched = (w: OcrLine["words"][number]) => w.x1 - w.x0 > 2.5 * (w.y1 - w.y0) * Math.max(1, w.text.length);
    const words = l.words.filter((w) => !dark(w) && !stretched(w));
    return { ...l, words, text: words.map((w) => w.text).join(" ") };
  });
}

export function paintBoxes(b: Bitmap, boxes: Box[]): void {
  for (const bx of boxes) {
    const x0 = Math.max(0, Math.floor(bx.x0));
    const x1 = Math.min(b.width, Math.ceil(bx.x1));
    const y0 = Math.max(0, Math.floor(bx.y0));
    const y1 = Math.min(b.height, Math.ceil(bx.y1));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * b.width + x) * 4;
        b.data[i] = 0; b.data[i + 1] = 0; b.data[i + 2] = 0; b.data[i + 3] = 255;
      }
  }
}

export interface ImageResult {
  bytes: Uint8Array;
  ext: string;
  boxes: number;
  /** Leaks found when re-OCRing the output (0 = pass). */
  leaks: number;
}

const MAX_ROUNDS = 3;

/**
 * OCR -> paint boxes, repeated on the painted bitmap until a round finds nothing (OCR misses text in one
 * pass that it reads in the next). The last, empty round is the leak gate; `leaks` > 0 if it never converged.
 */
export async function anonymizeImage(bytes: Uint8Array, ext: string, ns: NameSet, io: ImageIO, ocr: Ocr): Promise<ImageResult> {
  const bmp = await io.decode(bytes);
  let boxes = 0;
  let leaks = 1;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const lines = withoutBlackWords(await ocrBitmap(bmp, io, ocr), bmp);
    const found = boxesFromOcr(lines, ns, bmp.width, round === 0); // label rows only once; later rounds are the leak check
    if (found.length === 0) {
      leaks = 0;
      break;
    }
    paintBoxes(bmp, found);
    boxes += found.length;
    leaks = lines.filter((l) => strictLeaks(l.text, ns).length > 0).length; // unresolved only if the next round still finds some
  }
  const png = ext === "png";
  return { bytes: await io.encode(bmp, png ? "png" : "jpeg"), ext: png ? "png" : "jpg", boxes, leaks };
}
