import { afterEach, describe, expect, it, vi } from "vitest";
import { putResumable } from "../src/upload";

const MiB = 1024 * 1024;
afterEach(() => vi.unstubAllGlobals());

describe("putResumable", () => {
  it("sends 256 KiB-multiple chunks, resumes after a network error, never sends the whole file at once", async () => {
    const total = 20 * MiB + 123;
    const calls: string[] = [];
    let failed = false;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const range = (init.headers as Record<string, string>)["Content-Range"];
      calls.push(range);
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (!m) return new Response(null, { status: 308, headers: { Range: `bytes=0-${8 * MiB - 1}` } }); // status query: Drive has the first chunk
      const [s, e] = [Number(m[1]), Number(m[2])];
      expect((init.body as Blob).size).toBe(e - s + 1);
      if (s === 8 * MiB && !failed) {
        failed = true;
        throw new TypeError("network down");
      }
      return e + 1 === total ? new Response("{}", { status: 200 }) : new Response(null, { status: 308, headers: { Range: `bytes=0-${e}` } });
    });
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => (fn(), 0)) as never);
    await putResumable("https://drive.test/session", new Blob([new Uint8Array(total)]), "video/mp4");
    expect(calls).toEqual([
      `bytes 0-${8 * MiB - 1}/${total}`,
      `bytes ${8 * MiB}-${16 * MiB - 1}/${total}`, // fails
      `bytes */${total}`, // status query
      `bytes ${8 * MiB}-${16 * MiB - 1}/${total}`,
      `bytes ${16 * MiB}-${total - 1}/${total}`,
    ]);
    expect((8 * MiB) % (256 * 1024)).toBe(0);
  });
});
