import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { env, validateEnv } from "../config/env.js";
import { districtReference } from "../config/districts.js";
import AIConfig from "../src/ai/AIConfig.js";
import { shouldIngestKey, sha256Hex, tablePreamble, parseCsv, preambleDistrictMentions, CHUNKERS, DEFAULT_MAX_CHARS } from "./ingestHelpers.js";
import { assertTag, chunkFile, embedChunks, gitState, loadObjectText, parseMaxRows, EMBEDDING_INPUT_TYPE, LOCAL_INDEX_ROOT, LOCAL_REQUIRED } from "./ingest.js";
import { writeLocalIndex } from "./localIndex.js";

// Builds a local evaluation index (`npm run rag:build-local`, plan A10, D3). Production is never
// written:
//   - S3 is read with GetObject and HeadObject only, one call each per key on a fixed allow-list:
//     the 60 files of the frozen baseline (docs/research/evaluation/live/rag_retrieval_2026-10-16.json
//     corpus.chunksByFile). The bucket is never listed, so farmer upload keys are never even seen.
//     The client is wrapped (createReadOnlyS3) and throws on any other command, any other bucket, any
//     key off the allow-list, and any key under uploads/ or claims/.
//   - Of the 60 files the 57 CSVs are used; tamil-nadu.kml and the two .xls exports are excluded and
//     recorded in the manifest. `--corpus=baseline60` keeps all 60, only with the legacy chunker, to
//     rebuild the baseline corpus for the parity check (design critique C1).
//   - Embeddings are Cohere `search_document` with the production model. Output goes to
//     .rag-local/indexes/<tag>/ (gitignored): manifest.json, chunks.jsonl, embeddings.f32, SHA256SUMS.
//     Nothing is written to Chroma. An existing index directory is never overwritten.
// It does not call isolateSharedInfrastructure (which blanks the S3 credentials) and never imports
// mongoose.
//
// Flags: --chunker=table-v1|legacy-e9b779d  --max-rows=<n> (0 = no cap; default RAG_MAX_ROWS_PER_FILE,
//        or 100 with --corpus=baseline60, the cap the production collection was built with)
//        --tag=<name> (required unless --dry-run)  --max-chunks=<n> (safety cap, default 5000)
//        --max-chars=<n> (table-v1 only, default 1000)  --corpus=csv|baseline60
//        --dry-run (read and chunk only; no Cohere call, nothing written)
//        --source-dir=<dir> (dry run only: chunk local files instead of reading S3)
// A real build also copies manifest.json to docs/research/evaluation/live/rag/manifests/<tag>.manifest.json.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_RESULT_PATH = join(root, "docs", "research", "evaluation", "live", "rag_retrieval_2026-10-16.json");
export const DEFAULT_MAX_CHUNKS = 5000;
// Byte-identical copies of index manifests are kept with the results (the indexes themselves are
// gitignored), so a result's indexManifestSha256 can be traced to a committed file.
export const MANIFEST_COPY_DIR = join(root, "docs", "research", "evaluation", "live", "rag", "manifests");
export const COHERE_BATCH_SIZE = 48; // CohereEmbeddings default: one embed request per 48 texts
// embed-english-v3.0 reads at most 512 tokens and truncates the rest (Cohere's default truncate=END).
// At roughly 4 characters per token, longer chunks are embedded from their beginning only; the stored
// text, which the evaluation labels, stays complete. Counted and reported, not changed.
export const EMBEDDING_CONTEXT_CHARS = 2000;
const ALLOWED_COMMANDS = [GetObjectCommand, HeadObjectCommand];
// Row cap of the ingest that built the production collection (e9b779d rag/ingest.js), used by
// `--corpus=baseline60` so the parity rebuild reproduces that corpus.
export const BASELINE60_MAX_ROWS = 100;

