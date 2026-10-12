import { describe, expect, it } from "vitest";
import { findPrevious, historyCsv, importCsv, upsert, type HistoryRow } from "../src/history";

const row = (name: string, id: string, extra: Partial<HistoryRow> = {}): HistoryRow => ({
  name, id, folder: name, last: "2026-10-12T10:00:00.000Z", sent: 3, problems: 0, status: "done", ...extra,
});

describe("upload history", () => {
  it("finds a patient by folder name, ignoring case and spacing", () => {
    const h = [row("Jane Smithson", "MC-AAAAAA")];
    expect(findPrevious(h, "  jane   SMITHSON ")?.id).toBe("MC-AAAAAA");
    expect(findPrevious(h, "John Brown")).toBeUndefined();
  });
  it("upsert replaces by ID and puts the latest first", () => {
    const h = upsert([row("A Person", "MC-AAAAAA"), row("B Person", "MC-BBBBBB")], row("A Person", "MC-AAAAAA", { sent: 9 }));
    expect(h.map((r) => [r.id, r.sent])).toEqual([["MC-AAAAAA", 9], ["MC-BBBBBB", 3]]);
  });
  it("export -> import round-trips, without duplicating known IDs", () => {
    const h = [row('Jane "J" Smithson', "MC-AAAAAA"), row("John Brown", "MC-BBBBBB")];
    const back = importCsv([], historyCsv(h));
    expect(back.map((r) => [r.name, r.id])).toEqual([['Jane "J" Smithson', "MC-AAAAAA"], ["John Brown", "MC-BBBBBB"]]);
    expect(importCsv(h, historyCsv(h))).toHaveLength(2);
  });
});
