import { describe, expect, it } from "vitest";
import {
  buildNameSet, byteNeedles, detect, findContactHits, findNameHits, harvestNames, leaks, levenshtein, redactString, rewriteFilename,
} from "../src/names";

const ns = buildNameSet(["Jane Smithson", "JohnPaul Brown"]);
const matched = (t: string) => findNameHits(t, ns).map((h) => t.slice(h.start, h.end));

describe("name variants + fuzzy", () => {
  it("catches spelling variants", () => {
    expect(matched("Patient SMITHSAN came in")).toEqual(["SMITHSAN"]);
    expect(matched("Report by K.Brownn today")).toEqual(["K.Brownn"]);
    expect(matched("Johnpaul, Brown")).toEqual(["Johnpaul, Brown"]);
    expect(matched("JANE . SMITHSAN")).toEqual(["JANE . SMITHSAN"]);
    expect(matched("J A N E")).toEqual(["J A N E"]);
    expect(matched("Brown, A.")).toEqual(["Brown"]);
    expect(matched("John Paul")).toEqual(["John Paul"]);
  });
  it("does not flag clinical words", () => {
    for (const w of ["Endometriosis", "Tripoli", "radiculopathy", "Thermography", "Jani", "Smithfield region", "Beirut", "lumbar spine", "Randomized"]) {
      expect(matched(w), w).toEqual([]);
    }
  });
  it("levenshtein", () => {
    expect(levenshtein("smithson", "smithsan", 1)).toBe(1);
    expect(levenshtein("smithson", "endometriosis", 1)).toBeGreaterThan(1);
  });
  it("accents/case are ignored", () => {
    expect(matched("JÀNE")).toEqual(["JÀNE"]);
  });
  it("redactString keeps clinical text", () => {
    const out = redactString("Jane Smithson has Endometriosis and radiculopathy.", ns);
    expect(out).toBe("[REDACTED] has Endometriosis and radiculopathy.");
  });
});

describe("harvest", () => {
  it("adds Name: field names that share a token", () => {
    expect(harvestNames("Name: K. Brownn", ns)).toEqual(["K. Brownn"]);
    expect(harvestNames("Name: Someone Else", ns)).toEqual([]);
    const ns2 = buildNameSet(["Jane Smithson", "Kim Brownn"]);
    expect(findNameHits("Kim", ns2)).toHaveLength(1);
  });
});

describe("filename rewrite", () => {
  const id = "MC-7F3K2Q";
  it("replaces variants with the ID", () => {
    expect(rewriteFilename("Med. F-Thermo R.Smithson.pdf", ns, id)).toBe("Med. F-Thermo MC-7F3K2Q.pdf");
    expect(rewriteFilename("Medical File (R.Smithson).pdf", ns, id)).toBe("Medical File (MC-7F3K2Q).pdf");
    expect(rewriteFilename("Daily Tx(A.Brown).docx", ns, id)).toBe("Daily Tx(MC-7F3K2Q).docx");
    expect(rewriteFilename("jane smithson.pdf", ns, id)).toBe("MC-7F3K2Q.pdf");
  });
  it("leaves other names alone", () => {
    expect(rewriteFilename("FLIR9439.jpg", ns, id)).toBe("FLIR9439.jpg");
    expect(rewriteFilename("Body Anamnesis Form_Page_1.jpg", ns, id)).toBe("Body Anamnesis Form_Page_1.jpg");
  });
});

describe("PII regexes", () => {
  it("phones", () => {
    const hits = (t: string) => findContactHits(t).map((h) => t.slice(h.start, h.end));
    expect(hits("tel 0049123456789 fax")).toEqual(["0049123456789"]);
    expect(hits("call +961 3 780 236 now")).toEqual(["+961 3 780 236"]);
    expect(hits("table 00000000 and 11111111")).toEqual([]);
    expect(hits("exam 2025-01-25, CRP 12.5 mg/L, 120/80, 20250125")).toEqual([]);
  });
  it("emails", () => {
    const t = "write to info@example-clinic.com please";
    expect(findContactHits(t).map((h) => t.slice(h.start, h.end))).toEqual(["info@example-clinic.com"]);
  });
  it("label-anchored values", () => {
    const t = "Name: Zed Q\nDate of birth: 12/03/1980\nAddress: 5 Some St, Beirut\nAge: 44\nEmail: a@b.co";
    const out = redactString(t, ns);
    expect(out).toContain("Age: 44");
    expect(out).not.toMatch(/Zed|1980|Some St|a@b/);
    expect(out).toContain("Date of birth: [REDACTED]");
  });
  it("two labels on one line", () => {
    const out = redactString("Name: Zed Q   DOB: 12/03/1980   Sex: F", ns);
    expect(out).toBe("Name: [REDACTED]   DOB: [REDACTED]   Sex: F");
  });
  it("blank values are not redacted; gate ignores placeholders", () => {
    expect(detect("Name: ________", ns)).toEqual([]);
    expect(leaks("Date of birth: [REDACTED]", ns)).toEqual([]);
    expect(leaks("Date of birth: 12/03/1980", ns)).toHaveLength(1);
  });
  it("clinical lines untouched", () => {
    const t = "Diagnosis: Endometriosis. Name of test: thermography. Date of exam 25/01/2025, age 44, female.";
    expect(redactString(t, ns)).toBe(t);
  });
});

describe("byte needles", () => {
  it("long parts and full names only", () => {
    const n = byteNeedles(ns);
    expect(n).toContain("smithson");
    expect(n).toContain("jane smithson");
    expect(n).not.toContain("jane");
  });
});

describe("french labels", () => {
  it("redacts values after French labels", () => {
    const out = redactString("Né(e) le: 10/02/1987 (36 ans)   Sexe : F\nNIP: 12345\nAdresse: 5 rue X", ns);
    expect(out).toContain("Sexe : F");
    expect(out).not.toMatch(/1987|12345|rue X/);
  });
});

describe("label modes", () => {
  it("colon-less label needs the whole line in strict mode (table header 'Name Dose Regularity' stays)", () => {
    expect(redactString("Name   Dose   Regularity", ns)).toBe("Name   Dose   Regularity");
    expect(detect("Name Zed Q", ns, true)).toHaveLength(1); // OCR (loose) mode
  });
});

describe("compound labels", () => {
  it("'DOB & Gender:' redacts the value", () => {
    const ns = buildNameSet(["Jane Smithson"]);
    const t = "DOB & Gender: 10.02.1987 F";
    const out = redactString(t, ns);
    expect(out).not.toContain("1987");
    expect(out.startsWith("DOB & Gender:")).toBe(true);
  });
});

describe("transliteration variants", () => {
  const ns2 = buildNameSet(["Nadia Kerbaji", "AbdulKarim Tamimi"]);
  const m = (t: string) => findNameHits(t, ns2).map((h) => t.slice(h.start, h.end));
  it("catches romanization variants", () => {
    for (const w of ["Karbagi", "KARBAGI", "Kerbaji", "Karbaji", "Abdulkarim"]) expect(m(w), w).toEqual([w]);
  });
  it("still ignores clinical words", () => {
    for (const w of ["Endometriosis", "Tripoli", "radiculopathy", "Thermography", "abdominal", "Saturday", "Sarcoidosis", "Serotonin", "Barbiturate"]) expect(m(w), w).toEqual([]);
  });
});
