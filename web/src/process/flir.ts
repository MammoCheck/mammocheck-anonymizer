// Pass-through files (FLIR JPGs, videos): bytes are never modified, only scanned for name strings.

const CHUNK = 4 * 1024 * 1024;

/** Case-insensitive (ASCII) scan, also for UTF-16LE. Streams via Blob.slice; returns true on first hit. */
export async function scanBlobForNeedles(blob: Blob, needles: string[], chunk = CHUNK): Promise<boolean> {
  const pats: Uint8Array[] = [];
  for (const n of needles) {
    const lower = n.toLowerCase();
    pats.push(new TextEncoder().encode(lower));
    if (/^[\x00-\x7f]*$/.test(lower)) {
      const u = new Uint8Array(lower.length * 2);
      for (let i = 0; i < lower.length; i++) u[i * 2] = lower.charCodeAt(i);
      pats.push(u);
    }
  }
  if (pats.length === 0) return false;
  const maxLen = Math.max(...pats.map((p) => p.length));
  const first = new Uint8Array(256);
  for (const p of pats) first[p[0]] = 1;
  const isLetter = (b: number) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b >= 128;
  let tail: Uint8Array = new Uint8Array(0);
  for (let off = 0; off < blob.size; off += chunk) {
    const cur = new Uint8Array(await blob.slice(off, off + chunk).arrayBuffer());
    const buf = new Uint8Array(tail.length + cur.length);
    buf.set(tail);
    buf.set(cur, tail.length);
    const last = off + chunk >= blob.size;
    const limit = last ? buf.length : buf.length - maxLen; // positions fully inside buffer
    for (let i = off === 0 ? 0 : 1; i < limit; i++) {
      let b = buf[i];
      if (b >= 65 && b <= 90) b += 32;
      if (!first[b]) continue;
      if (i > 0 && isLetter(buf[i - 1])) continue; // word boundary: fewer false hits in large binaries
      for (const p of pats) {
        if (i + p.length > buf.length) continue;
        let ok = true;
        for (let k = 0; k < p.length; k++) {
          let c = buf[i + k];
          if (c >= 65 && c <= 90) c += 32;
          if (c !== p[k]) { ok = false; break; }
        }
        if (!ok) continue;
        const after = buf[i + p.length];
        if (after !== undefined && isLetter(after)) continue;
        return true;
      }
    }
    tail = buf.slice(Math.max(0, limit - 1)); // keep one preceding byte for the boundary check
  }
  return false;
}

/** Reads EXIF Make of a JPEG (first 128 KiB). */
export async function isFlirJpeg(blob: Blob): Promise<boolean> {
  const b = new Uint8Array(await blob.slice(0, 131072).arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return false;
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe1 && String.fromCharCode(...b.slice(p + 4, p + 8)) === "Exif") {
      const t = p + 10; // TIFF header
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const u32 = (o: number) => (le ? (u16(o) | (u16(o + 2) << 16)) >>> 0 : ((u16(o) << 16) | u16(o + 2)) >>> 0);
      const ifd = u32(4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x010f) {
          const cnt = u32(e + 4);
          const off = cnt <= 4 ? e + 8 : u32(e + 8);
          return String.fromCharCode(...b.slice(t + off, t + off + Math.min(cnt, 16))).toUpperCase().startsWith("FLIR");
        }
      }
      return false;
    }
    if (marker === 0xda) break;
    p += 2 + len;
  }
  return false;
}
