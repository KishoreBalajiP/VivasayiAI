import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { advisoryToChunks, ADVISORY_CHUNKER, DEFAULT_MAX_CHARS } from "./ingestHelpers.js";
import { htmlTitle, htmlToText } from "./advisorySources.js";

// Builds a local candidate index: an existing statistics index (its chunks and vectors reused
// unchanged) plus advisory chunks from a corpus downloaded by scripts/rag/acquireAdvisory.js. Local
// only: nothing is written to Chroma.
// Usage: node rag/buildAdvisoryIndex.js --base=<index tag> --corpus=<corpus tag> --tag=<new tag> [--dry-run]

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Pure: one manifest document and its decoded text -> chunks plus a status for the manifest. Pages are
// decoded as latin1 because the portal serves ISO-8859-1 and no charset on many pages.
export const documentToChunks = (doc, raw, { maxChars = DEFAULT_MAX_CHARS } = {}) => {
  const isPdf = doc.format === "pdf";
  const decoded = isPdf ? raw.toString("utf8") : raw.toString("latin1");
  const text = isPdf ? decoded.replace(/\f/g, "\n").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n") : htmlToText(decoded);
  const title = isPdf ? decodeURI(doc.url).split("/").pop() : htmlTitle(decoded) || decodeURI(doc.url).split("/").pop();
  const docId = `${doc.seed}__${decodeURI(new URL(doc.url).pathname).split("/").pop()}`;
  const chunks = advisoryToChunks({ docId, text, title, issuer: doc.issuer, url: doc.url, crop: doc.crop, retrievedAt: doc.retrievedAt, fileSha256: doc.sha256, maxChars });
  return { docId, title, chunks };
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const arg = (name) => {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found === undefined ? undefined : found.slice(name.length + 3);
  };
  const dryRun = process.argv.includes("--dry-run");
  const [baseTag, corpusTag, tag] = [arg("base"), arg("corpus"), arg("tag")];
  if (!baseTag || !corpusTag || !tag) {
    console.error("--base, --corpus and --tag are required");
    process.exit(1);
  }
  const { LOCAL_INDEX_ROOT, embedChunks, gitState } = await import("./ingest.js");
  const { loadLocalIndex, writeLocalIndex } = await import("./localIndex.js");
  const outDir = join(LOCAL_INDEX_ROOT, tag);
  if (existsSync(outDir)) {
    console.error(`Refusing to overwrite existing index: ${outDir}`);
    process.exit(2);
  }
  const corpusDir = join(root, ".rag-local", "corpus", corpusTag);
  const manifestRaw = readFileSync(join(corpusDir, "manifest.json"));
  const corpus = JSON.parse(manifestRaw.toString("utf8"));
  const documents = [];
  const seenContent = new Map();
  const advisory = [];
  for (const doc of corpus.documents) {
    if (doc.status !== "fetched") {
      documents.push({ url: doc.url, status: doc.status, chunks: 0 });
      continue;
    }
    if (seenContent.has(doc.sha256)) {
      documents.push({ url: doc.url, status: "duplicate_content", chunks: 0 });
      continue;
    }
    seenContent.set(doc.sha256, doc.url);
    const raw = readFileSync(join(corpusDir, "raw", doc.format === "pdf" ? doc.textFile : doc.rawFile));
    const { title, chunks } = documentToChunks(doc, raw);
    documents.push({ url: doc.url, sha256: doc.sha256, title, status: chunks.length ? "chunked" : "no_answer_text", chunks: chunks.length });
    advisory.push(...chunks);
  }
  const unique = [...new Map(advisory.map((chunk) => [chunk.id, chunk])).values()];
  const summary = { documents: documents.length, chunked: documents.filter((d) => d.status === "chunked").length, advisoryChunks: unique.length, byStatus: documents.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] || 0) + 1 }), {}) };
  if (dryRun) {
    console.log(JSON.stringify({ summary, sample: unique.slice(0, 3).map((c) => c.text.slice(0, 500)) }, null, 2));
    process.exit(0);
  }
  const base = loadLocalIndex(join(LOCAL_INDEX_ROOT, baseTag));
  const count = await base.count();
  const existing = await base.get({ include: ["documents", "metadatas", "embeddings"], limit: count, offset: 0 });
  const vectors = await embedChunks(unique.map((chunk) => chunk.text), { batch: 48 });
  const baseChunks = existing.ids.map((id, i) => ({ id, text: existing.documents[i], metadata: existing.metadatas[i] }));
  const written = await writeLocalIndex(outDir, {
    chunks: [...baseChunks, ...unique],
    vectors: [...existing.embeddings, ...vectors],
    manifest: { name: "ragLocalIndex", tag, createdAt: new Date().toISOString(), ...gitState(), model: base.manifest.model, inputType: base.manifest.inputType, chunker: `${base.manifest.chunker}+${ADVISORY_CHUNKER}`, corpus: `${base.manifest.corpus}+advisory`, base: { tag: baseTag, manifestSha256: base.manifestSha256, count }, advisory: { corpusTag, ...summary, documents } },
  });
  const { writeResultOnce } = await import("../scripts/live/lib/writeOnce.js");
  writeResultOnce(join(root, "docs", "research", "evaluation", "live", "rag", "manifests", `${tag}.manifest.json`), readFileSync(join(outDir, "manifest.json")));
  console.log(JSON.stringify({ written: relative(root, written.dir), count: written.count, summary }));
  process.exit(0);
}
