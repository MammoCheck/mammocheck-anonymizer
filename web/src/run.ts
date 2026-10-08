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
  private pending = new Map<number, (d: any) => void>();
  private seq = 0;
  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => this.pending.get(e.data.reqId)?.(e.data);
      this.workers.push(w);
      this.idle.push(w);
    }
  }
  private take(): Promise<Worker> {
    const w = this.idle.pop();
    return w ? Promise.resolve(w) : new Promise((r) => this.waiters.push(r));
  }
  async call(msg: Dist<WorkerReq>): Promise<any> {
    const w = await this.take();
    const reqId = ++this.seq;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(reqId, resolve);
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage({ ...msg, reqId });
      });
    } finally {
      this.pending.delete(reqId);
      const next = this.waiters.shift();
      if (next) next(w);
      else this.idle.push(w);
    }
  }
  close() {
    this.workers.forEach((w) => w.terminate());
  }
}

export interface Progress {
  (e: { patient: string; file: string; state: string; done: number; total: number }): void;
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
      const put = async (dirs: string[], name: string, data: Blob) => {
        if (sink.kind === "zip") {
          sink.zip.file([p.id, ...dirs, name].join("/"), data);
          return "uploaded" as const;
        }
        return sink.uploader.upload([p.id, ...dirs], name, mimeFor(name), data);
      };

      // 3. process + upload each file
      await mapLimit(plan, concurrency, async ({ f, dirs }) => {
        const label = f.relPath.split("/").pop()!;
        const tell = (state: string) => onProgress({ patient: p.id, file: classify(label) === "junk" ? "(junk)" : rewriteText(label, ns, p.id), state, done, total });
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
        if (r.status === "dropped") report.dropped++;
        else if (r.status === "ok" && r.data) {
          tell("uploading");
          try {
            const res = await put(dirs, outName, r.data instanceof Blob ? r.data : new Blob([r.data as BlobPart]));
            report.entries.push({ path, status: res, kind: r.kind, actions: r.actions });
          } catch (e) {
            report.entries.push({ path, status: "failed", kind: r.kind, actions: r.actions, reason: (e as Error).message });
          }
        } else {
          report.entries.push({ path, status: r.status === "blocked" ? "blocked" : "skipped", kind: r.kind, actions: r.actions, reason: r.reason });
        }
        done++;
        tell("done");
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
