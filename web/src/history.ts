// Patients already sent from this browser: name <-> ID plus counts. Stored only in this browser's
// localStorage on the doctor's PC; never uploaded. Exportable as CSV as a backup.
import { parseCsv, toCsv, type KeyRow } from "./key";

export interface HistoryRow extends KeyRow {
  /** ISO time of the last run that included this patient. */
  last: string;
  /** Files sent in that run (uploaded or already on Drive). */
  sent: number;
  /** Files blocked / skipped / failed in that run. */
  problems: number;
  /** "incomplete": the run started but did not finish (tab closed, error). */
  status: "done" | "incomplete" | "imported";
}

const STORE = "mammocheck.history.v1";
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function loadHistory(): HistoryRow[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === "string" && typeof r.name === "string") : [];
  } catch {
    return [];
  }
}

/** false if the browser refused (private window, storage disabled): the page then warns. */
export function saveHistory(rows: HistoryRow[]): boolean {
  try {
    localStorage.setItem(STORE, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

export function upsert(rows: HistoryRow[], row: HistoryRow): HistoryRow[] {
  return [row, ...rows.filter((r) => r.id !== row.id)];
}

/** Previous entry for a folder: same folder name or same patient name (case/spacing ignored). */
export function findPrevious(rows: HistoryRow[], folder: string): HistoryRow | undefined {
  const k = norm(folder);
  return rows.find((r) => norm(r.folder) === k || norm(r.name) === k);
}

export function historyCsv(rows: HistoryRow[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const head = toCsv([]).trimEnd() + ",last_upload,files_sent,files_not_sent,status";
  return [head, ...rows.map((r) => [q(r.name), q(r.id), q(r.folder), r.last, r.sent, r.problems, r.status].join(","))].join("\n") + "\n";
}

/** Merge an exported list (or an old key CSV) into the history; existing IDs win. */
export function importCsv(rows: HistoryRow[], text: string): HistoryRow[] {
  const known = new Set(rows.map((r) => r.id));
  const extra = parseCsv(text)
    .filter((r) => !known.has(r.id))
    .map((r): HistoryRow => ({ ...r, last: "", sent: 0, problems: 0, status: "imported" }));
  return [...rows, ...extra];
}
