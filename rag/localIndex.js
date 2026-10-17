import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Local, file-based vector index for the RAG evaluation (plan A10, D3). Production Chroma is never
// written: candidate indexes and the read-only production snapshot are stored on disk under
// .rag-local/indexes/<tag>/ (gitignored) and searched here.
//
// Layout of an index directory:
//   manifest.json   how the index was built (commit, chunker, model, files, counts, dimension)
//   chunks.jsonl    one {"id","document","metadata"} per line, in index order
//   embeddings.f32  little-endian Float32, count x dimension, same order as chunks.jsonl
//   SHA256SUMS      "<sha256>  <file>" for the three files above, written last
//
// Search is exact brute force over squared L2, which is Chroma's default "l2" space (the production
// collection was created without hnsw:space). Ties are broken by index order. Cohere v3 vectors are
// unit length, so squared L2 = 2 - 2 * cosine and the ranking equals cosine ranking.

export const INDEX_FILES = Object.freeze({
  manifest: "manifest.json",
  chunks: "chunks.jsonl",
  embeddings: "embeddings.f32",
  sums: "SHA256SUMS",
});
export const INDEX_FORMAT = "vivasayi-rag-local-index/1";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export const encodeEmbeddings = (vectors, dimension) => {
  const buffer = Buffer.alloc(vectors.length * dimension * 4);
  vectors.forEach((vector, row) => {
    if (!vector || vector.length !== dimension) throw new Error(`Embedding ${row} has dimension ${vector ? vector.length : 0}, expected ${dimension}`);
    for (let column = 0; column < dimension; column += 1) {
      const value = Number(vector[column]);
      if (!Number.isFinite(value)) throw new Error(`Embedding ${row} has a non-finite value at ${column}`);
      buffer.writeFloatLE(value, (row * dimension + column) * 4);
    }
  });
  return buffer;
};

export const decodeEmbeddings = (buffer, count, dimension) => {
  if (buffer.length !== count * dimension * 4) throw new Error(`embeddings.f32 holds ${buffer.length} bytes, expected ${count * dimension * 4}`);
  const matrix = new Float32Array(count * dimension);
  for (let i = 0; i < matrix.length; i += 1) matrix[i] = buffer.readFloatLE(i * 4);
  return matrix;
};

export const squaredL2 = (matrix, row, dimension, query) => {
  let sum = 0;
  const offset = row * dimension;
  for (let column = 0; column < dimension; column += 1) {
    const delta = matrix[offset + column] - query[column];
    sum += delta * delta;
  }
  return sum;
};

// The n nearest rows: ascending distance, then ascending index.
export const rankBySquaredL2 = (matrix, count, dimension, query, n) => {
  if (!query || query.length !== dimension) throw new Error(`Query embedding has dimension ${query ? query.length : 0}, expected ${dimension}`);
  const scored = [];
  for (let index = 0; index < count; index += 1) scored.push({ index, distance: squaredL2(matrix, index, dimension, query) });
  scored.sort((a, b) => a.distance - b.distance || a.index - b.index);
  return scored.slice(0, Math.max(0, n));
};

export const formatSums = (hashes) =>
  Object.keys(hashes)
    .sort()
    .map((name) => `${hashes[name]}  ${name}\n`)
    .join("");

export const parseSums = (text) => {
  const sums = {};
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match) throw new Error(`Malformed SHA256SUMS line: ${line}`);
    sums[match[2]] = match[1];
  }
  return sums;
};

