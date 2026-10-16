import { createHash } from "node:crypto";

// Pure helpers for the knowledge-base ingestion script (rag/ingest.js). Kept free of AWS, Cohere and
// Chroma so they can be tested without credentials.

// The ingestion bucket is shared with farmer uploads (images, land documents, claim evidence), all
// of which live under the upload prefix. Ingesting them would read binary images as text, embed
// them, and put private farmer content into a knowledge base other farmers query.
export const shouldIngestKey = (key, { uploadPrefix = "uploads", includePrefix = "" } = {}) => {
  if (!key || typeof key !== "string") return false;
  const normalized = key.replace(/^\/+/, "");
  if (normalized.endsWith("/")) return false; // folder placeholder
  const lower = normalized.toLowerCase();
  if (!lower.endsWith(".csv")) return false;
  const upload = String(uploadPrefix || "uploads").replace(/^\/+|\/+$/g, "");
  if (upload && (normalized === upload || normalized.startsWith(`${upload}/`))) return false;
  if (normalized.startsWith("claims/")) return false;
  if (includePrefix && !normalized.startsWith(includePrefix)) return false;
  return true;
};

// RFC 4180 style parser: quoted fields, escaped quotes, commas and newlines inside quotes, CRLF.
// The previous script split on "\n" and kept raw lines, so a quoted field containing a newline or
// comma broke the row.
export const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const source = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
};

// One readable text block per file: headers once, then "header: value" per row so a retrieved chunk
// is self-describing. Returns the truncation so the caller can report it instead of dropping rows
// silently.
export const csvToText = ({ key, csv, maxRows = 100 }) => {
  const rows = parseCsv(csv);
  if (rows.length === 0) return { text: "", rowCount: 0, usedRows: 0, truncated: false };
  const [headers, ...data] = rows;
  const used = data.slice(0, maxRows);
  const lines = [`File: ${key}`, `Columns: ${headers.join(", ")}`, ""];
  used.forEach((values, index) => {
    const pairs = headers.map((header, column) => `${header.trim()}: ${(values[column] ?? "").trim()}`).filter((pair) => !pair.endsWith(": "));
    lines.push(`Row ${index + 1}: ${pairs.join("; ")}`);
  });
  return { text: lines.join("\n"), rowCount: data.length, usedRows: used.length, truncated: data.length > used.length };
};

// Deterministic id from the file, the chunk position and the chunk text: re-running ingestion on an
// unchanged file produces the same ids (so `upsert` is a no-op), and a changed file produces new ids
// for changed chunks only. The previous ids embedded Date.now(), so every run duplicated everything.
export const chunkId = ({ key, index, text }) => {
  const digest = createHash("sha1").update(`${key}\u0000${index}\u0000${text}`).digest("hex").slice(0, 24);
  return `${createHash("sha1").update(key).digest("hex").slice(0, 12)}_${index}_${digest}`;
};

export default { shouldIngestKey, parseCsv, csvToText, chunkId };
