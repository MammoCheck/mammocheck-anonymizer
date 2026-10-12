import JSZip from "jszip";
import { assignIds } from "./key";
import { findPrevious, historyCsv, importCsv, loadHistory, saveHistory, upsert, type HistoryRow } from "./history";
import { detectPatients, classify } from "./scan";
import { runAll, type PatientReport, type RunPatient } from "./run";
import { Uploader } from "./upload";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const zipMode = params.get("zip") === "1";
const uploadKey = new URLSearchParams(location.hash.slice(1)).get("k") ?? "";
const workerUrl = import.meta.env.VITE_WORKER_URL ?? "";

type UiPatient = RunPatient & { include: boolean; previous?: HistoryRow };
let patients: UiPatient[] = [];
let lastZip: Blob | null = null;
// test runs (?zip=1) are not recorded: nothing reached Drive
const recordHistory = !zipMode;
let history = loadHistory();
void navigator.storage?.persist?.().catch(() => undefined); // ask the browser not to evict the list

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
  $("go").dataset.blocked = "1";
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
  // a patient sent before keeps its ID: a re-send lands in the same Drive folder and skips files already there
  const ids = assignIds(found.map((p) => p.name), history);
  patients = found.map((p) => {
    const previous = findPrevious(history, p.name);
    return {
      folder: p.name,
      name: previous?.name ?? p.name,
      extra: "",
      id: ids.get(p.name)!,
      files: p.files.map((f) => ({ relPath: f.relPath, file: f.file })),
      previous,
      include: !previous || previous.status === "incomplete", // already uploaded: unticked unless the doctor ticks it
    };
  });
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
    const inc = Object.assign(document.createElement("input"), { type: "checkbox", checked: p.include, title: "Include in this upload" });
    inc.addEventListener("change", () => {
      p.include = inc.checked;
      updateGo();
    });
    cell(inc);
    const nameCell = document.createElement("div");
    nameCell.append(name);
    if (p.previous) {
      const note = document.createElement("div");
      note.className = p.previous.status === "incomplete" ? "hint warn" : "hint";
      note.textContent =
        p.previous.status === "incomplete"
          ? `Previous upload did not finish (${fmtDate(p.previous.last)}): will continue`
          : p.previous.status === "imported"
            ? "In your imported list"
            : `Already uploaded ${fmtDate(p.previous.last)} (${p.previous.sent} files)`;
      nameCell.append(note);
    }
    cell(nameCell);
    cell(extra);
    cell(document.createTextNode(p.id), "id");
    cell(document.createTextNode(String(p.files.filter((f) => classify(f.file.name) !== "junk").length)));
    body.append(tr);
  });
  updateGo();
}

function updateGo() {
  const n = patients.filter((p) => p.include).length;
  const go = $<HTMLButtonElement>("go");
  go.textContent = n ? `Anonymize & upload ${n} patient${n > 1 ? "s" : ""}` : "Nothing selected";
  if (!go.dataset.blocked) go.disabled = n === 0;
}

// ---- history of patients sent from this browser ----
const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

function renderHistory() {
  const sec = $("history");
  sec.hidden = !recordHistory;
  const body = $("history-rows");
  body.replaceChildren();
  $("history-count").textContent = history.length ? `(${history.length})` : "";
  $("history-empty").hidden = history.length > 0;
  $("history-table").hidden = history.length === 0;
  const q = $<HTMLInputElement>("history-search").value.trim().toLowerCase();
  for (const r of history) {
    if (q && !`${r.name} ${r.id}`.toLowerCase().includes(q)) continue;
    const tr = document.createElement("tr");
    const status =
      r.status === "incomplete" ? "did not finish" : r.status === "imported" ? "imported" : r.problems ? `${r.problems} not sent` : "✓";
    for (const [text, cls] of [[r.name, ""], [r.id, "id"], [fmtDate(r.last), ""], [String(r.sent || ""), ""], [status, r.status === "incomplete" || r.problems ? "bad" : ""]]) {
      const td = document.createElement("td");
      td.textContent = text;
      td.className = cls;
      tr.append(td);
    }
    body.append(tr);
  }
}
function storeHistory(next: HistoryRow[]) {
  history = next;
  if (!saveHistory(history)) {
    const b = $("mode");
    b.hidden = false;
    b.textContent = "This browser does not allow saving the list of uploaded patients (private window?). Use Export list to keep a copy.";
  }
  renderHistory();
}
$("history-search").addEventListener("input", renderHistory);
$("history-export").addEventListener("click", () =>
  download(new Blob([historyCsv(history)], { type: "text/csv" }), `mammocheck-patients-${stamp()}.csv`),
);
$<HTMLInputElement>("history-import").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  storeHistory(importCsv(history, await f.text()));
  (e.target as HTMLInputElement).value = "";
});
renderHistory();

// ---- run ----
function download(blob: Blob, name: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");

$("go").addEventListener("click", async () => {
  const selected = patients.filter((p) => p.include);
  if (!selected.length) return;
  $("step-pick").hidden = true;
  $("step-patients").hidden = true;
  $("step-progress").hidden = false;
  // record before sending: if the tab is closed midway, the patient shows up as "did not finish" with the same ID
  const started = new Date().toISOString();
  if (recordHistory) {
    let next = history;
    for (const p of selected)
      next = upsert(next, { name: p.name, id: p.id, folder: p.folder, last: started, sent: 0, problems: 0, status: "incomplete" });
    storeHistory(next);
  }
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
      selected,
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
  if (recordHistory) {
    let next = history;
    for (const r of reports) {
      const p = selected.find((x) => x.id === r.id)!;
      const sent = r.entries.filter((e) => e.status === "uploaded" || e.status === "exists").length;
      next = upsert(next, { name: p.name, id: p.id, folder: p.folder, last: started, sent, problems: r.entries.length - sent, status: "done" });
    }
    storeHistory(next);
  }
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