// Farmer data never reaches an index: keys under the configured upload prefix AND under the literal
// `uploads/` and `claims/` prefixes the application has used (whatever UPLOAD_STORAGE_PREFIX says now)
// are refused.
export const FORBIDDEN_KEY_PREFIXES = Object.freeze(["uploads", "claims"]);
export const isForbiddenKey = (key, uploadPrefix = "uploads") => {
  const normalized = String(key || "").replace(/^\/+/, "");
  const upload = String(uploadPrefix || "uploads").replace(/^\/+|\/+$/g, "");
  return [...new Set([upload, ...FORBIDDEN_KEY_PREFIXES])].some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
};

const exclusionReason = (key) => {
  if (/\.kml$/i.test(key)) return "kml geography file (coordinates, not knowledge text)";
  if (/\.xls$/i.test(key)) return "xls export (HTML table, includes debug output)";
  return "not a knowledge CSV (shouldIngestKey)";
};

// The allow-list is the set of files the frozen baseline retrieved from, read from its result file.
export const loadAllowList = (path = BASELINE_RESULT_PATH, { uploadPrefix = "uploads" } = {}) => {
  const raw = readFileSync(path);
  const baseline = JSON.parse(raw.toString("utf8"));
  const keys = Object.keys((baseline.corpus && baseline.corpus.chunksByFile) || {});
  if (keys.length === 0) throw new Error(`No corpus.chunksByFile keys in ${path}`);
  const forbidden = keys.filter((key) => isForbiddenKey(key, uploadPrefix));
  if (forbidden.length) throw new Error(`Allow-list contains upload or claim keys: ${forbidden.join(", ")}`);
  const csv = keys.filter((key) => shouldIngestKey(key, { uploadPrefix }));
  const excluded = keys.filter((key) => !csv.includes(key)).map((key) => ({ key, reason: exclusionReason(key) }));
  return { path, sha256: sha256Hex(raw), keys, csv, excluded };
};

// Read-only S3: only GetObject/HeadObject, only on `bucket`, only allow-listed keys, never uploads/
// or claims/. Records every call it lets through.
export const createReadOnlyS3 = (client, { bucket, allowList, uploadPrefix = "uploads" }) => {
  const allowed = new Set(allowList);
  const calls = [];
  return {
    calls,
    async send(command) {
      const name = (command && command.constructor && command.constructor.name) || typeof command;
      if (!ALLOWED_COMMANDS.some((Command) => command instanceof Command)) {
        throw new Error(`S3 guard: ${name} is not allowed (GetObject and HeadObject only)`);
      }
      const { Bucket, Key } = command.input || {};
      if (!bucket || Bucket !== bucket) throw new Error(`S3 guard: bucket "${Bucket}" is not the configured knowledge bucket`);
      if (isForbiddenKey(Key, uploadPrefix)) throw new Error(`S3 guard: key "${Key}" is under uploads/ or claims/`);
      if (!allowed.has(Key)) throw new Error(`S3 guard: key "${Key}" is not on the allow-list`);
      calls.push({ command: name, key: Key });
      return client.send(command);
    },
  };
};

export const parseBuildArgs = (argv = []) => {
  const value = (name) => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    return arg === undefined ? undefined : arg.slice(name.length + 3);
  };
  const corpus = value("corpus") || "csv";
  const options = {
    chunker: value("chunker") || CHUNKERS.TABLE_V1,
    // The baseline corpus was built with the e9b779d ingest's 100-row cap: a parity rebuild uses it
    // unless --max-rows says otherwise (stage-1 review). Other builds keep RAG_MAX_ROWS_PER_FILE.
    maxRows: corpus === "baseline60" && value("max-rows") === undefined ? BASELINE60_MAX_ROWS : parseMaxRows(value("max-rows")),
    maxChars: value("max-chars") === undefined ? DEFAULT_MAX_CHARS : Number(value("max-chars")),
    maxChunks: value("max-chunks") === undefined ? DEFAULT_MAX_CHUNKS : Number(value("max-chunks")),
    tag: value("tag"),
    corpus,
    dryRun: argv.includes("--dry-run"),
    sourceDir: value("source-dir"),
    allowListPath: value("allow-list") || BASELINE_RESULT_PATH,
  };
  if (!Object.values(CHUNKERS).includes(options.chunker)) throw new Error(`--chunker must be one of ${Object.values(CHUNKERS).join(", ")}`);
  if (!Number.isInteger(options.maxChars) || options.maxChars < 200) throw new Error("--max-chars must be a whole number of at least 200");
  if (!Number.isInteger(options.maxChunks) || options.maxChunks < 1) throw new Error("--max-chunks must be a positive whole number");
  if (!["csv", "baseline60"].includes(options.corpus)) throw new Error("--corpus must be csv or baseline60");
  if (options.corpus === "baseline60" && options.chunker !== CHUNKERS.LEGACY_E9B779D) {
    throw new Error("--corpus=baseline60 rebuilds the production corpus and needs --chunker=legacy-e9b779d");
  }
  if (options.sourceDir && !options.dryRun) throw new Error("--source-dir is for chunking-only dry runs; real indexes are built from the S3 allow-list");
  if (!options.dryRun) assertTag(options.tag);
  else if (options.tag) assertTag(options.tag);
  return options;
};

