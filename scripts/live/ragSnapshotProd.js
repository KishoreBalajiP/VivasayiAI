import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateSharedInfrastructure, redact, gitInfo } from "./lib/liveCommon.js";
import { writeResultOnce } from "./lib/writeOnce.js";
import { ragCollectionName } from "../../config/ragConfig.js";

// Read-only snapshot of the production Chroma collection into the local index format (plan A10,
// parity check). Owner-gated: it does nothing without --allow-prod-read. The collection handle is
// wrapped so only count() and get() can be called; it pages through
// get({include:["embeddings","documents","metadatas"], limit:100, offset}) and writes
// .rag-local/indexes/prod-snapshot-<date>/ (write-once; rag/localIndex.js), plus a copy of its manifest
// under docs/research/evaluation/live/rag/manifests/. ragRetrieval.live.js
// --backend=json then replays the frozen evaluation on it, and ragParity.js compares the replay with
// the 2026-10-16 baseline row by row. Nothing is ever written to Chroma.
// Usage: node scripts/live/ragSnapshotProd.js --allow-prod-read [--date=YYYY-MM-DD] [--collection=<name>]
//        [--tag=<dir name>] [--expect=450]

const arg = (name) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 3);
};
const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

// Only the two read methods are reachable; anything else throws before it reaches the client.
export const readOnlyCollection = (collection) => {
  const allowed = new Set(["count", "get"]);
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (!allowed.has(property)) throw new Error(`Read-only snapshot: collection.${String(property)} is not allowed`);
        return (...args) => collection[property](...args);
      },
    },
  );
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  if (!process.argv.includes("--allow-prod-read")) {
    fail("ragSnapshotProd reads the production Chroma collection. It needs the owner's approval: pass --allow-prod-read.");
  }
  isolateSharedInfrastructure();
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const date = arg("date") || new Date().toISOString().slice(0, 10);
  const tag = arg("tag") || `prod-snapshot-${date}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(tag)) fail(`Invalid --tag "${tag}"`);
  const expected = arg("expect") === undefined ? 450 : Number(arg("expect"));
  const outDir = join(root, ".rag-local", "indexes", tag);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) fail(`Refusing to overwrite existing index: ${outDir}`, 2);

  const { env } = await import("../../config/env.js");
  const AIConfig = (await import("../../src/ai/AIConfig.js")).default;
  const { writeLocalIndex } = await import("../../rag/localIndex.js");
  const { CloudClient } = await import("chromadb");
  const name = arg("collection") ? ragCollectionName(arg("collection")) : ragCollectionName();

  try {
    const client = new CloudClient({ apiKey: env.chromaApiKey, tenant: env.chromaTenant, database: env.chromaDatabase });
    const collection = readOnlyCollection(await client.getCollection({ name }));
    const startedAt = new Date().toISOString();
    const count = await collection.count();
    const chunks = [];
    const vectors = [];
    for (let offset = 0; offset < count; offset += 100) {
      const page = await collection.get({ include: ["embeddings", "documents", "metadatas"], limit: 100, offset });
      page.ids.forEach((id, i) => {
        chunks.push({ id, text: page.documents[i] ?? "", metadata: page.metadatas[i] || {} });
        vectors.push(Array.from(page.embeddings[i]));
      });
    }
    if (chunks.length !== count) fail(`Snapshot read ${chunks.length} chunks but count() said ${count}`);
    const git = await gitInfo();
    const written = await writeLocalIndex(outDir, {
      chunks,
      vectors,
      manifest: {
        name: "ragProdSnapshot",
        tag,
        source: "read-only snapshot of the production Chroma Cloud collection (count + paged get)",
        collection: name,
        startedAt,
        createdAt: new Date().toISOString(),
        commit: git.commit,
        dirty: git.dirtyWorkingTree,
        model: AIConfig.embeddingModel,
        modelNote: "The collection does not record its embedding model; this is the configured production model.",
        inputType: "search_document",
        chunker: "legacy-e9b779d (as ingested in production)",
        corpus: "production",
        expectedCount: expected,
        countMatchesExpected: count === expected,
      },
    });
    // Byte-identical manifest copy next to the results (the snapshot itself stays in gitignored .rag-local/).
    const manifestCopy = writeResultOnce(join(root, "docs", "research", "evaluation", "live", "rag", "manifests", `${tag}.manifest.json`), readFileSync(join(written.dir, "manifest.json")));
    console.log(JSON.stringify({ dir: written.dir, count: written.count, dimension: written.dimension, manifestSha256: written.manifestSha256, manifestCopy, countMatchesExpected: count === expected }, null, 2));
    process.exit(0);
  } catch (error) {
    fail(redact(error && error.message), (error && error.exitCode) || 1);
  }
}
