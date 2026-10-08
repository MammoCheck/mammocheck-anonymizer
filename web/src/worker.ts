// Web Worker: runs the processors off the main thread.
import { browserIO } from "./imageio";
import { buildNameSet } from "./names";
import { harvest, processFile } from "./pipeline";
import { createOcr, type OcrEngine } from "./process/ocr";

export type WorkerReq =
  | { reqId: number; type: "harvest"; name: string; file: Blob; names: string[] }
  | { reqId: number; type: "process"; name: string; file: Blob; names: string[]; id: string };

let engine: Promise<OcrEngine> | undefined;
const ocr = async () => (await (engine ??= createOcr())).recognize;

self.onmessage = async (ev: MessageEvent<WorkerReq>) => {
  const m = ev.data;
  try {
    const ns = buildNameSet(m.names);
    if (m.type === "harvest") {
      (self as unknown as Worker).postMessage({ reqId: m.reqId, names: await harvest(m.name, m.file, ns) });
    } else {
      const r = await processFile(m.name, m.file, { ns, id: m.id, io: browserIO, ocr });
      const transfer = r.data instanceof Uint8Array ? [r.data.buffer] : [];
      (self as unknown as Worker).postMessage({ reqId: m.reqId, result: r }, transfer);
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({ reqId: m.reqId, error: (e as Error)?.message ?? String(e) });
  }
};

// mupdf loads its wasm with top-level await, so this module finishes evaluating (and the handler above
// exists) only after that; the pool waits for this signal before sending work.
(self as unknown as Worker).postMessage({ ready: true });