const localSource = (dir, corpus) => {
  const names = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile()).sort();
  const keys = corpus === "baseline60" ? names : names.filter((name) => shouldIngestKey(name));
  const excluded = corpus === "baseline60" ? [] : names.filter((name) => !keys.includes(name)).map((key) => ({ key, reason: exclusionReason(key) }));
  const load = async (key) => {
    const bytes = readFileSync(join(dir, key));
    return { text: bytes.toString("utf8"), bytes: bytes.length, sha256: sha256Hex(bytes) };
  };
  return { keys, excluded, load, describe: { sourceDir: relative(root, dir) || "." } };
};

const s3Source = (options, s3, bucket) => {
  const allow = loadAllowList(options.allowListPath, { uploadPrefix: env.uploadStoragePrefix });
  const keys = options.corpus === "baseline60" ? allow.keys : allow.csv;
  const excluded = options.corpus === "baseline60" ? [] : allow.excluded;
  const guarded = createReadOnlyS3(s3, { bucket, allowList: allow.keys, uploadPrefix: env.uploadStoragePrefix });
  const load = async (key) => {
    const head = await guarded.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const object = await loadObjectText(guarded, bucket, key);
    if (head.ContentLength !== undefined && Number(head.ContentLength) !== object.bytes) {
      throw new Error(`${key}: GetObject returned ${object.bytes} bytes, HeadObject said ${head.ContentLength}`);
    }
    return { ...object, etag: head.ETag || null };
  };
  return {
    keys,
    excluded,
    load,
    guarded,
    describe: { allowList: { path: relative(root, allow.path), sha256: allow.sha256, keys: allow.keys.length, csv: allow.csv.length } },
  };
};

