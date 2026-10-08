// Name variants, fuzzy matching and PII detection. Pure functions, no DOM: importable from Node.

export interface NameSet {
  /** Full names (folder name + extra terms), as typed. */
  names: string[];
  /** Normalized name parts (>= 3 letters). */
  parts: Set<string>;
  /** Parts eligible for fuzzy matching (>= 5 letters). */
  fuzzy: string[];
  /** `fuzzy` in transliteration-folded form (see `translit`). */
  fuzzyT: string[];
  /** "J A N E" style patterns, one per part. */
  spaced: RegExp[];
}

export type HitKind = "name" | "email" | "phone" | "label";
export interface Hit {
  start: number;
  end: number;
  kind: HitKind;
}

export const REDACTED = "[REDACTED]";

export const norm = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function splitParts(name: string): string[] {
  const out: string[] = [];
  for (const tok of name.match(/\p{L}+/gu) ?? []) {
    out.push(tok);
    // "JohnPaul" -> "John", "Paul"
    const camel = tok.split(/(?<=\p{Ll})(?=\p{Lu})/u);
    if (camel.length > 1) out.push(...camel);
  }
  return out.map(norm).filter((p) => [...p].length >= 3);
}

export function buildNameSet(names: string[]): NameSet {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  const parts = new Set<string>();
  for (const n of clean) for (const p of splitParts(n)) parts.add(p);
  const list = [...parts];
  return {
    names: clean,
    parts,
    fuzzy: list.filter((p) => [...p].length >= 5),
    fuzzyT: list.filter((p) => [...p].length >= 5).map(translit),
    spaced: list.map(
      (p) =>
        new RegExp(
          `(?<![\\p{L}])${[...p].map(escapeRe).join("[\\s.\\-]{1,3}")}(?![\\p{L}])`,
          "giu",
        ),
    ),
  };
}

/**
 * Fold spellings that differ only by romanization (Arabic names especially: Kerbaji / Karbagi / Karbaji,
 * Abdel / Abdul, Youssef / Yousef): vowels e->a, o->u, y->i; j/dj->g, q/c->k, ph->f; double letters collapsed.
 */
export function translit(s: string): string {
  return norm(s)
    .replace(/ph/g, "f")
    .replace(/dj/g, "g")
    .replace(/ou/g, "u")
    .replace(/ee/g, "i")
    .replace(/[eo]/g, (c) => (c === "e" ? "a" : "u"))
    .replace(/y/g, "i")
    .replace(/j/g, "g")
    .replace(/[qc]/g, "k")
    .replace(/(.)\1+/g, "$1");
}

export function levenshtein(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export function tokenMatches(token: string, ns: NameSet): boolean {
  const t = norm(token);
  if (ns.parts.has(t)) return true;
  if (t.length >= 5 && ns.fuzzy.some((p) => levenshtein(p, t, 1) <= 1)) return true;
  if (t.length >= 5) {
    const tt = translit(t);
    if (ns.fuzzyT.some((p) => levenshtein(p, tt, 1) <= 1)) return true;
  }
  // glued tokens ("JaneSmithson" from OCR): contains a long name part
  return t.length >= 9 && ns.fuzzy.some((p) => p.length >= 6 && t.includes(p));
}

/** Merge ranges when the text between them is only separators. */
function mergeRanges(text: string, ranges: Hit[], sep = /^[\s.,\-_/]*$/): Hit[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Hit[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && (r.start <= last.end || (last.kind === "name" && r.kind === "name" && sep.test(text.slice(last.end, r.start))))) {
      last.end = Math.max(last.end, r.end);
      if (r.kind !== "name") last.kind = r.kind;
    } else out.push({ ...r });
  }
  return out;
}

export function findNameHits(text: string, ns: NameSet): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/\p{L}+/gu)) {
    if (tokenMatches(m[0], ns)) hits.push({ start: m.index!, end: m.index! + m[0].length, kind: "name" });
  }
  for (const re of ns.spaced) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push({ start: m.index!, end: m.index! + m[0].length, kind: "name" });
  }
  const merged = mergeRanges(text, hits);
  // extend over a leading initial: "K.Brownn", "R. Smithson"
  for (const h of merged) {
    const m = /(?<![\p{L}])\p{Lu}[.\s]{0,2}$/u.exec(text.slice(Math.max(0, h.start - 4), h.start));
    if (m) h.start -= m[0].length;
  }
  return mergeRanges(text, merged);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// Unlabeled phones: +/00 prefixed formatted numbers, or contiguous 8-15 digit runs.
