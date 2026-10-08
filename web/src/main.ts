import JSZip from "jszip";
import { assignIds, toCsv } from "./key";
import { detectPatients, classify } from "./scan";
import { runAll, type PatientReport, type RunPatient } from "./run";
import { Uploader } from "./upload";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const zipMode = params.get("zip") === "1";
const uploadKey = new URLSearchParams(location.hash.slice(1)).get("k") ?? "";
const workerUrl = import.meta.env.VITE_WORKER_URL ?? "";

let patients: RunPatient[] = [];
let lastZip: Blob | null = null;
/** Every patient sent in this browser session: the key file always lists all of them. */
const sessionKey: { name: string; id: string; folder: string }[] = [];

// ---- mode banner ----
const banner = $("mode");
if (zipMode) {
  banner.hidden = false;
  banner.textContent = "Test mode (?zip=1): results are downloaded as a ZIP and nothing is uploaded.";
} else if (!workerUrl || !uploadKey) {
  banner.hidden = false;
  banner.textContent = !workerUrl
    ? "This build has no upload server configured (VITE_WORKER_URL)."
    : "The upload key is missing from the link (the part after #k=). Ask for a new link.";
  $<HTMLButtonElement>("go").disabled = true;
}

// ---- folder selection ----
async function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) return all;
    all.push(...batch);
  }
}
async function walk(entry: FileSystemEntry, prefix: string, out: { path: string; file: File }[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    for (const e of await readEntries(entry as FileSystemDirectoryEntry)) await walk(e, prefix + entry.name + "/", out);
  }
}

function setFiles(list: { path: string; file: File }[]) {
  const found = detectPatients(list);
  const ids = assignIds(found.map((p) => p.name), []);
  patients = found.map((p) => ({
    folder: p.name,
    name: p.name,
    extra: "",
    id: ids.get(p.name)!,
    files: p.files.map((f) => ({ relPath: f.relPath, file: f.file })),
  }));
  renderPatients();
}

$<HTMLInputElement>("pick").addEventListener("change", (e) => {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  setFiles(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
});

const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const items = Array.from(e.dataTransfer?.items ?? []).map((i) => i.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
  const out: { path: string; file: File }[] = [];
  for (const it of items) await walk(it, "", out);
  // a single dropped folder behaves like selecting it; several dropped folders are wrapped in a virtual root
  setFiles(items.length === 1 ? out : out.map((o) => ({ ...o, path: "Selected/" + o.path })));
});

function renderPatients() {
  $("step-patients").hidden = patients.length === 0;
  const body = $("patients");
  body.replaceChildren();
  patients.forEach((p) => {
    const tr = document.createElement("tr");
    const cell = (child: Node, cls = "") => {
      const td = document.createElement("td");
      td.className = cls;
      td.append(child);
      tr.append(td);
    };
    const name = Object.assign(document.createElement("input"), { type: "text", value: p.name });
    name.addEventListener("input", () => (p.name = name.value));
    const extra = Object.assign(document.createElement("input"), { type: "text", value: p.extra, placeholder: "optional, comma separated" });
    extra.addEventListener("input", () => (p.extra = extra.value));
    cell(name);
    cell(extra);
    cell(document.createTextNode(p.id), "id");
    cell(document.createTextNode(String(p.files.filter((f) => classify(f.file.name) !== "junk").length)));
    body.append(tr);
  });
}

