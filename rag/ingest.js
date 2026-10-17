import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { CohereEmbeddings } from "@langchain/cohere";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import logger from "../utils/logger.js";
import { env, validateEnv, INGEST_REQUIRED } from "../config/env.js";
import AIConfig from "../src/ai/AIConfig.js";
import { ragCollectionName, ragMaxRowsPerFile } from "../config/ragConfig.js";
import { shouldIngestKey, parseCsv, tableToChunks, chunkId, sha256Hex, CHUNKERS, DEFAULT_MAX_CHARS } from "./ingestHelpers.js";
import { writeLocalIndex } from "./localIndex.js";

export { writeLocalIndex };

// Knowledge-base ingestion (`npm run ingest`). Two targets:
//   --target=local (default): S3 knowledge CSVs -> chunks -> Cohere `search_document` embeddings ->
//     .rag-local/indexes/<tag>/ (rag/localIndex.js). Nothing is written to Chroma. Needs --tag.
//   --target=chroma-cloud: writes to a Chroma Cloud collection. Needs --collection=<name> AND
//     --confirm-production-write, and refuses a collection that already holds chunks from another
//     chunker, so two chunk formats never share a collection. Production chat keeps the existing
//     collection until the owner approves a re-ingestion (plan A10, D3); this target is not used.
// Other flags: --chunker=table-v1|legacy-e9b779d (default table-v1), --max-rows=<n> (default
// RAG_MAX_ROWS_PER_FILE, 0 = no cap), --max-chars=<n> (table-v1 chunk size, default 1000).
// rag/buildLocalIndex.js builds the evaluation indexes from a fixed allow-list of keys instead of a
// bucket listing.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_INDEX_ROOT = join(root, ".rag-local", "indexes");
export const LOCAL_REQUIRED = ["MY_AWS_ACCESS_KEY_ID", "MY_AWS_SECRET_ACCESS_KEY", "S3_BUCKET", "COHERE_API_KEY"];
export const EMBEDDING_INPUT_TYPE = "search_document"; // CohereEmbeddings.embedDocuments
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const flagValue = (argv, name) => {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  return arg === undefined ? undefined : arg.slice(name.length + 3);
};

export const parseMaxRows = (value) => {
  if (value === undefined) return ragMaxRowsPerFile();
  if (!/^\d+$/.test(String(value))) throw new Error(`--max-rows must be a whole number (0 = no cap), got "${value}"`);
  return Number(value);
};

export const assertTag = (tag) => {
  if (!tag || !TAG.test(tag)) throw new Error(`--tag must be 1-100 characters of [A-Za-z0-9._-], got "${tag ?? ""}"`);
  return tag;
};

export const parseIngestArgs = (argv = []) => {
  const target = flagValue(argv, "target") || "local";
  const chunker = flagValue(argv, "chunker") || CHUNKERS.TABLE_V1;
  const maxChars = flagValue(argv, "max-chars") === undefined ? DEFAULT_MAX_CHARS : Number(flagValue(argv, "max-chars"));
  const options = {
    target,
    chunker,
    maxRows: parseMaxRows(flagValue(argv, "max-rows")),
    maxChars,
    tag: flagValue(argv, "tag"),
    collection: flagValue(argv, "collection"),
    confirmProductionWrite: argv.includes("--confirm-production-write"),
  };
  if (!["local", "chroma-cloud"].includes(target)) throw new Error(`--target must be local or chroma-cloud, got "${target}"`);
  if (!Object.values(CHUNKERS).includes(chunker)) throw new Error(`--chunker must be one of ${Object.values(CHUNKERS).join(", ")}, got "${chunker}"`);
  if (!Number.isInteger(maxChars) || maxChars < 200) throw new Error("--max-chars must be a whole number of at least 200");
  if (target === "local") assertTag(options.tag);
  if (target === "chroma-cloud") {
    if (!options.collection) throw new Error("--target=chroma-cloud needs an explicit --collection=<name>");
    options.collection = ragCollectionName(options.collection);
    if (!options.confirmProductionWrite) throw new Error("--target=chroma-cloud writes to Chroma Cloud; pass --confirm-production-write to allow it");
  }
  return options;
};

// Lists every key in the bucket (paged). Only used by this script's own runs; the evaluation builder
// never lists the bucket.
export async function listAllObjects(s3, bucketName) {
  const keys = [];
  let ContinuationToken;
  while (true) {
    const response = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken }));
    if (response.Contents) keys.push(...response.Contents.map((item) => item.Key));
    if (!response.IsTruncated) break;
    ContinuationToken = response.NextContinuationToken;
  }
  return keys.filter(Boolean);
}

