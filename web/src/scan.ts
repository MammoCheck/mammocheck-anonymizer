// Folder listing -> patients, and file classification. No DOM.

export type FileKind = "video" | "image" | "pdf" | "docx" | "xlsx" | "text" | "junk" | "unknown";

export interface ScanFile {
  /** Path relative to the selected root, e.g. "Jane Smithson/sub/a.pdf"; first segment is the root-relative top level. */
  path: string;
}

export interface Patient<T extends ScanFile = ScanFile> {
  /** Folder name = patient name. */
  name: string;
  /** Files with paths relative to the patient folder. */
  files: (T & { relPath: string })[];
}

const JUNK_RE = /^(thumbs\.db|\.ds_store|desktop\.ini|~\$.*|\._.*)$/i;
const VIDEO_EXT = new Set(["mp4", "mov", "avi", "m4v", "3gp", "mkv", "webm", "wmv", "mpg", "mpeg"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif", "heic", "heif"]);
const TEXT_EXT = new Set(["txt", "csv", "md", "tsv"]);

export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const extOf = (p: string) => {
  const n = baseName(p);
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i + 1).toLowerCase() : "";
};

export function classify(path: string): FileKind {
  if (JUNK_RE.test(baseName(path))) return "junk";
  const e = extOf(path);
  if (VIDEO_EXT.has(e)) return "video";
  if (IMAGE_EXT.has(e)) return "image";
  if (e === "pdf") return "pdf";
  if (e === "docx") return "docx";
  if (e === "xlsx") return "xlsx";
  if (TEXT_EXT.has(e)) return "text";
  return "unknown";
}

/**
 * `files[].path` starts with the selected root folder name (as webkitRelativePath does).
 * - root has real (non-junk) files directly inside -> the root itself is one patient
 * - otherwise each top-level subfolder is one patient; deeper subfolders are kept.
 */
export function detectPatients<T extends ScanFile>(files: T[]): Patient<T>[] {
  const stripped = files.map((f) => {
    const i = f.path.indexOf("/");
    return { f, root: f.path.slice(0, i < 0 ? f.path.length : i), rel: i < 0 ? "" : f.path.slice(i + 1) };
  });
  if (stripped.length === 0) return [];
  const rootName = stripped[0].root;
  const looseAtRoot = stripped.some((s) => !s.rel.includes("/") && s.rel !== "" && classify(s.rel) !== "junk");
  if (looseAtRoot) {
    return [{ name: rootName, files: stripped.map((s) => ({ ...s.f, relPath: s.rel })) }];
  }
  const byPatient = new Map<string, Patient<T>>();
  for (const s of stripped) {
    const j = s.rel.indexOf("/");
    if (j < 0) continue; // junk at root
    const name = s.rel.slice(0, j);
    let p = byPatient.get(name);
    if (!p) byPatient.set(name, (p = { name, files: [] }));
    p.files.push({ ...s.f, relPath: s.rel.slice(j + 1) });
  }
  return [...byPatient.values()];
}
