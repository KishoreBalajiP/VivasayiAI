import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { CHUNKERS, cropFromFilename, parseCsv, tableToChunks } from "../rag/ingestHelpers.js";
import { assertNoMixedChunkers, chunkFile, parseIngestArgs, writeChromaCloud } from "../rag/ingest.js";
import { loadLocalIndex, rankBySquaredL2, writeLocalIndex } from "../rag/localIndex.js";
import { BASELINE60_MAX_ROWS, buildLocalIndex, createReadOnlyS3, isForbiddenKey, loadAllowList, parseBuildArgs } from "../rag/buildLocalIndex.js";
import { legacyChunks, legacyTextFromCsv } from "../scripts/live/lib/legacyChunker.e9b779d.js";
import { labelHits, QUERIES } from "../scripts/live/lib/ragEvalSpec.js";
import { ResultExistsError, runLabelProblem, writeResultOnce } from "../scripts/live/lib/writeOnce.js";
import { readOnlyCollection } from "../scripts/live/ragSnapshotProd.js";
import { readProvenance } from "../scripts/live/verifyRagSpec.js";
import { DEFAULT_RAG_COLLECTION, ragCollectionName, ragMaxRowsPerFile } from "../config/ragConfig.js";
import { districtReference } from "../config/districts.js";

// RAG table chunker, legacy chunker, local index, S3 guard and write-once (plan A10).
// Fixtures in tests/fixtures/rag/ are synthetic: their headers follow the real knowledge files, the
// values are generated arithmetic, not data. No test calls S3, Cohere or Chroma.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(root, "tests", "fixtures", "rag");
const CSV_FIXTURES = ["production_of_rice_in_2017_18.csv", "Tamilnadu agriculture yield data.csv", "pest_observations.csv", "neem.csv"];
const SIZES = [1000, 400, 250];
const BASELINE = join(root, "docs", "research", "evaluation", "live", "rag_retrieval_2026-10-16.json");