// Reads one object. The bytes are decoded exactly as `Body.transformToString()` does (Buffer utf8,
// byte order mark kept), which is how every earlier ingestion read the files.
export const loadObjectText = async (s3, bucket, key) => {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  return { text: bytes.toString("utf8"), bytes: bytes.length, sha256: sha256Hex(bytes) };
};

// One file -> chunks [{id, text, metadata}]. maxRows 0 means every row. A file with a header and no
// data rows yields no chunks under table-v1 (never a header-only chunk).
export const chunkFile = async ({ key, text, chunker = CHUNKERS.TABLE_V1, maxRows = 0, maxChars = DEFAULT_MAX_CHARS, bucket = "", fileSha256 = sha256Hex(String(text ?? "")) }) => {
  if (chunker === CHUNKERS.TABLE_V1) {
    const parsed = parseCsv(text);
    if (parsed.length === 0) return { chunks: [], rowCount: 0, usedRows: 0, truncated: false };
    const [headers, ...data] = parsed;
    const used = maxRows > 0 ? data.slice(0, maxRows) : data;
    const chunks = tableToChunks({ key, headers, rows: used, maxChars, bucket, fileSha256 });
    return { chunks, rowCount: data.length, usedRows: used.length, truncated: data.length > used.length };
  }
  if (chunker === CHUNKERS.LEGACY_E9B779D) {
    // Evaluation-only copy of the format that built the production collection; loaded on demand so
    // the production ingestion path never depends on scripts/live.
    const { legacyChunks } = await import("../scripts/live/lib/legacyChunker.e9b779d.js");
    const result = await legacyChunks({ key, csvContent: String(text ?? ""), maxRows, bucket });
    const chunks = result.chunks.map((chunk) => ({
      id: chunkId({ key, index: chunk.metadata.chunk_index, text: chunk.text }),
      text: chunk.text,
      metadata: { ...chunk.metadata, chunker: CHUNKERS.LEGACY_E9B779D, fileSha256 },
    }));
    return { chunks, rowCount: result.rowCount, usedRows: result.usedRows, truncated: result.truncated };
  }
  throw new Error(`Unknown chunker: ${chunker}`);
};

// Reads and chunks each key in order. Any failure stops the run: an index silently missing a file
// would bias every result built on it.
export const collectChunks = async ({ s3, bucket, keys, chunker, maxRows = 0, maxChars = DEFAULT_MAX_CHARS, log = logger }) => {
  const files = [];
  const chunks = [];
  for (const key of keys) {
    const object = await loadObjectText(s3, bucket, key);
    const result = await chunkFile({ key, text: object.text, chunker, maxRows, maxChars, bucket, fileSha256: object.sha256 });
    if (result.truncated) {
      log.warn({ key, rowCount: result.rowCount, usedRows: result.usedRows }, "CSV truncated to the row cap; remaining rows are not ingested");
    }
    files.push({ key, bytes: object.bytes, sha256: object.sha256, rows: result.rowCount, usedRows: result.usedRows, truncated: result.truncated, chunks: result.chunks.length });
    chunks.push(...result.chunks);
  }
  return { files, chunks };
};

// Cohere `search_document` embeddings, the input type the production collection was built with.
export const embedChunks = async (texts, { embeddings, batch = 480, onProgress } = {}) => {
  const model = embeddings || new CohereEmbeddings({ apiKey: env.cohereApiKey, model: AIConfig.embeddingModel });
  const vectors = [];
  for (let start = 0; start < texts.length; start += batch) {
    const part = texts.slice(start, start + batch);
    const result = await model.embedDocuments(part);
    if (!Array.isArray(result) || result.length !== part.length) throw new Error(`Embedding returned ${result ? result.length : 0} vectors for ${part.length} texts`);
    vectors.push(...result);
    if (onProgress) onProgress(vectors.length, texts.length);
  }
  return vectors;
};