// ---- run ----
function download(blob: Blob, name: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const keyCsv = () => new Blob([toCsv(sessionKey)], { type: "text/csv" });
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");

$("go").addEventListener("click", async () => {
  $("step-pick").hidden = true;
  $("step-patients").hidden = true;
  $("step-progress").hidden = false;
  for (const p of patients) sessionKey.push({ name: p.name, id: p.id, folder: p.folder });
  download(keyCsv(), `mammocheck-key-${stamp()}.csv`); // save the key before anything else happens
  const bar = $<HTMLProgressElement>("bar");
  const log = $("log");
  log.replaceChildren();
  $("active").replaceChildren();
  bar.value = 0;
  const active = new Map<string, HTMLElement>();
  const zip = new JSZip();
  let reports: PatientReport[];
  try {
    reports = await runAll(
      patients,
      zipMode ? { kind: "zip", zip } : { kind: "upload", uploader: new Uploader(workerUrl, uploadKey) },
      (e) => {
        bar.max = Math.max(1, e.total);
        bar.value = e.done;
        if (e.state === "harvesting") {
          $("status").textContent = `${e.done} / ${e.total} files — ${e.patient}: reading documents for name spellings…`;
          return;
        }
        $("status").textContent = `${e.done} / ${e.total} files — ${e.patient}`;
        const key = `${e.patient}/${e.file}`;
        let row = active.get(key);
        if (e.state === "done") {
          row?.remove();
          active.delete(key);
          if (e.result === "dropped") return; // junk (Thumbs.db etc.): not worth listing
          const li = document.createElement("li");
          const mark: Record<string, string> = { uploaded: "✓ uploaded", exists: "✓ already on Drive", blocked: "⚠ blocked", skipped: "– skipped", failed: "✗ failed" };
          li.textContent = `${mark[e.result ?? ""] ?? e.result}  ${e.patient}  ${e.file}`;
          if (e.result === "blocked" || e.result === "failed") li.className = "bad";
          else if (e.result === "skipped") li.className = "warn";
          log.prepend(li);
          return;
        }
        if (!row) {
          row = document.createElement("li");
          $("active").append(row);
          active.set(key, row);
        }
        const what = e.state === "uploading" ? `${zipMode ? "adding to ZIP" : "uploading"} ${e.pct ?? 0}%` : "anonymizing…";
        row.textContent = `${e.patient}  ${e.file}  — ${what}`;
      },
    );
  } catch (e) {
    $("status").textContent = `Stopped: ${(e as Error).message}`;
    return;
  }
  if (zipMode) lastZip = await zip.generateAsync({ type: "blob" });
  showReport(reports);
});

const STATUS_TEXT: Record<string, string> = {
  uploaded: zipMode ? "✓ zipped" : "✓ uploaded",
  exists: "✓ already on Drive",
  blocked: "⚠ blocked",
  skipped: "– skipped",
  failed: "✗ failed",
};

function showReport(reports: PatientReport[]) {
  $("step-progress").hidden = true;
  $("step-report").hidden = false;
  $("dlkey").onclick = () => download(keyCsv(), `mammocheck-key-${stamp()}.csv`);
  const dz = $("dlzip");
  dz.hidden = !zipMode;
  dz.onclick = () => lastZip && download(lastZip, `mammocheck-anonymized-${stamp()}.zip`);
  const root = $("report");
  const batch = document.createElement("div");
  for (const r of reports) {
    const ok = (e: { status: string }) => e.status === "uploaded" || e.status === "exists";
    const sent = r.entries.filter(ok).length;
    const bad = r.entries.filter((e) => !ok(e));
    const d = document.createElement("details");
    d.open = bad.length > 0;
    const sum = document.createElement("summary");
    sum.innerHTML = `<strong></strong> &mdash; <span class="ok"></span>${bad.length ? ' <span class="bad"></span>' : ""}`;
    sum.querySelector("strong")!.textContent = `${r.folder} (${r.id})`;
    sum.querySelector(".ok")!.textContent = `${sent} ${zipMode ? "zipped" : "uploaded"}`;
    if (bad.length) sum.querySelector(".bad")!.textContent = `${bad.length} not uploaded`;
    d.append(sum);
    const ul = document.createElement("ul");
    ul.className = "rep";
    // problems first, then everything that went through; junk files (Thumbs.db etc.) are only counted
    for (const e of [...bad, ...r.entries.filter(ok)]) {
      const li = document.createElement("li");
      if (!ok(e)) li.className = e.status === "skipped" ? "warn" : "bad";
      li.textContent = `${STATUS_TEXT[e.status] ?? e.status}  ${e.path}${e.reason ? " (" + e.reason + ")" : ""}`;
      ul.append(li);
    }
    if (r.dropped) {
      const li = document.createElement("li");
      li.textContent = `${r.dropped} system file(s) ignored (Thumbs.db, .DS_Store, …)`;
      ul.append(li);
    }
    d.append(ul);
    batch.append(d);
  }
  root.prepend(batch); // newest run on top, earlier runs stay listed
}

// ---- next batch ----
$("more").addEventListener("click", () => {
  patients = [];
  $<HTMLInputElement>("pick").value = "";
  $("step-patients").hidden = true;
  $("step-pick").hidden = false;
  $("step-pick").scrollIntoView({ behavior: "smooth" });
});
