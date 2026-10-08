// DOCX / XLSX: replace PII in the XML text, wipe document properties.
import JSZip from "jszip";
import { detect, findLabels, findNameHits, leaks, REDACTED, type Hit, type NameSet } from "../names";

const unesc = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Flavor {
  /** Regex source for text elements, group 2 = content. */
  tag: string;
  /** Closing marker that ends a "paragraph" (unit of text). */
  endMarker: string;
}
const WORD: Flavor = { tag: "w:t", endMarker: "</w:p>" };
const SHEET: Flavor = { tag: "t", endMarker: "</si>" };

function textRe(f: Flavor) {
  return new RegExp(`(<${f.tag}(?:\\s[^>]*)?>)([^<]*)(</${f.tag}>)`, "g");
}

/** Visit each paragraph's text pieces; `fn` gets joined text and returns spans to replace. */
function mapParagraphs(xml: string, f: Flavor, fn: (text: string, idx: number) => Hit[]): string {
  let idx = 0;
  return xml
    .split(f.endMarker)
    .map((chunk) => {
      const pieces: string[] = [];
      for (const m of chunk.matchAll(textRe(f))) pieces.push(unesc(m[2]));
      const full = pieces.join("");
      const spans = full ? fn(full, idx++) : [];
      if (spans.length === 0) return chunk;
      let pi = 0;
      let offset = 0;
      return chunk.replace(textRe(f), (_all, open: string, _t: string, close: string) => {
        const text = pieces[pi++];
        const start = offset;
        offset += text.length;
        let out = "";
        let pos = 0;
        for (const s of spans) {
          const a = Math.max(s.start, start) - start;
          const b = Math.min(s.end, offset) - start;
          if (b <= a) continue;
          out += text.slice(pos, a);
          if (s.start >= start) out += REDACTED; // placeholder once, where the span starts
          pos = b;
        }
        out += text.slice(pos);
        return open + esc(out) + close;
      });
    })
    .join(f.endMarker);
}

const isXmlText = (n: string) => /^word\/(?!media\/).*\.xml$/.test(n) || n === "xl/sharedStrings.xml";

function processXml(xml: string, f: Flavor, ns: NameSet): string {
  const paras: string[] = [];
  // pass 1: collect texts for the "empty label -> next paragraph" rule
  mapParagraphs(xml, f, (t) => (paras.push(t), []));
  const extra = new Set<number>();
  paras.forEach((t, i) => {
    const labels = findLabels(t);
    const next = paras[i + 1];
    if (labels.length && labels.every((l) => l.valueEnd === l.valueStart) && next && next.length < 80 && findLabels(next).length === 0) {
      extra.add(i + 1);
    }
  });
  return mapParagraphs(xml, f, (t, i) => (extra.has(i) ? [{ start: 0, end: t.length, kind: "label" as const }] : detect(t, ns)));
}

function wipeProps(xml: string): string {
  return xml.replace(
    /(<(?:dc:creator|cp:lastModifiedBy|dc:title|dc:subject|cp:keywords|dc:description|Company|Manager)\b[^>]*>)[^<]*(<)/g,
    "$1$2",
  );
}

export async function anonymizeOffice(bytes: Uint8Array, ns: NameSet): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const zip = await JSZip.loadAsync(bytes);
  const notes: string[] = [];
  let media = 0;
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    if (/\/media\//.test(name)) media++;
    if (isXmlText(name)) {
      const f = name.startsWith("xl/") ? SHEET : WORD;
      const xml = await entry.async("string");
      zip.file(name, processXml(xml, f, ns).replace(/\bw:(author|initials)="[^"]*"/g, 'w:$1=""'));
    } else if (/^docProps\/(core|app|custom)\.xml$/.test(name)) {
      const xml = await entry.async("string");
      zip.file(name, name.endsWith("custom.xml") ? xml.replace(/<vt:lpwstr>[^<]*<\/vt:lpwstr>/g, "<vt:lpwstr></vt:lpwstr>") : wipeProps(xml));
    }
  }
  if (media > 0) notes.push(`${media} embedded media file(s) not anonymized`);
  const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes: out, notes };
}

/** Text of an Office file: paragraphs of the body and the text values of docProps. */
export async function officeParagraphs(bytes: Uint8Array): Promise<{ body: string[]; props: string[] }> {
  const zip = await JSZip.loadAsync(bytes);
  const body: string[] = [];
  const props: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    if (isXmlText(name)) {
      const xml = await zip.files[name].async("string");
      mapParagraphs(xml, name.startsWith("xl/") ? SHEET : WORD, (t) => (body.push(t), []));
    } else if (/^docProps\/.*\.xml$/.test(name)) {
      const xml = await zip.files[name].async("string");
      props.push(...[...xml.matchAll(/>([^<>]+)</g)].map((m) => unesc(m[1])));
    }
  }
  return { body, props };
}

/** Number of leaking paragraphs / property values in an output file. */
export async function leakCheckOffice(bytes: Uint8Array, ns: NameSet): Promise<number> {
  const { body, props } = await officeParagraphs(bytes);
  return body.filter((t) => leaks(t, ns).length > 0).length + props.filter((t) => findNameHits(t, ns).length > 0).length;
}
