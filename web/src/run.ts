// Orchestrates a whole run: harvest names, process files in workers, upload (or zip), build manifests.
import JSZip from "jszip";
import { rewriteText, buildNameSet } from "./names";
import { classify } from "./scan";
import { mimeFor, type FileResult } from "./pipeline";
import type { Uploader } from "./upload";
import type { WorkerReq } from "./worker";

export interface RunFile {
  relPath: string;
  file: File;
}
export interface RunPatient {
  folder: string;
  name: string;
  /** Extra terms, one per line or comma separated. */
  extra: string;
  id: string;
  files: RunFile[];
}

export interface ManifestEntry {
  path: string;
  status: "uploaded" | "exists" | "blocked" | "skipped" | "failed";
  kind: string;
  actions: string[];
  reason?: string;
}
export interface PatientReport {
  id: string;
  folder: string;
  entries: ManifestEntry[];
  dropped: number;
}

export type Sink = { kind: "upload"; uploader: Uploader } | { kind: "zip"; zip: JSZip };

type Dist<T> = T extends unknown ? Omit<T, "reqId"> : never;

class Pool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private waiters: ((w: Worker) => void)[] = [];
  private pending = new Map<number, { resolve: (d: any) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private failure: Error | undefined;
  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        if (e.data?.ready) return this.release(w); // worker finished loading: now it can take jobs
        const p = this.pending.get(e.data.reqId);
        if (!p) return;
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data);
      };
      w.onerror = (e) => {
        // a load failure (e.g. wasm blocked) would otherwise leave the run waiting forever
        this.failure = new Error(`processing worker failed: ${e.message || "could not load"}`);
        for (const p of this.pending.values()) p.reject(this.failure);
        for (const next of this.waiters.splice(0)) next(w);
      };
      this.workers.push(w);
    }
  }
  private release(w: Worker) {
    const next = this.waiters.shift();
    if (next) next(w);
    else this.idle.push(w);
  }
  private take(): Promise<Worker> {
    const w = this.idle.pop();
    return w ? Promise.resolve(w) : new Promise((r) => this.waiters.push(r));
  }
  async call(msg: Dist<WorkerReq>): Promise<any> {
    const w = await this.take();
    if (this.failure) throw this.failure;
    const reqId = ++this.seq;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(reqId, { resolve, reject });
        w.postMessage({ ...msg, reqId });
      });
    } finally {
      this.pending.delete(reqId);
      this.release(w);
    }
  }
  close() {
    this.workers.forEach((w) => w.terminate());
  }
}

export interface Progress {
  (e: { patient: string; file: string; state: string; done: number; total: number; pct?: number; result?: string }): void;
}

export const splitExtra = (s: string) => s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export async function runAll(patients: RunPatient[], sink: Sink, onProgress: Progress, concurrency = 3): Promise<PatientReport[]> {
  const pool = new Pool(concurrency);
  const total = patients.reduce((n, p) => n + p.files.length, 0);
  let done = 0;
  const reports: PatientReport[] = [];
  try {
    for (const p of patients) {
      const baseNames = [p.name, ...splitExtra(p.extra)];
      // 1. harvest extra name spellings from Name: fields
      const textFiles = p.files.filter((f) => ["docx", "pdf", "text"].includes(classify(f.file.name)));
      onProgress({ patient: p.id, file: "", state: "harvesting", done, total });
      const harvested = new Set<string>();
      await mapLimit(textFiles, concurrency, async (f) => {
        for (const n of (await pool.call({ type: "harvest", name: f.file.name, file: f.file, names: baseNames })).names as string[]) harvested.add(n);
      });
      const names = [...baseNames, ...harvested];
      const ns = buildNameSet(names);

      // 2. plan output paths (names -> ID), creating the Drive folders up front, one after another
      const used = new Set<string>();
      const plan = p.files.map((f) => {
        const dirs = f.relPath.split("/").slice(0, -1).map((d) => rewriteText(d, ns, p.id));
        return { f, dirs };
      });
      if (sink.kind === "upload") {
        await sink.uploader.ensureTree([[p.id], ...plan.filter((x) => classify(x.f.file.name) !== "junk").map((x) => [p.id, ...x.dirs])]);
      }

      const report: PatientReport = { id: p.id, folder: p.folder, entries: [], dropped: 0 };
      const put = async (dirs: string[], name: string, data: Blob, onSent?: (sent: number) => void) => {
        if (sink.kind === "zip") {
          sink.zip.file([p.id, ...dirs, name].join("/"), data);
          return "uploaded" as const;
        }
        return sink.uploader.upload([p.id, ...dirs], name, mimeFor(name), data, onSent);
      };

      // 3. process + upload each file
      await mapLimit(plan, concurrency, async ({ f, dirs }) => {
        const label = f.relPath.split("/").pop()!;
        const tell = (state: string, extra: { pct?: number; result?: string } = {}) =>
          onProgress({ patient: p.id, file: classify(label) === "junk" ? "(junk)" : rewriteText(label, ns, p.id), state, done, total, ...extra });
        tell("processing");
        let r: FileResult;
        try {
          r = (await pool.call({ type: "process", name: f.file.name, file: f.file, names, id: p.id })).result;
        } catch (e) {
          r = { status: "blocked", kind: classify(label), outName: rewriteText(label, ns, p.id), actions: [], reason: `error: ${(e as Error).message}` };
        }
        let outName = r.outName;
        for (let n = 2; used.has([...dirs, outName].join("/").toLowerCase()); n++) outName = r.outName.replace(/(\.[^.]*)?$/, ` (${n})$1`);
        used.add([...dirs, outName].join("/").toLowerCase());
        const path = [...dirs, outName].join("/");
        let result: string;
        if (r.status === "dropped") {
          report.dropped++;
          result = "dropped";
        } else if (r.status === "ok" && r.data) {
          const blob = r.data instanceof Blob ? r.data : new Blob([r.data as BlobPart]);
          tell("uploading", { pct: 0 });
          try {
            const res = await put(dirs, outName, blob, (sent) => tell("uploading", { pct: Math.round((100 * sent) / Math.max(1, blob.size)) }));
            report.entries.push({ path, status: res, kind: r.kind, actions: r.actions });
            result = res;
          } catch (e) {
            report.entries.push({ path, status: "failed", kind: r.kind, actions: r.actions, reason: (e as Error).message });
            result = "failed";
          }
        } else {
          result = r.status === "blocked" ? "blocked" : "skipped";
          report.entries.push({ path, status: result as "blocked" | "skipped", kind: r.kind, actions: r.actions, reason: r.reason });
        }
        done++;
        tell("done", { result });
      });

      // 4. manifest (no names: all paths are already rewritten)
      report.entries.sort((a, b) => a.path.localeCompare(b.path));
      const manifest = {
        id: p.id,
        generated: new Date().toISOString(),
        dropped_junk_files: report.dropped,
        files: report.entries,
      };
      await put([], "manifest.json", new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" })).catch((e) => {
        report.entries.push({ path: "manifest.json", status: "failed", kind: "manifest", actions: [], reason: (e as Error).message });
      });
      reports.push(report);
    }
  } finally {
    pool.close();
  }
  return reports;
}