// Writes a new index directory. Write-once: every file is created with the `wx` flag
// (scripts/live/lib/writeOnce.js), and an existing, non-empty directory is refused up front so an
// index is never partly overwritten. Returns the manifest sha256, which results record.
export const writeLocalIndex = async (dir, { chunks, vectors, manifest = {} }) => {
  if (!Array.isArray(chunks) || !Array.isArray(vectors) || chunks.length !== vectors.length) {
    throw new Error("writeLocalIndex needs as many vectors as chunks");
  }
  if (chunks.length === 0) throw new Error("writeLocalIndex refuses an empty index");
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    const { ResultExistsError } = await import("../scripts/live/lib/writeOnce.js");
    throw new ResultExistsError(dir);
  }
  const ids = chunks.map((chunk) => chunk.id);
  if (new Set(ids).size !== ids.length) throw new Error("writeLocalIndex found duplicate chunk ids");
  const dimension = vectors[0].length;
  const { writeResultOnce } = await import("../scripts/live/lib/writeOnce.js");

  const chunksText = chunks.map((chunk) => JSON.stringify({ id: chunk.id, document: chunk.text, metadata: chunk.metadata || {} })).join("\n") + "\n";
  const embeddings = encodeEmbeddings(vectors, dimension);
  const fullManifest = { format: INDEX_FORMAT, ...manifest, count: chunks.length, dimension, distance: "squared_l2" };
  const manifestText = `${JSON.stringify(fullManifest, null, 2)}\n`;

  writeResultOnce(join(dir, INDEX_FILES.chunks), chunksText);
  writeResultOnce(join(dir, INDEX_FILES.embeddings), embeddings);
  writeResultOnce(join(dir, INDEX_FILES.manifest), manifestText);
  const hashes = {
    [INDEX_FILES.chunks]: sha256(chunksText),
    [INDEX_FILES.embeddings]: sha256(embeddings),
    [INDEX_FILES.manifest]: sha256(manifestText),
  };
  writeResultOnce(join(dir, INDEX_FILES.sums), formatSums(hashes));
  return { dir, count: chunks.length, dimension, manifestSha256: hashes[INDEX_FILES.manifest] };
};

const pick = (include, name, values) => (include.includes(name) ? values : undefined);

// Loads and verifies an index directory, then exposes the subset of the Chroma collection API the
// evaluation uses: count(), get() and query(). Throws if any file is missing or fails SHA256SUMS.
export const loadLocalIndex = (dir) => {
  const sumsPath = join(dir, INDEX_FILES.sums);
  if (!existsSync(sumsPath)) throw new Error(`No ${INDEX_FILES.sums} in ${dir}`);
  const sums = parseSums(readFileSync(sumsPath, "utf8"));
  const raw = {};
  for (const name of [INDEX_FILES.manifest, INDEX_FILES.chunks, INDEX_FILES.embeddings]) {
    if (!sums[name]) throw new Error(`${INDEX_FILES.sums} does not list ${name}`);
    const data = readFileSync(join(dir, name));
    if (sha256(data) !== sums[name]) throw new Error(`${name} in ${dir} does not match ${INDEX_FILES.sums}`);
    raw[name] = data;
  }
  const manifest = JSON.parse(raw[INDEX_FILES.manifest].toString("utf8"));
  const rows = raw[INDEX_FILES.chunks].toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const count = rows.length;
  const dimension = Number(manifest.dimension);
  if (count !== manifest.count) throw new Error(`chunks.jsonl has ${count} rows, manifest says ${manifest.count}`);
  const matrix = decodeEmbeddings(raw[INDEX_FILES.embeddings], count, dimension);
  const vectorOf = (index) => Array.from(matrix.subarray(index * dimension, (index + 1) * dimension));

  return {
    dir,
    manifest,
    manifestSha256: sums[INDEX_FILES.manifest],
    dimension,
    async count() {
      return count;
    },
    async get({ include = ["documents", "metadatas"], limit, offset = 0, ids } = {}) {
      let selected = rows.map((row, index) => ({ row, index }));
      if (Array.isArray(ids)) {
        const wanted = new Set(ids);
        selected = selected.filter(({ row }) => wanted.has(row.id));
      }
      selected = selected.slice(offset, limit === undefined ? undefined : offset + limit);
      return {
        ids: selected.map(({ row }) => row.id),
        documents: pick(include, "documents", selected.map(({ row }) => row.document)),
        metadatas: pick(include, "metadatas", selected.map(({ row }) => row.metadata)),
        embeddings: pick(include, "embeddings", selected.map(({ index }) => vectorOf(index))),
        include,
      };
    },
    async query({ queryEmbeddings, nResults = 10, include = ["documents", "metadatas", "distances"] }) {
      const results = queryEmbeddings.map((query) => rankBySquaredL2(matrix, count, dimension, query, nResults));
      return {
        ids: results.map((hits) => hits.map(({ index }) => rows[index].id)),
        documents: pick(include, "documents", results.map((hits) => hits.map(({ index }) => rows[index].document))),
        metadatas: pick(include, "metadatas", results.map((hits) => hits.map(({ index }) => rows[index].metadata))),
        distances: pick(include, "distances", results.map((hits) => hits.map(({ distance }) => distance))),
        embeddings: pick(include, "embeddings", results.map((hits) => hits.map(({ index }) => vectorOf(index)))),
        include,
      };
    },
  };
};

export default { writeLocalIndex, loadLocalIndex, rankBySquaredL2, INDEX_FILES };
