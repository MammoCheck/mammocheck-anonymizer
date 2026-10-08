import { describe, expect, it } from "vitest";
import { classify, detectPatients } from "../src/scan";
import { scanBlobForNeedles } from "../src/process/flir";
import { assignIds, parseCsv, toCsv } from "../src/key";

const f = (...paths: string[]) => paths.map((path) => ({ path }));

describe("detectPatients", () => {
  it("root of patient folders", () => {
    const p = detectPatients(f("Root/.DS_Store", "Root/Jane S/a.pdf", "Root/Jane S/sub/b.jpg", "Root/Ali K/c.pdf"));
    expect(p.map((x) => x.name)).toEqual(["Jane S", "Ali K"]);
    expect(p[0].files.map((x) => x.relPath)).toEqual(["a.pdf", "sub/b.jpg"]);
  });
  it("single patient folder", () => {
    const p = detectPatients(f("Jane S/a.pdf", "Jane S/b.jpg", "Jane S/Thumbs.db"));
    expect(p.map((x) => x.name)).toEqual(["Jane S"]);
    expect(p[0].files).toHaveLength(3);
  });
  it("single patient with nested subfolders", () => {
    const p = detectPatients(f("Jane S/a.pdf", "Jane S/thermal/FLIR1.jpg", "Jane S/thermal/old/FLIR2.jpg"));
    expect(p).toHaveLength(1);
    expect(p[0].files.map((x) => x.relPath)).toEqual(["a.pdf", "thermal/FLIR1.jpg", "thermal/old/FLIR2.jpg"]);
  });
  it("empty", () => expect(detectPatients([])).toEqual([]));
});

describe("classify", () => {
  it("types", () => {
    expect(classify("a/Thumbs.db")).toBe("junk");
    expect(classify("~$ily Tx.docx")).toBe("junk");
    expect(classify(".DS_Store")).toBe("junk");
    expect(classify("x.MP4")).toBe("video");
    expect(classify("x.mov")).toBe("video");
    expect(classify("x.jpg")).toBe("image");
    expect(classify("x.docx")).toBe("docx");
    expect(classify("x.doc")).toBe("unknown");
  });
});

describe("streamed byte scan", () => {
  const mk = (size: number, at: number, s: string) => {
    const b = new Uint8Array(size).fill(0x20 + 1); // '!' filler, non-letter
    b.set(new TextEncoder().encode(s), at);
    return new Blob([b]);
  };
  it("finds a needle across a chunk boundary", async () => {
    expect(await scanBlobForNeedles(mk(100, 28, "Smithson"), ["smithson"], 32)).toBe(true);
    expect(await scanBlobForNeedles(mk(100, 30, "SMITHSON"), ["smithson"], 32)).toBe(true);
    expect(await scanBlobForNeedles(mk(110, 97, "Smithson").slice(0, 100), ["smithson"], 32)).toBe(false);
  });
  it("finds UTF-16LE and ignores embedded-in-word", async () => {
    const u = new Uint8Array(40);
    "smithson".split("").forEach((c, i) => (u[10 + i * 2] = c.charCodeAt(0)));
    expect(await scanBlobForNeedles(new Blob([u]), ["smithson"], 16)).toBe(true);
    expect(await scanBlobForNeedles(mk(64, 10, "xxsmithsonyy"), ["smithson"], 16)).toBe(false);
  });
});

describe("key", () => {
  it("csv roundtrip and id reuse", () => {
    const rows = [{ name: 'Jane "R" S', id: "MC-ABC234", folder: "Jane S" }];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
    const ids = assignIds(["jane  s", "New One"], rows);
    expect(ids.get("jane  s")).toBe("MC-ABC234");
    expect(ids.get("New One")).toMatch(/^MC-[A-Z2-9]{6}$/);
  });
});
