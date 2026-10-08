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
const keyCsv = () => new Blob([toCsv(patients.map((p) => ({ name: p.name, id: p.id, folder: p.folder })))], { type: "text/csv" });
const stamp = () => new Date().toISOString().slice(0, 10);

$("go").addEventListener("click", async () => {
  $("step-pick").hidden = true;
  $("step-patients").hidden = true;
  $("step-progress").hidden = false;
  download(keyCsv(), `mammocheck-key-${stamp()}.csv`); // save the key before anything else happens
  const bar = $<HTMLProgressElement>("bar");
  const log = $("log");
  const zip = new JSZip();
  let reports: PatientReport[];
  try {
    reports = await runAll(
      patients,
      zipMode ? { kind: "zip", zip } : { kind: "upload", uploader: new Uploader(workerUrl, uploadKey) },
      (e) => {
        bar.max = Math.max(1, e.total);
        bar.value = e.done;
        $("status").textContent = `${e.done} / ${e.total} files`;
        if (e.state === "done") {
          const li = document.createElement("li");
          li.textContent = `${e.patient}  ${e.file}`;
          log.prepend(li);
        }
      },
    );
  } catch (e) {
    $("status").textContent = `Stopped: ${(e as Error).message}`;
    return;
  }
  if (zipMode) lastZip = await zip.generateAsync({ type: "blob" });
  showReport(reports);
});

function showReport(reports: PatientReport[]) {
  $("step-progress").hidden = true;
  $("step-report").hidden = false;
  $("dlkey").onclick = () => download(keyCsv(), `mammocheck-key-${stamp()}.csv`);
  const dz = $("dlzip");
  dz.hidden = !zipMode;
  dz.onclick = () => lastZip && download(lastZip, `mammocheck-anonymized-${stamp()}.zip`);
  const root = $("report");
  root.replaceChildren();
  for (const r of reports) {
    const count = (s: string) => r.entries.filter((e) => e.status === s).length;
    const sent = count("uploaded") + count("exists");
    const bad = r.entries.filter((e) => !["uploaded", "exists"].includes(e.status));
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
    for (const e of bad) {
      const li = document.createElement("li");
      li.className = e.status === "skipped" ? "warn" : "bad";
      li.textContent = `${e.status.toUpperCase()}: ${e.path}${e.reason ? " (" + e.reason + ")" : ""}`;
      ul.append(li);
    }
    d.append(ul);
    root.append(d);
  }
}
