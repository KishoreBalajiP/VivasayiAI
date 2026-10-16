import { describe, expect, it } from "vitest";
import { chunkId, csvToText, parseCsv, shouldIngestKey } from "../rag/ingestHelpers.js";

describe("ingestion key filter", () => {
  const opts = { uploadPrefix: "uploads" };
  it("RI-1: only knowledge CSVs are ingested", () => {
    expect(shouldIngestKey("datasets/paddy.csv", opts)).toBe(true);
    expect(shouldIngestKey("Datasets/Soil.CSV", opts)).toBe(true);
    expect(shouldIngestKey("datasets/readme.txt", opts)).toBe(false);
    expect(shouldIngestKey("datasets/", opts)).toBe(false);
    expect(shouldIngestKey("", opts)).toBe(false);
    expect(shouldIngestKey(null, opts)).toBe(false);
  });

  it("RI-2: farmer uploads, land documents and claim evidence are never ingested, even if named .csv", () => {
    expect(shouldIngestKey("uploads/img_123/image.png", opts)).toBe(false);
    expect(shouldIngestKey("uploads/claims/abc/img_1/image.jpg", opts)).toBe(false);
    expect(shouldIngestKey("uploads/anything.csv", opts)).toBe(false);
    expect(shouldIngestKey("/uploads/anything.csv", opts)).toBe(false);
    expect(shouldIngestKey("claims/abc/evidence.csv", opts)).toBe(false);
    expect(shouldIngestKey("uploads-archive/crops.csv", opts)).toBe(true); // a different top-level folder
  });

  it("RI-3: the upload prefix follows configuration, and an include prefix narrows the set", () => {
    expect(shouldIngestKey("farmer-files/x.csv", { uploadPrefix: "farmer-files" })).toBe(false);
    expect(shouldIngestKey("knowledge/a.csv", { uploadPrefix: "uploads", includePrefix: "knowledge/" })).toBe(true);
    expect(shouldIngestKey("other/a.csv", { uploadPrefix: "uploads", includePrefix: "knowledge/" })).toBe(false);
  });
});

describe("CSV parsing", () => {
  it("RI-4: handles quoted commas, escaped quotes, embedded newlines and CRLF", () => {
    const csv = 'crop,note\r\nPaddy,"wet, humid"\r\nRagi,"said ""dry""\nfield"\r\n';
    expect(parseCsv(csv)).toEqual([["crop", "note"], ["Paddy", "wet, humid"], ["Ragi", 'said "dry"\nfield']]);
  });

  it("RI-5: ignores blank lines and a byte order mark", () => {
    expect(parseCsv("﻿a,b\n\n1,2\n\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("RI-6: text rows are self-describing and truncation is reported, not silent", () => {
    const csv = "crop,season\nPaddy,Samba\nRagi,Kharif\nMaize,Rabi\n";
    const full = csvToText({ key: "k.csv", csv, maxRows: 10 });
    expect(full.text).toContain("Row 1: crop: Paddy; season: Samba");
    expect(full.truncated).toBe(false);
    const cut = csvToText({ key: "k.csv", csv, maxRows: 2 });
    expect(cut).toMatchObject({ rowCount: 3, usedRows: 2, truncated: true });
    expect(cut.text).not.toContain("Maize");
  });

  it("RI-7: an empty file yields no text", () => {
    expect(csvToText({ key: "k.csv", csv: "" }).text).toBe("");
  });
});

describe("chunk ids", () => {
  it("RI-8: deterministic for unchanged content, different when the text or position changes", () => {
    const a = chunkId({ key: "k.csv", index: 0, text: "same" });
    expect(chunkId({ key: "k.csv", index: 0, text: "same" })).toBe(a);
    expect(chunkId({ key: "k.csv", index: 1, text: "same" })).not.toBe(a);
    expect(chunkId({ key: "k.csv", index: 0, text: "changed" })).not.toBe(a);
    expect(chunkId({ key: "other.csv", index: 0, text: "same" })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{12}_0_[0-9a-f]{24}$/);
  });
});