const PHONE_PREFIXED_RE = /(?<![\d\w])(?:\+|00)\d[\d ()./-]{5,16}\d(?!\d)/g;
const LOCAL_PHONE_RE = /(?<![\d.,/-])0\d{1,2}[ -]?\d{3}[ -]?\d{3,4}(?!\d)/g;
// OCR drops the slashes of dates: "10/20/2023" -> 10202023; not a phone number
const DDMMYYYY_RE = /^\d{4}(?:19|20)\d{2}$/;
const DIGIT_RUN_RE = /(?<![\d.])\d{8,15}(?![\d])/g;

function isDateLike(s: string): boolean {
  const m = /^(19|20)(\d{2})(\d{2})(\d{2})$/.exec(s);
  return !!m && +m[3] >= 1 && +m[3] <= 12 && +m[4] >= 1 && +m[4] <= 31;
}

export function findContactHits(text: string): Hit[] {
  // OCR reads table borders and dates as "0000000" / "02000023": digit soup is not a phone number
  return findContactHitsRaw(text).filter((h) => h.kind !== "phone" || !isDigitSoup(text.slice(h.start, h.end).replace(/\D/g, "")));
}

function isDigitSoup(d: string): boolean {
  const counts = new Map<string, number>();
  for (const c of d) counts.set(c, (counts.get(c) ?? 0) + 1);
  return new Set(d).size < 3 || Math.max(...counts.values()) / d.length >= 0.6;
}

function findContactHitsRaw(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(EMAIL_RE)) hits.push({ start: m.index!, end: m.index! + m[0].length, kind: "email" });
  for (const m of text.matchAll(PHONE_PREFIXED_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) hits.push({ start: m.index!, end: m.index! + m[0].length, kind: "phone" });
  }
  for (const m of text.matchAll(LOCAL_PHONE_RE)) {
    if (!hits.some((h) => h.kind === "phone" && m.index! >= h.start && m.index! < h.end))
      hits.push({ start: m.index!, end: m.index! + m[0].length, kind: "phone" });
  }
  for (const m of text.matchAll(DIGIT_RUN_RE)) {
    const at = m.index!;
    if (hits.some((h) => h.kind === "phone" && at >= h.start && at < h.end)) continue;
    if (!isDateLike(m[0]) && !DDMMYYYY_RE.test(m[0])) hits.push({ start: m.index!, end: m.index! + m[0].length, kind: "phone" });
  }
  return hits;
}

// ---- label-anchored values ----
const LABEL_SRC = [
  "patient\\s*name", "full\\s*name", "name",
  "date\\s*of\\s*birth", "d\\.?\\s?o\\.?\\s?b\\.?", "birth\\s*date", "birthday",
  "(?:home\\s*)?address", "city", "postal\\s*code", "zip(?:\\s*code)?", "p\\.?\\s?o\\.?\\s*box",
  "phone(?:\\s*(?:number|no\\.?))?", "tel(?:ephone)?\\.?", "mob(?:ile)?(?:\\s*(?:number|no\\.?))?", "cell(?:phone)?", "whatsapp",
  "e-?mail", "(?:patient|national)\\s*id(?:\\s*(?:number|no\\.?))?", "id(?:\\s*(?:number|no\\.?))?",
  // French (common on lab reports)
  "nom(?:\\s*et\\s*pr[ée]noms?)?", "pr[ée]noms?", "n[ée](?:\\(e\\)|e)?\\s*le", "date\\s*de\\s*naissance", "adresse", "t[ée]l(?:[ée]phone)?\\.?", "portable",
  "dossier", "nip", "ipp", "visite", "n[°º]",
  "file\\s*(?:no|number|#)\\.?", "mrn(?:\\s*&\\s*visit\\s*no\\.?)?", "medical\\s*record(?:\\s*(?:no|number))?\\.?", "(?:visit|chart|record)\\s*(?:no|number)\\.?", "passport(?:\\s*(?:no|number))?\\.?",
].join("|");
// "DOB & Gender:", "Name / Surname:": a second field name between label and colon belongs to the label
const LABEL_RE = new RegExp(`(?<![\\p{L}\\d])(${LABEL_SRC})(?:[ \\t]*[&/][ \\t]*\\p{L}+)?(?![\\p{L}\\d])[ \\t]*(:|：)?`, "giu");
const MAX_VALUE = 80;

export interface Label {
  /** Label text start/end (end excludes colon). */
  start: number;
  end: number;
  /** Value range (may be empty). */
  valueStart: number;
  valueEnd: number;
  key: string;
}