export const gitState = () => {
  try {
    const run = (args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return { commit: run(["rev-parse", "--short", "HEAD"]), dirty: run(["status", "--porcelain"]).length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
};

// Refuses to add chunks of `chunker` to a collection holding chunks of any other chunker (chunks from
// before chunker labels existed count as different).
export const assertNoMixedChunkers = async (collection, chunker, { pageSize = 250 } = {}) => {
  const total = await collection.count();
  for (let offset = 0; offset < total; offset += pageSize) {
    const page = await collection.get({ include: ["metadatas"], limit: pageSize, offset });
    const other = (page.metadatas || []).find((metadata) => !metadata || metadata.chunker !== chunker);
    if (other !== undefined) {
      throw new Error(`Collection already holds chunks from chunker "${(other && other.chunker) || "unlabelled (legacy)"}"; refusing to mix them with "${chunker}". Use a new collection.`);
    }
  }
  return total;
};

export const writeChromaCloud = async ({ collection, chunks, vectors, chunker, batch = 100 }) => {
  await assertNoMixedChunkers(collection, chunker);
  for (let start = 0; start < chunks.length; start += batch) {
    const part = chunks.slice(start, start + batch);
    // upsert: re-running on an unchanged file replaces identical ids instead of duplicating chunks.
    await collection.upsert({
      ids: part.map((chunk) => chunk.id),
      embeddings: vectors.slice(start, start + batch),
      metadatas: part.map((chunk) => chunk.metadata),
      documents: part.map((chunk) => chunk.text),
    });
  }
  return chunks.length;
};

const openCloudCollection = async (name, chunker) => {
  const { CloudClient } = await import("chromadb");
  const client = new CloudClient({ apiKey: env.chromaApiKey, tenant: env.chromaTenant, database: env.chromaDatabase });
  try {
    return await client.getCollection({ name });
  } catch {
    // Created without an embedding function (embeddings are computed here) and without hnsw:space, so
    // the space is Chroma's default l2, as for the production collection.
    return client.createCollection({ name, metadata: { description: "Agricultural data for Tamil Nadu farming assistant", embedding_provider: "cohere", chunker } });
  }
};

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseIngestArgs(argv);
  validateEnv(options.target === "local" ? LOCAL_REQUIRED : INGEST_REQUIRED);
  const outDir = options.target === "local" ? join(LOCAL_INDEX_ROOT, options.tag) : null;

  // Refuse before any read or embedding call.
  if (outDir && existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw Object.assign(new Error(`Refusing to overwrite existing index: ${outDir}. Use a new --tag.`), { exitCode: 2 });
  }
  let collection = null;
  if (options.target === "chroma-cloud") {
    collection = await openCloudCollection(options.collection, options.chunker);
    await assertNoMixedChunkers(collection, options.chunker);
  }

  const s3 = new S3Client({
    region: env.awsRegion || "us-east-1",
    credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey },
  });
  logger.info({ bucket: env.s3Bucket, target: options.target, chunker: options.chunker }, "Listing all files from S3 bucket");
  const allKeys = await listAllObjects(s3, env.s3Bucket);
  // Only knowledge CSVs: never farmer uploads, land documents or claim evidence (see shouldIngestKey).
  const keys = allKeys.filter((key) => shouldIngestKey(key, { uploadPrefix: env.uploadStoragePrefix, includePrefix: process.env.RAG_INGEST_PREFIX || "" }));
  logger.info({ listed: allKeys.length, ingesting: keys.length }, "Found S3 files");

  const { files, chunks } = await collectChunks({ s3, bucket: env.s3Bucket, keys, chunker: options.chunker, maxRows: options.maxRows, maxChars: options.maxChars });
  if (chunks.length === 0) throw new Error("No chunks were produced");
  const vectors = await embedChunks(chunks.map((chunk) => chunk.text), {
    onProgress: (done, total) => logger.info({ done, total }, "Embedded chunks"),
  });

  if (options.target === "local") {
    const written = await writeLocalIndex(outDir, {
      chunks,
      vectors,
      manifest: {
        name: "ragLocalIndex",
        tag: options.tag,
        source: "rag/ingest.js --target=local (bucket listing filtered by shouldIngestKey)",
        createdAt: new Date().toISOString(),
        ...gitState(),
        model: AIConfig.embeddingModel,
        inputType: EMBEDDING_INPUT_TYPE,
        chunker: options.chunker,
        maxChars: options.chunker === CHUNKERS.TABLE_V1 ? options.maxChars : 1000,
        maxRows: options.maxRows,
        files,
      },
    });
    logger.info({ dir: written.dir, chunks: written.count }, "Wrote local index");
    return written;
  }
  await writeChromaCloud({ collection, chunks, vectors, chunker: options.chunker });
  logger.info({ collection: options.collection, chunks: chunks.length }, "Upserted into Chroma Cloud");
  return { collection: options.collection, count: chunks.length };
};

// Run only when executed directly (`npm run ingest`), never on import.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((err) => {
    logger.error({ err }, "Fatal ingestion error");
    process.exit(err && err.exitCode ? err.exitCode : 1);
  });
}
