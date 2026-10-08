// Patient IDs and the local mapping key (CSV). Never uploaded.
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newId(existing: Set<string> = new Set()): string {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(6));
    const id = "MC-" + [...b].map((x) => B32[x % 32]).join("");
    if (!existing.has(id)) return id;
  }
}

export interface KeyRow {
  name: string;
  id: string;
  folder: string;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function toCsv(rows: KeyRow[]): string {
  return ["name,id,original_folder", ...rows.map((r) => [q(r.name), q(r.id), q(r.folder)].join(","))].join("\n") + "\n";
}

export function parseCsv(text: string): KeyRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows
    .slice(1)
    .filter((r) => /^MC-[A-Z0-9]{6}$/.test(r[1] ?? ""))
    .map((r) => ({ name: r[0], id: r[1], folder: r[2] ?? r[0] }));
}

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Reuse IDs from a loaded key by folder name; assign new ones otherwise. */
export function assignIds(folders: string[], loaded: KeyRow[]): Map<string, string> {
  const used = new Set(loaded.map((r) => r.id));
  const out = new Map<string, string>();
  for (const f of folders) {
    const hit = loaded.find((r) => key(r.folder) === key(f) || key(r.name) === key(f));
    const id = hit?.id ?? newId(used);
    used.add(id);
    out.set(f, id);
  }
  return out;
}