/** `loose`: also accept colon-less labels followed by a short value (OCR text, where colons get lost). */
export function findLabels(text: string, loose = false): Label[] {
  const cands: { start: number; end: number; after: number; key: string }[] = [];
  for (const m of text.matchAll(LABEL_RE)) {
    const start = m.index!;
    const colon = !!m[2];
    const after = start + m[0].length;
    const lineStart = /(^|\n)[ \t\-*•\d.)]*$/.test(text.slice(0, start));
    const rest = text.slice(after).split("\n")[0];
    if (!colon && !(lineStart && (loose ? rest.length <= 50 : rest.trim() === ""))) continue;
    cands.push({ start, end: start + m[1].length, after, key: norm(m[1]).replace(/\s+/g, " ") });
  }
  return cands.map((c, i) => {
    const nl = text.indexOf("\n", c.after);
    let limit = nl < 0 ? text.length : nl;
    const next = cands[i + 1];
    if (next && next.start < limit) limit = next.start;
    let vs = c.after;
    while (vs < limit && /\s/.test(text[vs])) vs++;
    const gap = text.slice(vs, limit).search(/\t|\s{3,}|(?<![\p{L}])(?:sex|sexe|gender|age|weight|height|marital status|occupation|nationality|date)\s*:/iu);
    if (gap > 0) limit = vs + gap;
    let ve = Math.min(limit, vs + MAX_VALUE);
    while (ve > vs && /\s/.test(text[ve - 1])) ve--;
    return { start: c.start, end: c.end, valueStart: vs, valueEnd: ve, key: c.key };
  });
}

export const BLANK_VALUE_RE = /^[\s_.\-–—…]*$/;
const isRedactedValue = (v: string) => BLANK_VALUE_RE.test(v.replace(/\[REDACTED\]/g, ""));

function labelHits(text: string, loose = false): Hit[] {
  return findLabels(text, loose)
    .filter((l) => l.valueEnd > l.valueStart && !BLANK_VALUE_RE.test(text.slice(l.valueStart, l.valueEnd)))
    .map((l) => ({ start: l.valueStart, end: l.valueEnd, kind: "label" as const }));
}

/** All spans to redact in a text. */
export function detect(text: string, ns: NameSet, loose = false): Hit[] {
  return mergeRanges(text, [...findNameHits(text, ns), ...findContactHits(text), ...labelHits(text, loose)]);
}

/** Spans that must not survive in output text (used by the leak gate). */
export function leaks(text: string, ns: NameSet): Hit[] {
  const lab = labelHits(text).filter((h) => !isRedactedValue(text.slice(h.start, h.end)));
  return mergeRanges(text, [...findNameHits(text, ns), ...findContactHits(text), ...lab]);
}

/** Names + contact details only (no label values): used where text comes from OCR. */
export function strictLeaks(text: string, ns: NameSet): Hit[] {
  return mergeRanges(text, [...findNameHits(text, ns), ...findContactHits(text)]);
}

export function redactString(text: string, ns: NameSet, repl = REDACTED): string {
  let out = "";
  let pos = 0;
  for (const h of detect(text, ns)) {
    out += text.slice(pos, h.start) + repl;
    pos = h.end;
  }
  return out + text.slice(pos);
}

/** Names from "Name:" fields that share at least one token with the known name. */
export function harvestNames(text: string, ns: NameSet): string[] {
  const out: string[] = [];
  for (const l of findLabels(text)) {
    if (!/name|nom/.test(l.key)) continue;
    const v = text.slice(l.valueStart, l.valueEnd).trim();
    const toks = v.match(/\p{L}+/gu) ?? [];
    if (toks.length === 0 || toks.length > 4 || v.length > 40 || /[\d@]/.test(v)) continue;
    if (toks.some((t) => tokenMatches(t, ns))) out.push(v);
  }
  return out;
}

/** Replace name variants in a string with the patient ID (file or folder names). */
export function rewriteText(text: string, ns: NameSet, id: string): string {
  let out = "";
  let pos = 0;
  for (const h of findNameHits(text, ns)) {
    out += text.slice(pos, h.start) + id;
    pos = h.end;
  }
  return (out + text.slice(pos)).replace(/[\\/:*?"<>|]/g, "_").trim();
}

export function rewriteFilename(filename: string, ns: NameSet, id: string): string {
  const dot = filename.lastIndexOf(".");
  const hasExt = dot > 0 && filename.length - dot <= 6;
  return rewriteText(hasExt ? filename.slice(0, dot) : filename, ns, id) + (hasExt ? filename.slice(dot) : "");
}

/** Byte needles (lowercase ASCII, UTF-8 only) for scanning binary files. Parts >= 5 letters plus full names. */
export function byteNeedles(ns: NameSet): string[] {
  const set = new Set<string>();
  for (const p of ns.parts) if ([...p].length >= 5) set.add(p);
  for (const n of ns.names) {
    const toks = (n.match(/\p{L}+/gu) ?? []).map(norm);
    if (toks.length > 1) for (const sep of [" ", "_", ".", "-", ""]) set.add(toks.join(sep));
  }
  return [...set];
}