const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const chunked = (name, options = {}) => chunkFile({ key: name, text: fixture(name), bucket: "fixture-bucket", ...options });
const dataRows = (name) => parseCsv(fixture(name)).slice(1);
const rowNumbers = (text) => [...text.matchAll(/^Row (\d+):/gm)].map((m) => Number(m[1]));
const tmp = () => mkdtempSync(join(tmpdir(), "rag-chunker-"));
const districtOf = (name, n) => {
  const [headers] = parseCsv(fixture(name));
  const column = headers.findIndex((h) => /district/i.test(h));
  return column >= 0 ? String(dataRows(name)[n - 1][column]).trim() : "";
};
// Script guards run in a child process with no .env, blank provider keys and a preload that makes
// every socket connection throw: if a guard regressed, the script fails instead of reaching a provider.
const NO_NETWORK_PRELOAD = [
  'import net from "node:net";',
  'const blocked = () => { throw new Error("network blocked by the RAG script-guard test"); };',
  "net.Socket.prototype.connect = blocked;",
  "globalThis.fetch = async () => blocked();",
].join("\n");
const runScript = (script, args) => {
  const preload = join(tmp(), "no-network.mjs");
  writeFileSync(preload, NO_NETWORK_PRELOAD);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", LOG_LEVEL: "silent", VIVASAYI_SKIP_DOTENV: "1" };
  for (const key of ["COHERE_API_KEY", "CHROMA_API_KEY", "CHROMA_TENANT", "CHROMA_DATABASE", "GOOGLE_API_KEY", "MY_AWS_ACCESS_KEY_ID", "MY_AWS_SECRET_ACCESS_KEY", "MONGO_URI"]) env[key] = "";
  return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(root, script), ...args], { cwd: root, env, encoding: "utf8", timeout: 60000 });
};
const fileSha256 = (path) => sha256(readFileSync(path));
// Source with whole-line comments removed, so prose about a method never counts as a call.
const codeOf = (rel) => readFileSync(join(root, rel), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

const everyChunk = async (fn) => {
  for (const name of CSV_FIXTURES) {
    for (const maxChars of SIZES) {
      const { chunks } = await chunked(name, { maxChars });
      chunks.forEach((chunk) => fn(chunk, { name, maxChars }));
    }
  }
};

describe("table-v1 chunker", () => {
  it("RC-1: every chunk carries at least one Row line; a file with no data rows yields no chunk", async () => {
    let count = 0;
    await everyChunk((chunk) => {
      expect(chunk.text).toMatch(/Row \d+:/);
      expect(rowNumbers(chunk.text).length).toBeGreaterThanOrEqual(1);
      count += 1;
    });
    expect(count).toBeGreaterThan(30);
    expect((await chunked("header_only.csv")).chunks).toEqual([]);
    expect(tableToChunks({ key: "k.csv", headers: ["a"], rows: [] })).toEqual([]);
  });

  it("RC-2: every chunk starts with File: <basename>, Table: and Columns:", async () => {
    await everyChunk((chunk, { name }) => {
      const title = name.replace(/\.csv$/, "").replace(/_/g, " ");
      expect(chunk.text.startsWith(`File: ${name}\nTable: ${title}\nColumns: `)).toBe(true);
    });
    // A key with a folder prefix: File: is the basename, metadata.filename keeps the full key.
    const { chunks: [chunk] } = await chunkFile({ key: "datasets/neem.csv", text: fixture("neem.csv") });
    expect(chunk.text.split("\n").slice(0, 3)).toEqual(["File: neem.csv", "Table: neem", "Columns: Sl. No., District, Area, Prodn, Ptvy."]);
    expect(chunk.metadata.filename).toBe("datasets/neem.csv");
  });

  it("RC-3: a district name appears in a chunk only through a row of that district; the preamble names none", async () => {
    const names = new Set(districtReference.map((d) => d.name.toLowerCase()));
    for (const name of CSV_FIXTURES) {
      const [headers] = parseCsv(fixture(name));
      const column = headers.findIndex((h) => /district/i.test(h));
      if (column >= 0) dataRows(name).forEach((row) => names.add(String(row[column]).trim().toLowerCase()));
    }
    names.delete("total");
    expect(names.size).toBeGreaterThan(30);
    await everyChunk((chunk, { name }) => {
      const lines = chunk.text.split("\n");
      const preamble = lines.slice(0, 3).join("\n").toLowerCase();
      for (const district of names) expect(preamble.includes(district), `${name} preamble names ${district}`).toBe(false);
      for (const line of lines.slice(3)) {
        const n = Number(line.match(/^Row (\d+):/)[1]);
        const own = districtOf(name, n).toLowerCase();
        for (const district of names) {
          if (line.toLowerCase().includes(district)) expect(own.includes(district), `${name} row ${n} mentions ${district}`).toBe(true);
        }
      }
      const expected = [...new Set(rowNumbers(chunk.text).map((n) => districtOf(name, n)).filter(Boolean))].join(", ");
      expect(chunk.metadata.district).toBe(expected);
    });
  });

  it("RC-4: chunk metadata is scalar and carries district, crop, rows, chunker and the file hash", async () => {
    const keys = ["source", "filename", "chunk_index", "row_start", "row_end", "row_count", "file_kind", "district", "crop", "chunker", "oversizeRow", "fileSha256"];
    await everyChunk((chunk, { name }) => {
      expect(Object.keys(chunk.metadata).sort()).toEqual([...keys].sort());
      for (const value of Object.values(chunk.metadata)) expect(["string", "number", "boolean"]).toContain(typeof value);
      expect(chunk.metadata).toMatchObject({ source: `s3://fixture-bucket/${name}`, filename: name, file_kind: "csv_statistics", chunker: CHUNKERS.TABLE_V1, fileSha256: sha256(fixture(name)) });
      const numbers = rowNumbers(chunk.text);
      expect(chunk.metadata).toMatchObject({ row_start: Math.min(...numbers), row_end: Math.max(...numbers), row_count: numbers.length });
    });
    const rice = (await chunked("production_of_rice_in_2017_18.csv")).chunks;
    expect(rice.every((c) => c.metadata.crop === "rice")).toBe(true);
    expect(rice[0].metadata.district).toBe("Ariyalur, Chengalpattu");
    const yieldChunks = (await chunked("Tamilnadu agriculture yield data.csv")).chunks;
    const erode = yieldChunks.filter((c) => c.metadata.district === "ERODE");
    expect(erode.length).toBeGreaterThan(0);
    expect(erode.some((c) => c.metadata.crop.split(", ").includes("Sugarcane"))).toBe(true);
    expect((await chunked("neem.csv")).chunks[0].metadata).toMatchObject({ district: "Madurai, Dindigul, Theni", crop: "" });
    expect(cropFromFilename("production_of_black_gram_in_2017_18.csv")).toBe("black gram");
    expect(cropFromFilename("arecanut_curednuts_2016_17.csv")).toBe("arecanut curednuts");
    expect(cropFromFilename("Soil data.csv")).toBe("");
  });

  it("RC-5: a chunk is at most maxChars unless it is a single row marked oversizeRow", async () => {
    let oversize = 0;
    await everyChunk((chunk, { maxChars }) => {
      if (chunk.metadata.oversizeRow) {
        oversize += 1;
        expect(chunk.metadata.row_count).toBe(1);
        expect(chunk.text.length).toBeGreaterThan(maxChars);
      } else {
        expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
      }
    });
    expect(oversize).toBeGreaterThan(0);
    const pest = (await chunked("pest_observations.csv")).chunks;
    expect(pest.filter((c) => c.metadata.oversizeRow).map((c) => rowNumbers(c.text))).toEqual([[4]]);
  });

  it("RC-6: ids and texts are deterministic, and only the changed chunk gets a new id", async () => {
    const name = "production_of_rice_in_2017_18.csv";
    const first = await chunked(name);
    const second = await chunked(name);
    expect(second).toEqual(first);
    const ids = first.chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^[0-9a-f]{12}_\d+_[0-9a-f]{24}$/));

    const changedText = fixture(name).replace("5,TamilNadu,Cuddalore,", "5,TamilNadu,Cuddalore,9");
    expect(changedText).not.toBe(fixture(name));
    const changed = await chunkFile({ key: name, text: changedText, bucket: "fixture-bucket", fileSha256: first.chunks[0].metadata.fileSha256 });
    const differing = changed.chunks.map((c, i) => (c.id === ids[i] ? null : i)).filter((i) => i !== null);
    expect(differing).toHaveLength(1);
    expect(rowNumbers(changed.chunks[differing[0]].text)).toContain(5);
  });

  it("RC-7: every row appears exactly once, with no cap by default (RAG_MAX_ROWS_PER_FILE 0)", async () => {
    for (const name of CSV_FIXTURES) {
      for (const maxChars of SIZES) {
        const result = await chunked(name, { maxChars });
        const numbers = result.chunks.flatMap((c) => rowNumbers(c.text)).sort((a, b) => a - b);
        const total = dataRows(name).length;
        expect(numbers).toEqual(Array.from({ length: total }, (_, i) => i + 1));
        expect(result).toMatchObject({ rowCount: total, usedRows: total, truncated: false });
      }
    }
    expect(ragMaxRowsPerFile(undefined)).toBe(0);
    expect(ragMaxRowsPerFile("")).toBe(0);
    expect(ragMaxRowsPerFile("100")).toBe(100);
    expect(ragMaxRowsPerFile("not-a-number")).toBe(0);
    const saved = process.env.RAG_MAX_ROWS_PER_FILE;
    delete process.env.RAG_MAX_ROWS_PER_FILE;
    try {
      expect(parseIngestArgs(["--tag=t"]).maxRows).toBe(0);
    } finally {
      if (saved !== undefined) process.env.RAG_MAX_ROWS_PER_FILE = saved;
    }
    expect(parseIngestArgs(["--tag=t", "--max-rows=0"]).maxRows).toBe(0);
    expect(() => parseIngestArgs(["--tag=t", "--max-rows=-1"])).toThrow(/whole number/);
    // The cap stays configurable and is reported.
    const capped = await chunked("Tamilnadu agriculture yield data.csv", { maxRows: 10 });
    expect(capped).toMatchObject({ rowCount: 46, usedRows: 10, truncated: true });
    expect(capped.chunks.flatMap((c) => rowNumbers(c.text)).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it("RC-8: long-format district groups stay contiguous and are split only when too big", async () => {
    const name = "Tamilnadu agriculture yield data.csv";
    for (const maxChars of [1000, 400]) {
      const { chunks } = await chunked(name, { maxChars });
      const sequence = chunks.flatMap((c) => rowNumbers(c.text).map((n) => districtOf(name, n)));
      const runs = sequence.filter((district, i) => i === 0 || sequence[i - 1] !== district);
      expect(new Set(runs).size).toBe(runs.length); // no district comes back after another started
      // The late ERODE rows (45, 46) join the ERODE group.
      const erodeChunks = chunks.filter((c) => rowNumbers(c.text).some((n) => districtOf(name, n) === "ERODE"));
      expect(erodeChunks.flatMap((c) => rowNumbers(c.text))).toEqual(expect.arrayContaining([45, 46]));
      // A group spread over several chunks has those chunks to itself, and is bigger than maxChars.
      const preamble = chunks[0].text.split("\n").slice(0, 3).join("\n");
      for (const district of new Set(sequence)) {
        const holding = chunks.filter((c) => c.metadata.district.split(", ").includes(district));
        if (holding.length > 1) {
          holding.forEach((c) => expect(c.metadata.district).toBe(district));
          const lines = chunks.flatMap((c) => c.text.split("\n").slice(3)).filter((line) => districtOf(name, Number(line.match(/^Row (\d+):/)[1])) === district);
          expect(preamble.length + lines.reduce((sum, line) => sum + 1 + line.length, 0)).toBeGreaterThan(maxChars);
        }
      }
    }
    // One row per district (not long format): row order is kept.
    const rice = (await chunked("production_of_rice_in_2017_18.csv", { maxChars: 400 })).chunks.flatMap((c) => rowNumbers(c.text));
    expect(rice).toEqual([...rice].sort((a, b) => a - b));
  });

  it("RC-9: the frozen headerOnly rule is false for every table-v1 chunk (and true for the legacy header chunk)", async () => {
    await everyChunk((chunk) => {
      const [hit] = labelHits(QUERIES[0], [chunk.text], [chunk.metadata], [0]);
      expect(hit.headerOnly).toBe(false);
    });
    const legacy = await chunked("production_of_rice_in_2017_18.csv", { chunker: CHUNKERS.LEGACY_E9B779D, maxRows: 100 });
    const labels = labelHits(QUERIES[0], legacy.chunks.map((c) => c.text), legacy.chunks.map((c) => c.metadata), legacy.chunks.map(() => 0));
    expect(labels.map((h) => h.headerOnly)).toEqual([true, false, false, false]);
  });
});

describe("legacy chunker (e9b779d copy, evaluation only)", () => {
  it("RC-10: legacy chunker golden string, and its chunk 0 matches the frozen baseline snippet", async () => {
    const { content, rowCount, usedRows, truncated } = legacyTextFromCsv({ key: "k.csv", csvContent: "District,Area\r\nThanjavur,10\r\n\r\nMadurai,20\r\n" });
    expect(content).toBe("File: k.csv\nHeaders: District,Area\r\n\nData:\nRow 1: Thanjavur,10\r\nRow 2: Madurai,20\r\n");
    expect({ rowCount, usedRows, truncated }).toEqual({ rowCount: 2, usedRows: 2, truncated: false });

    const long = ["n,v", ...Array.from({ length: 150 }, (_, i) => `${i + 1},x`)].join("\n");
    const capped = legacyTextFromCsv({ key: "l.csv", csvContent: long, maxRows: 100 });
    expect(capped.content).toContain("Row 100: 100,x\n");
    expect(capped.content).not.toContain("Row 101:");
    expect(capped).toMatchObject({ rowCount: 150, usedRows: 100, truncated: true });
    expect(legacyTextFromCsv({ key: "l.csv", csvContent: long, maxRows: 0 }).content).toContain("Row 150: 150,x\n");

    const name = "production_of_rice_in_2017_18.csv";
    const { chunks } = await legacyChunks({ key: name, csvContent: fixture(name), maxRows: 100, bucket: "b" });
    const header = fixture(name).split("\n")[0];
    expect(chunks[0].text).toBe(`File: ${name}\nHeaders: ${header}`);
    expect(chunks[1].text.startsWith("Data:\nRow 1: 1,TamilNadu,Ariyalur,")).toBe(true);
    expect(chunks.map((c) => c.text.length)).toEqual([259, 960, 983, 468]);
    expect(chunks.map((c) => c.metadata)).toEqual(chunks.map((_, i) => ({ source: `s3://b/${name}`, chunk_index: i, filename: name })));
    // Same text format as the production collection: the baseline's A1 rank-1 hit is this header chunk.
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    const a1 = baseline.rows.find((r) => r.id === "A1").hits[0];
    expect(a1).toMatchObject({ filename: name, chunkIndex: 0, headerOnly: true });
    expect(labelHits(QUERIES[0], [chunks[0].text], [chunks[0].metadata], [0])[0].snippet).toBe(a1.snippet);
  });

  const gitHasLegacy = (() => {
    try {
      execFileSync("git", ["cat-file", "-e", "e9b779d^{commit}"], { cwd: root, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!gitHasLegacy)("RC-10: the legacy text block is a verbatim copy of e9b779d:rag/ingest.js lines 54-64", () => {
    const original = execFileSync("git", ["show", "e9b779d:rag/ingest.js"], { cwd: root }).toString().split("\n").slice(53, 64).join("\n");
    const copy = readFileSync(join(root, "scripts", "live", "lib", "legacyChunker.e9b779d.js"), "utf8");
    const block = copy.split("// <verbatim:e9b779d:rag/ingest.js:54-64>\n")[1].split("\n// </verbatim:e9b779d:rag/ingest.js:54-64>")[0];
    expect(original).toContain("index < 100");
    expect(block).toBe(original.replace("index < 100", "index < limit"));
  });
});

describe("local index", () => {
  it("RC-11: squared-L2 ranking with index-order tie-break, Chroma-shaped results, and SHA256SUMS verification", async () => {
    const dir = join(tmp(), "idx");
    const chunks = ["a", "b", "c", "d"].map((id, i) => ({ id, text: `doc ${id}`, metadata: { filename: `${id}.csv`, chunk_index: i } }));
    const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 0.5], [2, 0, 0]];
    const written = await writeLocalIndex(dir, { chunks, vectors, manifest: { tag: "t" } });
    expect(written).toMatchObject({ count: 4, dimension: 3 });

    const index = loadLocalIndex(dir);
    expect(index.manifestSha256).toBe(written.manifestSha256);
    expect(index.manifest).toMatchObject({ tag: "t", count: 4, dimension: 3, distance: "squared_l2" });
    expect(await index.count()).toBe(4);
    const result = await index.query({ queryEmbeddings: [[0, 0, 0]], nResults: 4, include: ["documents", "metadatas", "distances"] });
    expect(result.ids).toEqual([["c", "a", "b", "d"]]); // a and b tie at 1: index order
    expect(result.distances).toEqual([[0.25, 1, 1, 4]]);
    expect(result.documents[0][0]).toBe("doc c");
    expect(result.metadatas[0][0]).toEqual({ filename: "c.csv", chunk_index: 2 });
    // From [1, 0, 0]: a 0, d 1, c 1.25, b 2.
    const near = await index.query({ queryEmbeddings: [[1, 0, 0]], nResults: 3 });
    expect(near.ids).toEqual([["a", "d", "c"]]);
    expect(near.distances).toEqual([[0, 1, 1.25]]);
    const page = await index.get({ include: ["metadatas"], limit: 2, offset: 1 });
    expect(page.ids).toEqual(["b", "c"]);
    expect(page.metadatas.map((m) => m.filename)).toEqual(["b.csv", "c.csv"]);
    expect(page.documents).toBeUndefined();
    expect((await index.get({ include: ["embeddings"], ids: ["d"] })).embeddings).toEqual([[2, 0, 0]]);
    expect(() => rankBySquaredL2(new Float32Array(3), 1, 3, [1, 2], 1)).toThrow(/dimension/);

    // Any change to a file fails verification.
    writeFileSync(join(dir, "chunks.jsonl"), readFileSync(join(dir, "chunks.jsonl"), "utf8").replace("doc a", "doc A"));
    expect(() => loadLocalIndex(dir)).toThrow(/does not match SHA256SUMS/);
  });
});

describe("read-only S3 and production-write guards", () => {
  const fakeClient = () => {
    const sent = [];
    return { sent, send: async (command) => { sent.push(command.constructor.name); return { ok: true }; } };
  };

  it("RC-12: the S3 guard allows only GetObject/HeadObject on allow-listed keys; the cloud target needs explicit flags and never mixes chunkers", async () => {
    const client = fakeClient();
    const s3 = createReadOnlyS3(client, { bucket: "kb", allowList: ["a.csv", "uploads/x.csv", "claims/c.csv"] });
    await expect(s3.send(new GetObjectCommand({ Bucket: "kb", Key: "a.csv" }))).resolves.toEqual({ ok: true });
    await expect(s3.send(new HeadObjectCommand({ Bucket: "kb", Key: "a.csv" }))).resolves.toEqual({ ok: true });
    await expect(s3.send(new PutObjectCommand({ Bucket: "kb", Key: "a.csv", Body: "x" }))).rejects.toThrow(/not allowed/);
    await expect(s3.send(new DeleteObjectCommand({ Bucket: "kb", Key: "a.csv" }))).rejects.toThrow(/not allowed/);
    await expect(s3.send(new ListObjectsV2Command({ Bucket: "kb" }))).rejects.toThrow(/not allowed/);
    await expect(s3.send({ constructor: { name: "GetObjectCommand" }, input: { Bucket: "kb", Key: "a.csv" } })).rejects.toThrow(/not allowed/);
    await expect(s3.send(new GetObjectCommand({ Bucket: "kb", Key: "b.csv" }))).rejects.toThrow(/allow-list/);
    await expect(s3.send(new GetObjectCommand({ Bucket: "kb", Key: "uploads/x.csv" }))).rejects.toThrow(/uploads\/ or claims\//);
    await expect(s3.send(new GetObjectCommand({ Bucket: "kb", Key: "claims/c.csv" }))).rejects.toThrow(/uploads\/ or claims\//);
    await expect(s3.send(new GetObjectCommand({ Bucket: "other", Key: "a.csv" }))).rejects.toThrow(/bucket/);
    expect(client.sent).toEqual(["GetObjectCommand", "HeadObjectCommand"]);
    expect(s3.calls).toEqual([{ command: "GetObjectCommand", key: "a.csv" }, { command: "HeadObjectCommand", key: "a.csv" }]);

    // The allow-list: the 60 files of the frozen baseline; 57 CSVs are used, the KML and two XLS are excluded.
    const allow = loadAllowList();
    expect(allow.keys).toHaveLength(60);
    expect(allow.csv).toHaveLength(57);
    expect(allow.excluded.map((e) => e.key).sort()).toEqual(["horizontal_crop_vertical_year_report (1).xls", "horizontal_year_vertical_crop_report.xls", "tamil-nadu.kml"]);
    const badList = join(tmp(), "bad.json");
    writeFileSync(badList, JSON.stringify({ corpus: { chunksByFile: { "a.csv": 1, "uploads/u.csv": 1 } } }));
    expect(() => loadAllowList(badList)).toThrow(/upload or claim keys/);

    // A hermetic build: fake S3 serves fixtures for an allow-list, fake embeddings; only Head/Get are sent.
    const listPath = join(tmp(), "allow.json");
    const keys = ["neem.csv", "production_of_rice_in_2017_18.csv", "tamil-nadu.kml"];
    writeFileSync(listPath, JSON.stringify({ corpus: { chunksByFile: Object.fromEntries(keys.map((k) => [k, 1])) } }));
    const served = [];
    const fakeS3 = {
      send: async (command) => {
        served.push(`${command.constructor.name}:${command.input.Key}`);
        const bytes = readFileSync(join(FIXTURES, command.input.Key));
        if (command instanceof HeadObjectCommand) return { ContentLength: bytes.length, ETag: '"e"' };
        return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
      },
    };
    let embedded = 0;
    const embeddings = { embedDocuments: async (texts) => texts.map((t, i) => { embedded += 1; return [t.length, i, 1]; }) };
    const indexRoot = tmp();
    const options = parseBuildArgs([`--allow-list=${listPath}`, "--tag=fixture-build", "--max-rows=0"]);
    const { summary, written } = await buildLocalIndex(options, { s3: fakeS3, embeddings, bucket: "fixture-bucket", indexRoot });
    expect(served).toEqual(["HeadObjectCommand:neem.csv", "GetObjectCommand:neem.csv", "HeadObjectCommand:production_of_rice_in_2017_18.csv", "GetObjectCommand:production_of_rice_in_2017_18.csv"]);
    expect(summary.excluded).toEqual([{ key: "tamil-nadu.kml", reason: expect.stringMatching(/kml/) }]);
    expect(embedded).toBe(summary.counts.chunks);
    const index = loadLocalIndex(join(indexRoot, "fixture-build"));
    expect(await index.count()).toBe(summary.counts.chunks);
    expect(index.manifest).toMatchObject({ chunker: "table-v1", inputType: "search_document", maxRows: 0, files: [{ key: "neem.csv", etag: '"e"' }, { key: "production_of_rice_in_2017_18.csv" }] });
    expect(written.manifestSha256).toBe(index.manifestSha256);
    const dry = await buildLocalIndex(parseBuildArgs([`--allow-list=${listPath}`, "--dry-run", "--max-rows=0"]), { s3: fakeS3, embeddings: { embedDocuments: async () => { throw new Error("dry run must not embed"); } }, bucket: "fixture-bucket", indexRoot });
    expect(dry.summary).toMatchObject({ dryRun: true, counts: { chunks: summary.counts.chunks } });
    expect(() => parseBuildArgs(["--source-dir=tests/fixtures/rag", "--tag=x"])).toThrow(/dry runs/);
    expect(() => parseBuildArgs(["--corpus=baseline60", "--tag=x"])).toThrow(/legacy-e9b779d/);
    expect(() => parseBuildArgs([])).toThrow(/--tag/);

    // The Chroma Cloud target is opt-in twice over, and the default collection is unchanged.
    expect(parseIngestArgs(["--tag=t"]).target).toBe("local");
    expect(() => parseIngestArgs([])).toThrow(/--tag/);
    expect(() => parseIngestArgs(["--target=chroma-cloud"])).toThrow(/--collection/);
    expect(() => parseIngestArgs(["--target=chroma-cloud", "--collection=rag-table-v1"])).toThrow(/--confirm-production-write/);
    expect(parseIngestArgs(["--target=chroma-cloud", "--collection=rag-table-v1", "--confirm-production-write"])).toMatchObject({ target: "chroma-cloud", collection: "rag-table-v1" });
    expect(DEFAULT_RAG_COLLECTION).toBe("farming-documents");
    expect(ragCollectionName(undefined)).toBe("farming-documents");
    expect(ragCollectionName("  ")).toBe("farming-documents");
    expect(ragCollectionName("rag-table-v1")).toBe("rag-table-v1");
    expect(() => ragCollectionName("bad name!")).toThrow(/not a valid/);

    const collection = (metadatas) => {
      const upserts = [];
      return {
        upserts,
        count: async () => metadatas.length,
        get: async ({ limit, offset }) => ({ metadatas: metadatas.slice(offset, offset + limit) }),
        upsert: async (batch) => { upserts.push(batch); },
      };
    };
    const production = collection([{ filename: "a.csv", chunk_index: 0 }]); // legacy chunks carry no chunker label
    await expect(assertNoMixedChunkers(production, "table-v1")).rejects.toThrow(/refusing to mix/);
    await expect(writeChromaCloud({ collection: production, chunks: [{ id: "x", text: "t", metadata: {} }], vectors: [[1]], chunker: "table-v1" })).rejects.toThrow(/refusing to mix/);
    expect(production.upserts).toEqual([]);
    const fresh = collection([]);
    await writeChromaCloud({ collection: fresh, chunks: [{ id: "x", text: "t", metadata: { chunker: "table-v1" } }], vectors: [[1]], chunker: "table-v1" });
    expect(fresh.upserts).toHaveLength(1);
    await expect(assertNoMixedChunkers(collection([{ chunker: "table-v1" }]), "table-v1")).resolves.toBe(1);
  });

  // Chroma and S3 write (or bucket-listing) calls. createHash(...).update( is hashing, not a write.
  const WRITE_CALL = /\.(upsert|add|delete|modify|update|reset)\(|\b(create|getOrCreate|delete|fork)Collection\b|\b(Put|Delete|Copy|Upload|Restore|Create)\w*Command\b|\bListObjects\w*\b|\bnew Upload\(/g;
  const writeCalls = (code) => [...code.replace(/createHash\([^)]*\)\.update\(/g, "createHash().digestOf(").matchAll(WRITE_CALL)].map((m) => m[0]);
  // The only allowed ones: rag/ingest.js's Chroma Cloud target (writeChromaCloud and
  // openCloudCollection, gated by --target=chroma-cloud --collection --confirm-production-write and
  // never used, D3) and its own bucket listing for `npm run ingest` (a read; the evaluation builder
  // never lists the bucket).
  const ALLOWED_IN_INGEST = [
    { start: "export async function listAllObjects(", end: "\n}\n", calls: ["ListObjectsV2Command"] },
    { start: "export const writeChromaCloud = async", end: "\n};\n", calls: [".upsert("] },
    { start: "const openCloudCollection = async", end: "\n};\n", calls: ["createCollection"] },
  ];

  it("RC-12: no RAG build or evaluation file makes a Chroma or S3 write call outside the gated cloud target in rag/ingest.js", () => {
    const files = [
      ...readdirSync(join(root, "rag")).filter((f) => f.endsWith(".js")).map((f) => `rag/${f}`),
      ...readdirSync(join(root, "scripts", "live")).filter((f) => /^(rag\w*(\.live)?|verifyRagSpec)\.js$/.test(f)).map((f) => `scripts/live/${f}`),
      "scripts/live/lib/ragEvalSpec.js",
      "scripts/live/lib/legacyChunker.e9b779d.js",
    ];
    for (const rel of ["rag/buildLocalIndex.js", "rag/localIndex.js", "rag/ingest.js", "scripts/live/ragRetrieval.live.js", "scripts/live/ragEmbedQueries.js", "scripts/live/ragSnapshotProd.js", "scripts/live/ragParity.js", "scripts/live/ragCompare.js"]) {
      expect(files).toContain(rel);
    }
    // The scanner itself finds what it must.
    expect(writeCalls('await collection.upsert({ ids });\ncollection.add({}); client.getOrCreateCollection({ name });\ns3.send(new PutObjectCommand({}));\nnew DeleteObjectsCommand({}); new ListObjectsV2Command({}); createHash("sha256").update(x)')).toEqual([".upsert(", ".add(", "getOrCreateCollection", "PutObjectCommand", "DeleteObjectsCommand", "ListObjectsV2Command"]);

    for (const rel of files) {
      let code = codeOf(rel);
      if (rel === "rag/ingest.js") {
        // The import line names ListObjectsV2Command for listAllObjects.
        code = code.replace(/^import \{[^}]*\} from "@aws-sdk\/client-s3";$/m, (line) => {
          expect(writeCalls(line)).toEqual(["ListObjectsV2Command"]);
          return "";
        });
        for (const { start, end, calls } of ALLOWED_IN_INGEST) {
          const from = code.indexOf(start);
          expect(from, `${rel}: ${start}`).toBeGreaterThanOrEqual(0);
          const to = code.indexOf(end, from) + end.length;
          expect(writeCalls(code.slice(from, to)), `${rel}: ${start}`).toEqual(calls);
          code = code.slice(0, from) + code.slice(to);
        }
      }
      expect(writeCalls(code), rel).toEqual([]);
    }
    // The evaluation builder reads by key and never lists the bucket.
    expect(codeOf("rag/buildLocalIndex.js")).not.toMatch(/listAllObjects/);
  });

  it("RC-12: the production snapshot's collection handle passes only count() and get()", async () => {
    const reached = [];
    const inner = Object.fromEntries(["count", "get", "query", "upsert", "add", "update", "delete", "modify"].map((name) => [name, async (...args) => { reached.push(name); return name === "count" ? 450 : { ids: ["a"], args }; }]));
    const handle = readOnlyCollection(inner);
    await expect(handle.count()).resolves.toBe(450);
    await expect(handle.get({ include: ["metadatas"], limit: 1, offset: 0 })).resolves.toEqual({ ids: ["a"], args: [{ include: ["metadatas"], limit: 1, offset: 0 }] });
    for (const method of ["upsert", "add", "update", "delete", "modify", "query"]) {
      expect(() => handle[method]({ ids: ["x"] }), method).toThrow(/Read-only snapshot: collection\.\w+ is not allowed/);
    }
    expect(reached).toEqual(["count", "get"]);
  });
});

describe("write-once", () => {
  it("RC-13: writeOnce refuses an existing path, and neither an index nor a build overwrites one", async () => {
    const dir = tmp();
    const path = join(dir, "result.json");
    writeResultOnce(path, "first\n");
    let error;
    try {
      writeResultOnce(path, "second\n");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ResultExistsError);
    expect(error.exitCode).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("first\n");

    const indexDir = join(dir, "idx");
    const chunks = [{ id: "a", text: "Row 1: x", metadata: {} }];
    await writeLocalIndex(indexDir, { chunks, vectors: [[1, 2]] });
    const before = readFileSync(join(indexDir, "manifest.json"), "utf8");
    await expect(writeLocalIndex(indexDir, { chunks, vectors: [[3, 4]] })).rejects.toBeInstanceOf(ResultExistsError);
    expect(readFileSync(join(indexDir, "manifest.json"), "utf8")).toBe(before);

    const indexRoot = tmp();
    mkdirSync(join(indexRoot, "taken"));
    writeFileSync(join(indexRoot, "taken", "manifest.json"), "{}");
    const s3 = { send: async () => { throw new Error("must not read S3"); } };
    await expect(buildLocalIndex(parseBuildArgs(["--tag=taken"]), { s3, bucket: "kb", indexRoot })).rejects.toMatchObject({ exitCode: 2 });
  });

  const RETRIEVAL = "scripts/live/ragRetrieval.live.js";

  it("RC-13: ragRetrieval refuses the frozen date without a tag and an incomplete json run, and leaves the baseline untouched", () => {
    const frozen = ["json", "md"].map((ext) => join(root, "docs", "research", "evaluation", "live", `rag_retrieval_2026-10-16.${ext}`));
    const before = frozen.map(fileSha256);
    const out = join(tmp(), "out");

    const frozenDate = runScript(RETRIEVAL, ["--date=2026-10-16"]);
    expect(frozenDate.status, frozenDate.stderr).toBe(2);
    expect(frozenDate.stderr).toMatch(/--date=2026-10-16 is the frozen baseline; pass --tag/);
    const frozenJson = runScript(RETRIEVAL, ["--date=2026-10-16", "--backend=json", "--index=x", "--query-vectors=y"]);
    expect(frozenJson.status).toBe(1);
    expect(frozenJson.stderr).toMatch(/--backend=json needs --tag/);

    for (const [args, message] of [
      [["--backend=json", `--out-dir=${out}`], /--backend=json needs --tag/],
      [["--backend=json", "--tag=t", `--out-dir=${out}`], /needs --index/],
      [["--backend=json", "--tag=t", "--index=x", `--out-dir=${out}`], /needs --query-vectors/],
      [["--backend=json", "--tag=../escape", "--index=x", "--query-vectors=y", `--out-dir=${out}`], /--tag must be/],
    ]) {
      const run = runScript(RETRIEVAL, ["--date=2026-10-20", ...args]);
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.stderr, args.join(" ")).toMatch(message);
    }
    expect(existsSync(out)).toBe(false);
    expect(frozen.map(fileSha256)).toEqual(before);
  });

  it("RC-13: a hermetic json run writes once, a re-run exits 2 without touching it, and stale query vectors are refused", async () => {
    const work = tmp();
    const indexDir = join(work, "index");
    const rice = "production_of_rice_in_2017_18.csv";
    const chunks = [
      { id: "r0", text: `File: ${rice}\nHeaders: S.No,District,Total`, metadata: { filename: rice, chunk_index: 0 } },
      { id: "r1", text: `File: ${rice}\nTable: production of rice in 2017 18\nColumns: District, Total\nRow 25: District: Thanjavur; Total: 9`, metadata: { filename: rice, chunk_index: 1 } },
      { id: "y0", text: "File: Tamilnadu agriculture yield data.csv\nRow 9: District_Name: ERODE; Crop: Sugarcane", metadata: { filename: "Tamilnadu agriculture yield data.csv", chunk_index: 0 } },
      { id: "n0", text: "File: neem.csv\nRow 1: District: Madurai; Area: 3", metadata: { filename: "neem.csv", chunk_index: 0 } },
      { id: "k0", text: "Placemark Salem", metadata: { filename: "tamil-nadu.kml", chunk_index: 0 } },
      { id: "n1", text: "File: neem.csv\nRow 2: District: Theni; Area: 4", metadata: { filename: "neem.csv", chunk_index: 1 } },
    ];
    const vectors = [[1, 0, 0], [0.9, 0.1, 0], [0, 1, 0], [0.5, 0.5, 0], [0, 0, 1], [0.2, 0.2, 0.2]];
    const index = await writeLocalIndex(indexDir, { chunks, vectors, manifest: { tag: "rc13-fixture", chunker: "fixture" } });
    const cache = { model: "embed-english-v3.0", inputType: "search_query", queries: QUERIES.map((q, i) => ({ id: q.id, qSha256: sha256(q.q), vector: [1, i / QUERIES.length, 0] })) };
    const vectorsPath = join(work, "query_vectors.json");
    writeFileSync(vectorsPath, JSON.stringify(cache));
    const out = join(work, "out");
    const args = ["--date=2026-10-20", "--backend=json", "--tag=rc13", `--index=${indexDir}`, `--query-vectors=${vectorsPath}`, `--out-dir=${out}`];

    const first = runScript(RETRIEVAL, args);
    expect(first.status, first.stderr).toBe(0);
    const outputs = ["json", "md"].map((ext) => join(out, `rag_retrieval_2026-10-20_rc13.${ext}`));
    const result = JSON.parse(readFileSync(outputs[0], "utf8"));
    const pin = readProvenance().spec.specSha256;
    expect(result).toMatchObject({ backend: "json", tag: "rc13", condition: "rc13", specSha256: pin, specPinned: true, pinnedSpecSha256: pin, indexManifestSha256: index.manifestSha256, queryVectorsSha256: fileSha256(vectorsPath) });
    expect(result.queries).toEqual({ total: 22, answerable: 13, advisory: 9, errors: 0 });
    expect(result.corpus).toMatchObject({ chunks: 6, files: 4 });
    expect(result.rows.map((row) => row.id)).toEqual(QUERIES.map((q) => q.id));
    expect(result.rows.every((row) => row.embedMs === null && row.hits.length === 5)).toBe(true);
    expect(readFileSync(outputs[1], "utf8")).toMatch(/matches the pin/);
    const written = outputs.map(fileSha256);

    const again = runScript(RETRIEVAL, args);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/Refusing to overwrite existing result file/);
    expect(outputs.map(fileSha256)).toEqual(written);
    expect(readdirSync(out).sort()).toEqual(["rag_retrieval_2026-10-20_rc13.json", "rag_retrieval_2026-10-20_rc13.md"]);

    // A cache that no longer matches the frozen queries, or was made for documents, is refused.
    for (const [tag, edit, message] of [
      ["stale", (c) => { c.queries[3].qSha256 = sha256("another question"); }, /do not match the frozen query A4/],
      ["doctype", (c) => { c.inputType = "search_document"; }, /expected search_query/],
    ]) {
      const bad = structuredClone(cache);
      edit(bad);
      const badPath = join(work, `${tag}.json`);
      writeFileSync(badPath, JSON.stringify(bad));
      const run = runScript(RETRIEVAL, ["--date=2026-10-20", "--backend=json", `--tag=${tag}`, `--index=${indexDir}`, `--query-vectors=${badPath}`, `--out-dir=${out}`]);
      expect(run.status, tag).toBe(1);
      expect(run.stderr, tag).toMatch(message);
    }
    expect(readdirSync(out)).toHaveLength(2);
  });

  it("RC-13: every RAG result script writes through writeOnce and checks for an existing output before any provider call or input read", () => {
    const WORK = [/new CloudClient\(/, /new CohereEmbeddings\(/, /\.embedQuery\(/, /\.getCollection\(/, /loadLocalIndex\(/, /readFileSync\(/, /write(Json|Result)Once\(/, /writeLocalIndex\(/];
    const scripts = {
      "scripts/live/ragRetrieval.live.js": /if \(existsSync\(path\)\) fail\(new ResultExistsError\(path\)\.message, 2\)/,
      "scripts/live/ragEmbedQueries.js": /if \(existsSync\(outPath\)\) \{\s*console\.error\(new ResultExistsError\(outPath\)\.message\);\s*process\.exit\(2\);/,
      "scripts/live/ragSnapshotProd.js": /if \(existsSync\(outDir\) && readdirSync\(outDir\)\.length > 0\) fail\([^;]*, 2\);/,
      "scripts/live/ragParity.js": /if \(existsSync\(outPath\)\) \{\s*console\.error\(new ResultExistsError\(outPath\)\.message\);\s*process\.exit\(2\);/,
      "scripts/live/ragCompare.js": /if \(existsSync\(path\)\) \{\s*console\.error\(new ResultExistsError\(path\)\.message\);\s*process\.exit\(2\);/,
    };
    for (const [rel, check] of Object.entries(scripts)) {
      const code = codeOf(rel);
      expect(code, rel).toMatch(/from "\.\/lib\/writeOnce\.js"/);
      expect(code, rel).not.toMatch(/\b(writeFileSync|appendFileSync|createWriteStream)\(/);
      const at = code.search(check);
      expect(at, `${rel}: existing-output check`).toBeGreaterThan(0);
      for (const marker of WORK) {
        const first = code.search(marker);
        if (first >= 0) expect(first, `${rel}: ${marker} comes after the existing-output check`).toBeGreaterThan(at);
      }
    }
    // The snapshot is owner-gated before anything else runs.
    const snapshot = codeOf("scripts/live/ragSnapshotProd.js");
    expect(snapshot.indexOf('process.argv.includes("--allow-prod-read")')).toBeLessThan(snapshot.search(scripts["scripts/live/ragSnapshotProd.js"]));
  });
  it("RC-14: the S3 guard refuses the literal uploads/ and claims/ prefixes whatever the configured upload prefix is", async () => {
    for (const prefix of ["uploads", "farmer-uploads", "/custom/"]) {
      for (const key of ["uploads/u1/img_1/image.jpg", "uploads", "claims/c1/img_1/image.png", "/claims/x", "claims"]) {
        expect({ prefix, key, forbidden: isForbiddenKey(key, prefix) }).toEqual({ prefix, key, forbidden: true });
      }
      expect(isForbiddenKey("datasets/rice.csv", prefix)).toBe(false);
      expect(isForbiddenKey("uploads-archive/rice.csv", prefix)).toBe(false);
    }
    expect(isForbiddenKey("farmer-uploads/u1/image.jpg", "farmer-uploads")).toBe(true);
    expect(isForbiddenKey("farmer-uploads/u1/image.jpg", "uploads")).toBe(false);
    // The read-only client refuses them even if a bad allow-list carried one.
    const s3 = createReadOnlyS3({ send: async () => ({}) }, { bucket: "kb", allowList: ["uploads/u1/img_1/image.jpg", "claims/c1/x.png"], uploadPrefix: "farmer-uploads" });
    await expect(s3.send(new GetObjectCommand({ Bucket: "kb", Key: "uploads/u1/img_1/image.jpg" }))).rejects.toThrow(/under uploads\/ or claims\//);
    await expect(s3.send(new HeadObjectCommand({ Bucket: "kb", Key: "claims/c1/x.png" }))).rejects.toThrow(/under uploads\/ or claims\//);
    expect(s3.calls).toEqual([]);
  });

  it("RC-15: --corpus=baseline60 rebuilds the production corpus with the e9b779d 100-row cap unless --max-rows is given", () => {
    expect(BASELINE60_MAX_ROWS).toBe(100);
    expect(parseBuildArgs(["--corpus=baseline60", "--chunker=legacy-e9b779d", "--tag=parity"]).maxRows).toBe(100);
    expect(parseBuildArgs(["--corpus=baseline60", "--chunker=legacy-e9b779d", "--tag=parity", "--max-rows=0"]).maxRows).toBe(0);
    expect(parseBuildArgs(["--corpus=baseline60", "--chunker=legacy-e9b779d", "--tag=parity", "--max-rows=250"]).maxRows).toBe(250);
    // Every other build keeps RAG_MAX_ROWS_PER_FILE (default 0 = no cap).
    expect(parseBuildArgs(["--tag=table"]).maxRows).toBe(ragMaxRowsPerFile());
    expect(parseBuildArgs(["--chunker=legacy-e9b779d", "--tag=legacy"]).maxRows).toBe(ragMaxRowsPerFile());
    expect(() => parseBuildArgs(["--corpus=baseline60", "--chunker=legacy-e9b779d", "--tag=parity", "--max-rows=abc"])).toThrow(/--max-rows/);
  });

  it("RC-16: ragParity and ragCompare validate --date and --tag like ragRetrieval (exit 64 before reading anything); chat logs the configured collection", () => {
    expect(runLabelProblem({ date: "2026-10-20" })).toBeNull();
    expect(runLabelProblem({ date: "2026-10-20", tag: "table-v1.r2" })).toBeNull();
    for (const [label, problem] of [
      [{ date: "20-10-2026" }, /--date must be YYYY-MM-DD/],
      [{ date: "2026-13-40" }, /--date must be YYYY-MM-DD/],
      [{ date: "2026-10-20/../x" }, /--date must be YYYY-MM-DD/],
      [{ date: "2026-10-20", tag: "../escape" }, /--tag must be/],
      [{ date: "2026-10-20", tag: "" }, /--tag must be/],
      [{ date: "2026-10-20", tag: "a".repeat(101) }, /--tag must be/],
      [{ date: "2026-10-20", tag: "-leading" }, /--tag must be/],
    ]) {
      expect(runLabelProblem(label)).toMatch(problem);
    }
    const out = join(tmp(), "out");
    for (const [script, args] of [
      ["scripts/live/ragParity.js", ["--candidate=/nonexistent/candidate.json"]],
      ["scripts/live/ragCompare.js", ["--legacy=/nonexistent/a.json", "--table=/nonexistent/b.json"]],
    ]) {
      for (const bad of [["--date=2026-1-1"], ["--date=2026-10-20", "--tag=../../escape"], ["--date=2026-10-20", "--tag=has space"]]) {
        const run = runScript(script, [...args, ...bad, `--out-dir=${out}`]);
        expect({ script, bad, status: run.status }).toEqual({ script, bad, status: 64 });
        expect(run.stderr).toMatch(/--(date|tag) must be/);
        expect(run.stderr).not.toMatch(/ENOENT/); // refused before any input was read
      }
    }
    expect(existsSync(out)).toBe(false);
    // The chat service's connection log names the collection it actually opened (RAG_COLLECTION).
    const chat = codeOf("services/chat.service.js");
    expect(chat).toMatch(/const name = \(await import\("\.\.\/config\/ragConfig\.js"\)\)\.ragCollectionName\(\);/);
    expect(chat).toMatch(/getCollection\(\{ name \}\)/);
    expect(chat).toMatch(/logger\.info\(\{ collection: name \}, `Connected to ChromaDB collection: \$\{name\}`\)/);
    expect(chat).not.toContain("Connected to ChromaDB collection: farming-documents");
  });
});
