import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateSharedInfrastructure, redact, gitInfo } from "./lib/liveCommon.js";
import { writeJsonOnce, ResultExistsError } from "./lib/writeOnce.js";
import { QUERIES } from "./lib/ragEvalSpec.js";
import { specSha256, verifyRagSpec } from "./verifyRagSpec.js";

// Caches the query vectors of the 22 frozen RAG evaluation queries (plan A10). One Cohere
// `embedQuery` call (input type search_query) per query, once; every later condition (parity replay,
// legacy chunker, table-v1) reads this file through `ragRetrieval.live.js --query-vectors=...`, so all
// of them rank against identical vectors. No other provider is called; nothing is written anywhere but
// the output file, which is write-once. The frozen rule must match its pin before any Cohere call.
// Usage: node scripts/live/ragEmbedQueries.js [--out=<path>]

isolateSharedInfrastructure();
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const { env } = await import("../../config/env.js");
const AIConfig = (await import("../../src/ai/AIConfig.js")).default;
const outArg = process.argv.find((a) => a.startsWith("--out="));
const outPath = outArg ? resolve(outArg.slice(6)) : join(root, "docs", "research", "evaluation", "live", "rag", `query_vectors_${AIConfig.embeddingModel}.json`);
if (existsSync(outPath)) {
  console.error(new ResultExistsError(outPath).message);
  process.exit(2);
}
const specCheck = verifyRagSpec();
if (!specCheck.ok) {
  console.error(`The RAG evaluation rule does not match its pin (run node scripts/live/verifyRagSpec.js): ${specCheck.errors.join("; ")}`);
  process.exit(1);
}

const { CohereEmbeddings } = await import("@langchain/cohere");
const embeddings = new CohereEmbeddings({ apiKey: env.cohereApiKey, model: AIConfig.embeddingModel });

const startedAt = new Date().toISOString();
const queries = [];
for (const item of QUERIES) {
  try {
    const vector = await embeddings.embedQuery(item.q);
    if (!Array.isArray(vector) || vector.length === 0) throw new Error("empty embedding");
    queries.push({ id: item.id, kind: item.kind, lang: item.lang || "en", qSha256: sha256(item.q), vector });
  } catch (error) {
    // A partial cache would give the conditions different query sets; stop instead.
    console.error(`Embedding ${item.id} failed: ${redact(error && error.message)}`);
    process.exit(1);
  }
}

const dimensions = [...new Set(queries.map((q) => q.vector.length))];
if (dimensions.length !== 1) {
  console.error(`Inconsistent query vector dimensions: ${dimensions.join(", ")}`);
  process.exit(1);
}

const git = await gitInfo();
writeJsonOnce(outPath, {
  name: "ragQueryVectors",
  startedAt,
  createdAt: new Date().toISOString(),
  ...git,
  dirty: git.dirtyWorkingTree,
  model: AIConfig.embeddingModel,
  inputType: "search_query",
  specSha256: specSha256(),
  dimension: dimensions[0],
  calls: queries.length,
  queries,
});
console.log(`Wrote ${queries.length} query vectors (${dimensions[0]} dimensions) to ${outPath}`);
process.exit(0);
