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

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

// ---------- table-v1 chunker (plan A10) ----------
// The text-splitter path above produced a header-only first chunk ("File + Columns", no rows) and row
// chunks with neither the file name nor the column list. tableToChunks packs whole rows instead:
//   - every chunk is `File:` / `Table:` / `Columns:` followed by one or more `Row n: header: value; ...`
//     lines, so no chunk is ever emitted without a row;
//   - the preamble comes from the file name and the header row only. It never lists district (or any
//     other) values, so a district term can only match a chunk that holds that district's row;
//   - long-format tables (a district column with more than one row per district) are grouped by
//     district, and a group is only split when it alone exceeds maxChars;
//   - every row appears exactly once, with no overlap and no row cap (the caller applies any cap).
// The legacy format that built the production collection is in scripts/live/lib/legacyChunker.e9b779d.js.

export const CHUNKERS = Object.freeze({ TABLE_V1: "table-v1", LEGACY_E9B779D: "legacy-e9b779d" });
export const DEFAULT_MAX_CHARS = 1000;

export const basenameOf = (key) => String(key || "").split("/").pop();

// "production_of_rice_in_2017_18.csv" -> "production of rice in 2017 18"
export const tableTitle = (key) => basenameOf(key).replace(/\.[^.]+$/, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// The district column: prefer a header naming both district and name ("District_Name"), else the
// first header that mentions a district ("District").
export const findDistrictColumn = (headers) => {
  const named = headers.findIndex((h) => /district/i.test(h) && /name/i.test(h));
  return named >= 0 ? named : headers.findIndex((h) => /district/i.test(h));
};

// "Crop" or "Crop_Name", never "Crop_Year".
export const findCropColumn = (headers) => headers.findIndex((h) => /^\s*crop([\s_]*name)?\s*$/i.test(h));

export const cropFromFilename = (key) => {
  const base = basenameOf(key);
  const match = base.match(/production_of_(.+?)_in_/i) || base.match(/^(.+?)_2016_17/i);
  return match ? match[1].replace(/_/g, " ").trim() : "";
};

// Empty values are dropped as in csvToText. Values past the header row are kept under "Column n"
// rather than lost, and whitespace (including newlines inside quoted fields) collapses to one space
// so each row stays on one line.
export const rowLine = (headers, values, n) => {
  const pairs = [];
  const width = Math.max(headers.length, values.length);
  for (let column = 0; column < width; column += 1) {
    const value = clean(values[column]);
    if (!value) continue;
    pairs.push(`${clean(headers[column]) || `Column ${column + 1}`}: ${value}`);
  }
  return `Row ${n}: ${pairs.join("; ")}`;
};

export const tablePreamble = (key, headers) =>
  [`File: ${basenameOf(key)}`, `Table: ${tableTitle(key)}`, `Columns: ${headers.map((h, i) => clean(h) || `Column ${i + 1}`).join(", ")}`].join("\n");

const unique = (values) => [...new Set(values.filter(Boolean))];

// rows are the data rows (header row excluded), already capped by the caller. Row numbers are the
// 1-based position in `rows`, as in csvToText. Returns [{id, text, metadata}]; metadata values are all
// scalars, as Chroma requires.
export const tableToChunks = ({ key, headers, rows, maxChars = DEFAULT_MAX_CHARS, bucket = "", fileSha256 = "" }) => {
  if (!Array.isArray(headers) || !Array.isArray(rows) || rows.length === 0) return [];
  const preamble = tablePreamble(key, headers);
  const districtColumn = findDistrictColumn(headers);
  const cropColumn = findCropColumn(headers);

  const entries = rows.map((values, index) => ({
    n: index + 1,
    line: rowLine(headers, values, index + 1),
    district: districtColumn >= 0 ? clean(values[districtColumn]) : "",
    crop: cropColumn >= 0 ? clean(values[cropColumn]) : "",
  }));

  // Long format: some district has more than one row. Group in first-seen order; rows keep their
  // original order inside a group.
  let units = entries.map((entry) => [entry]);
  if (districtColumn >= 0) {
    const groups = new Map();
    for (const entry of entries) {
      const group = entry.district.toLowerCase();
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry);
    }
    if ([...groups.values()].some((group) => group.length > 1)) units = [...groups.values()];
  }

  const cost = (entry) => 1 + entry.line.length; // "\n" + the row line
  const packed = [];
  let current = [];
  let length = preamble.length;
  const flush = () => {
    if (current.length) packed.push(current);
    current = [];
    length = preamble.length;
  };
  for (const unit of units) {
    const unitLength = unit.reduce((sum, entry) => sum + cost(entry), 0);
    if (length + unitLength <= maxChars) {
      current.push(...unit);
      length += unitLength;
      continue;
    }
    flush();
    if (preamble.length + unitLength <= maxChars) {
      current.push(...unit);
      length += unitLength;
      continue;
    }
    // The unit alone is too big: split it row by row, then close its last piece so no other group
    // shares a chunk with a partial group. A single row that is too big becomes its own chunk.
    for (const entry of unit) {
      if (current.length && length + cost(entry) > maxChars) flush();
      current.push(entry);
      length += cost(entry);
    }
    flush();
  }
  flush();

  const fileCrop = cropFromFilename(key);
  return packed.map((chunkEntries, index) => {
    const text = [preamble, ...chunkEntries.map((entry) => entry.line)].join("\n");
    const numbers = chunkEntries.map((entry) => entry.n);
    return {
      id: chunkId({ key, index, text }),
      text,
      metadata: {
        source: bucket ? `s3://${bucket}/${key}` : key,
        filename: key,
        chunk_index: index,
        // Grouping can reorder rows, so a chunk holds row_count rows between row_start and row_end,
        // not necessarily every row in that range.
        row_start: Math.min(...numbers),
        row_end: Math.max(...numbers),
        row_count: chunkEntries.length,
        file_kind: "csv_statistics",
        district: unique(chunkEntries.map((entry) => entry.district)).join(", "),
        crop: cropColumn >= 0 ? unique(chunkEntries.map((entry) => entry.crop)).join(", ") : fileCrop,
        chunker: CHUNKERS.TABLE_V1,
        oversizeRow: chunkEntries.length === 1 && text.length > maxChars,
        fileSha256,
      },
    };
  });
};

// District names (config/districts.js plus the spellings the evaluation uses) found in a file's
// preamble. tableToChunks never adds district values to the preamble, but a file name or a wide
// table's headers can still name a district; the index builder records that as a manifest warning.
export const preambleDistrictMentions = (preamble, districtNames) => {
  const text = String(preamble || "").toLowerCase();
  return unique(districtNames.filter((name) => name && text.includes(String(name).toLowerCase())));
};

export default { shouldIngestKey, parseCsv, csvToText, chunkId, sha256Hex, tableToChunks, CHUNKERS };
