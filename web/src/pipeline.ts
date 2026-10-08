// Per-file processing: choose the processor by type, run the leak gate. No DOM (codecs injected).
import { byteNeedles, harvestNames, leaks, redactString, rewriteFilename, type NameSet } from "./names";
import { classify, extOf, type FileKind } from "./scan";
import { anonymizeOffice, leakCheckOffice, officeParagraphs } from "./process/docx";
import { isFlirJpeg, scanBlobForNeedles } from "./process/flir";
import { anonymizeImage, type ImageIO } from "./process/image";
import type { Ocr } from "./process/ocr";
import { anonymizePdf, leakCheckPdf, pdfTextLines } from "./process/pdf";

export interface Ctx {
  ns: NameSet;
  id: string;
  io?: ImageIO;
  ocr?: () => Promise<Ocr>;
}

export type Status = "ok" | "blocked" | "skipped" | "dropped";

export interface FileResult {
  status: Status;
  kind: FileKind;
  /** Anonymized file name (no directory). */
  outName: string;
  data?: Uint8Array | Blob;
  actions: string[];
  reason?: string;
}

export const VIDEO_NOTE = "included, not content-anonymized (faces/voice may be present)";

const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain", csv: "text/csv", json: "application/json",
  mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo", m4v: "video/x-m4v",
  "3gp": "video/3gpp", mkv: "video/x-matroska", webm: "video/webm", wmv: "video/x-ms-wmv", mpg: "video/mpeg", mpeg: "video/mpeg",
};
export const mimeFor = (name: string) => MIME[extOf(name)] ?? "application/octet-stream";

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

export async function processFile(name: string, blob: Blob, ctx: Ctx): Promise<FileResult> {
  const kind = classify(name);
  const outName = rewriteFilename(name, ctx.ns, ctx.id);
  const res = (r: Partial<FileResult> & { status: Status }): FileResult => ({ kind, outName, actions: [], ...r });
  try {
    switch (kind) {
      case "junk":
        return res({ status: "dropped", reason: "junk file" });
      case "unknown":
        return res({ status: "skipped", reason: "unsupported file type" });
      case "video":
      case "image": {
        const passthrough = kind === "video" || (["jpg", "jpeg"].includes(extOf(name)) && (await isFlirJpeg(blob)));
        if (passthrough) {
          if (await scanBlobForNeedles(blob, byteNeedles(ctx.ns)))
            return res({ status: "blocked", reason: "name found in file bytes" });
          return res({
            status: "ok",
            data: blob,
            actions: kind === "video" ? ["passed through unchanged", VIDEO_NOTE] : ["FLIR: passed through unchanged (radiometric data kept)"],
          });
        }
        if (!ctx.io || !ctx.ocr) return res({ status: "skipped", reason: "OCR not available" });
        let r;
        try {
          r = await anonymizeImage(await bytesOf(blob), extOf(name), ctx.ns, ctx.io, await ctx.ocr());
        } catch (e) {
          return res({ status: "skipped", reason: `could not decode image: ${(e as Error).message}` });
        }
        const out = outName.replace(/\.[^.]+$/, "") + "." + r.ext;
        if (r.leaks) return res({ status: "blocked", outName: out, reason: `${r.leaks} OCR line(s) still contain a name or contact detail` });
        return res({ status: "ok", outName: out, data: r.bytes, actions: [`OCR, ${r.boxes} box(es) blacked out, re-encoded (metadata removed)`] });
      }
      case "pdf": {
        // redact, re-check, and redact again if the gate still finds something (OCR sees different text per pass)
        let bytes: Uint8Array = await bytesOf(blob);
        const notes: string[] = [];
        let g: { leaks: number; metadata: boolean; where?: string[] } = { leaks: 1, metadata: false };
        for (let round = 0; round < 3 && (g.leaks || g.metadata); round++) {
          const r = await anonymizePdf(bytes, ctx);
          bytes = r.bytes;
          notes.push(...r.notes);
          // image pages were already re-OCR'd page by page inside anonymizePdf; the gate checks text, metadata, raw bytes
          g = await leakCheckPdf(bytes, ctx, { skipOcr: true });
          if (r.ocrLeaks) {
            g.leaks += r.ocrLeaks;
            (g.where ??= []).push(`${r.ocrLeaks} OCR line(s)`);
            break; // another full pass would OCR the same pages the same way
          }
        }
        if (g.leaks || g.metadata) return res({ status: "blocked", reason: `leak gate: ${g.leaks} hit(s) [${(g.where ?? []).slice(0, 6).join(", ")}]${g.metadata ? ", metadata" : ""}` });
        return res({ status: "ok", data: bytes, actions: [...notes, "metadata removed"] });
      }
      case "docx":
      case "xlsx": {
        const { bytes, notes } = await anonymizeOffice(await bytesOf(blob), ctx.ns);
        const n = await leakCheckOffice(bytes, ctx.ns);
        if (n) return res({ status: "blocked", reason: `leak gate: ${n} paragraph(s)` });
        return res({ status: "ok", data: bytes, actions: ["text redacted", "properties wiped", ...notes] });
      }
      case "text": {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await bytesOf(blob));
        const out = text.split("\n").map((l) => redactString(l, ctx.ns)).join("\n");
        if (out.split("\n").some((l) => leaks(l, ctx.ns).length)) return res({ status: "blocked", reason: "leak gate" });
        return res({ status: "ok", data: new TextEncoder().encode(out), actions: ["text redacted"] });
      }
    }
  } catch (e) {
    return res({ status: "blocked", reason: `error: ${(e as Error).message}` });
  }
}

/** Names found in "Name:" fields of text-bearing files (only those sharing a token with the known name). */
export async function harvest(name: string, blob: Blob, ns: NameSet): Promise<string[]> {
  const kind = classify(name);
  try {
    let paras: string[] = [];
    if (kind === "docx") paras = (await officeParagraphs(await bytesOf(blob))).body;
    else if (kind === "pdf") paras = pdfTextLines(await bytesOf(blob));
    else if (kind === "text") paras = new TextDecoder().decode(await bytesOf(blob)).split("\n");
    return [...new Set(paras.flatMap((p) => harvestNames(p, ns)))];
  } catch {
    return [];
  }
}

