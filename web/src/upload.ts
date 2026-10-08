// Worker client + chunked resumable upload straight to the Drive session URL (bytes never touch the Worker).

const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB (Drive requirement)
const MAX_TRIES = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (n: number) => sleep(Math.min(30000, 500 * 2 ** n) + Math.random() * 250);

export class Uploader {
  private folders = new Map<string, Promise<string>>();
  constructor(
    private workerUrl: string,
    private key: string,
  ) {}

  private async api<T>(path: string, body: unknown): Promise<T> {
    let last: unknown;
    for (let n = 0; n < MAX_TRIES; n++) {
      try {
        const res = await fetch(this.workerUrl.replace(/\/$/, "") + path, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Upload-Key": this.key },
          body: JSON.stringify(body),
        });
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Upload key rejected"), { fatal: true });
        if (res.ok) return (await res.json()) as T;
        last = new Error(`Worker ${path}: HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429) throw Object.assign(last as Error, { fatal: true });
      } catch (e) {
        if ((e as { fatal?: boolean }).fatal) throw e;
        last = e;
      }
      await backoff(n);
    }
    throw last;
  }

  /** Find-or-create a nested folder under the Drive root. Call sequentially per patient (see ensureTree). */
  folder(path: string[]): Promise<string> {
    const k = path.join("/");
    let p = this.folders.get(k);
    if (!p) {
      p = this.api<{ id: string }>("/folder", { path }).then((r) => r.id);
      this.folders.set(k, p);
      p.catch(() => this.folders.delete(k));
    }
    return p;
  }

  /** Create a patient's folders one after another so the Worker never races on the same parent. */
  async ensureTree(paths: string[][]): Promise<void> {
    const sorted = [...new Map(paths.map((p) => [p.join("/"), p])).values()].sort((a, b) => a.length - b.length);
    for (const p of sorted) await this.folder(p);
  }

  async upload(parentPath: string[], name: string, mimeType: string, data: Blob, onProgress?: (sent: number) => void): Promise<"uploaded" | "exists"> {
    const parentId = await this.folder(parentPath);
    const { location, exists } = await this.api<{ location?: string; exists?: boolean }>("/session", {
      parentId, name, mimeType, size: data.size,
    });
    if (exists) return "exists";
    if (!location) throw new Error("No upload session returned");
    await putResumable(location, data, mimeType, onProgress);
    return "uploaded";
  }
}

async function queryOffset(url: string, total: number): Promise<number | "done"> {
  const res = await fetch(url, { method: "PUT", headers: { "Content-Range": `bytes */${total}` } });
  if (res.status === 200 || res.status === 201) return "done";
  if (res.status === 308) return nextOffset(res, 0);
  throw new Error(`Status query failed: HTTP ${res.status}`);
}

function nextOffset(res: Response, fallback: number): number {
  const range = res.headers.get("Range"); // "bytes=0-12345" (may be hidden by CORS: then trust the chunk we sent)
  const m = range && /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : fallback;
}

export async function putResumable(url: string, blob: Blob, mimeType: string, onProgress?: (sent: number) => void): Promise<void> {
  const total = blob.size;
  if (total === 0) {
    const res = await fetch(url, { method: "PUT", headers: { "Content-Range": "bytes */0", "Content-Type": mimeType }, body: new Blob([]) });
    if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
    return;
  }
  let offset = 0;
  let tries = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}`, "Content-Type": mimeType },
        body: blob.slice(offset, end), // streamed from disk, never the whole file in memory
      });
      if (res.status === 200 || res.status === 201) {
        onProgress?.(total);
        return;
      }
      if (res.status === 308) {
        offset = nextOffset(res, end);
        tries = 0;
        onProgress?.(offset);
        continue;
      }
      if (res.status === 404 || res.status === 410) throw Object.assign(new Error("Upload session expired"), { fatal: true });
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || ++tries >= MAX_TRIES) throw e;
      await backoff(tries);
      try {
        const q = await queryOffset(url, total); // resume where Drive says we are
        if (q === "done") return;
        offset = q;
      } catch {
        /* retry the same chunk */
      }
    }
  }
}