// Reads and chunks every key, then (unless dry run) embeds and writes the index. `deps.s3`,
// `deps.embeddings`, `deps.bucket` and `deps.indexRoot` replace the real clients and paths in tests.
export const buildLocalIndex = async (options, deps = {}) => {
  const outDir = options.tag ? join(deps.indexRoot || LOCAL_INDEX_ROOT, options.tag) : null;
  if (!options.dryRun && existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw Object.assign(new Error(`Refusing to overwrite existing index: ${outDir}. Use a new --tag.`), { exitCode: 2 });
  }
  const bucket = options.sourceDir ? "" : deps.bucket || env.s3Bucket;
  const source = options.sourceDir
    ? localSource(options.sourceDir, options.corpus)
    : s3Source(options, deps.s3 || new S3Client({ region: env.awsRegion || "us-east-1", credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey } }), bucket);

  const { T } = await import("../scripts/live/lib/ragEvalSpec.js");
  const districtNames = [...districtReference.map((d) => d.name), ...Object.values(T).flat()];
  const files = [];
  const chunks = [];
  const warnings = [];
  for (const key of source.keys) {
    const object = await source.load(key);
    const result = await chunkFile({ key, text: object.text, chunker: options.chunker, maxRows: options.maxRows, maxChars: options.maxChars, bucket, fileSha256: object.sha256 });
    const lengths = result.chunks.map((chunk) => chunk.text.length);
    files.push({
      key,
      bytes: object.bytes,
      sha256: object.sha256,
      ...(object.etag ? { etag: object.etag } : {}),
      rows: result.rowCount,
      usedRows: result.usedRows,
      truncated: result.truncated,
      chunks: result.chunks.length,
      maxChunkChars: lengths.length ? Math.max(...lengths) : 0,
      oversizeRows: result.chunks.filter((chunk) => chunk.metadata.oversizeRow).length,
      longChunks: lengths.filter((length) => length > EMBEDDING_CONTEXT_CHARS).length,
    });
    if (result.truncated) warnings.push({ key, code: "truncated", rows: result.rowCount, usedRows: result.usedRows });
    if (result.chunks.length === 0) warnings.push({ key, code: "no_chunks" });
    if (files[files.length - 1].longChunks) warnings.push({ key, code: "may_exceed_embedding_context", chunks: files[files.length - 1].longChunks, overChars: EMBEDDING_CONTEXT_CHARS });
    if (options.chunker === CHUNKERS.TABLE_V1) {
      const [headers] = parseCsv(object.text);
      const mentions = headers ? preambleDistrictMentions(tablePreamble(key, headers), districtNames) : [];
      if (mentions.length) warnings.push({ key, code: "preamble_mentions_district", districts: mentions });
    }
    chunks.push(...result.chunks);
  }

  const summary = {
    name: "ragLocalIndex",
    tag: options.tag || null,
    dryRun: Boolean(options.dryRun),
    chunker: options.chunker,
    maxChars: options.chunker === CHUNKERS.TABLE_V1 ? options.maxChars : 1000,
    maxRows: options.maxRows,
    corpus: options.corpus,
    ...source.describe,
    model: AIConfig.embeddingModel,
    inputType: EMBEDDING_INPUT_TYPE,
    counts: {
      files: files.length,
      excluded: source.excluded.length,
      chunks: chunks.length,
      oversizeRows: files.reduce((sum, file) => sum + file.oversizeRows, 0),
      longChunks: files.reduce((sum, file) => sum + file.longChunks, 0),
      truncatedFiles: files.filter((file) => file.truncated).length,
    },
    estimatedEmbedRequests: Math.ceil(chunks.length / COHERE_BATCH_SIZE),
    maxChunks: options.maxChunks,
    exceedsMaxChunks: chunks.length > options.maxChunks,
    files,
    excluded: source.excluded,
    warnings,
    s3Calls: source.guarded ? source.guarded.calls.length : 0,
  };
  if (options.dryRun) return { summary, chunks };
  if (summary.exceedsMaxChunks) throw new Error(`${chunks.length} chunks exceed --max-chunks=${options.maxChunks}; nothing embedded`);
  if (chunks.length === 0) throw new Error("No chunks were produced; nothing embedded");

  const vectors = await embedChunks(chunks.map((chunk) => chunk.text), { embeddings: deps.embeddings });
  const manifest = { ...summary, createdAt: new Date().toISOString(), ...gitState() };
  delete manifest.dryRun;
  delete manifest.exceedsMaxChunks;
  const written = await writeLocalIndex(outDir, { chunks, vectors, manifest });
  return { summary, written };
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    const options = parseBuildArgs(process.argv.slice(2));
    if (!options.sourceDir) validateEnv(options.dryRun ? LOCAL_REQUIRED.filter((key) => key !== "COHERE_API_KEY") : LOCAL_REQUIRED);
    const { summary, written } = await buildLocalIndex(options);
    if (written) {
      const { writeResultOnce } = await import("../scripts/live/lib/writeOnce.js");
      written.manifestCopy = relative(root, writeResultOnce(join(MANIFEST_COPY_DIR, `${options.tag}.manifest.json`), readFileSync(join(written.dir, "manifest.json"))));
    }
    const brief = { ...summary, files: summary.files.map(({ key, rows, chunks, maxChunkChars, oversizeRows, longChunks, truncated }) => ({ key, rows, chunks, maxChunkChars, oversizeRows, longChunks, truncated })) };
    console.log(JSON.stringify(written ? { ...brief, written } : brief, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(error && error.message);
    process.exit((error && error.exitCode) || 1);
  }
}
