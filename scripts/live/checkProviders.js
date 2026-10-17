import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ResultExistsError, writeJsonOnce } from "./lib/writeOnce.js";

// Live provider connectivity check. READ-ONLY against shared infrastructure:
//   MongoDB: ping + list collection names and estimated counts (no writes)
//   S3:      HeadBucket + list up to 20 keys, reporting only top-level prefixes (no reads of content, no writes)
//   Chroma:  collection count + one similarity query (no writes)
//   Cohere:  one query embedding;  Gemini: one tiny generation;  Copernicus: OAuth token + one catalogue search
// It never prints credentials, connection strings or object contents. Output: a JSON record of status,
// latency and counts. Usage: node scripts/live/checkProviders.js --date=YYYY-MM-DD
// The output is write-once (scripts/live/lib/writeOnce.js): an existing file for the date is never replaced.
process.env.LOG_LEVEL ||= "silent";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dateArg = process.argv.find((a) => a.startsWith("--date="));
const date = dateArg ? dateArg.slice(7) : null;
const outFile = join(root, "docs", "research", "evaluation", "live", `provider_check${date ? `_${date}` : ""}.json`);
// Checked before any provider call; writeJsonOnce checks again when writing.
if (existsSync(outFile)) {
  const error = new ResultExistsError(outFile);
  console.error(error.message);
  process.exit(error.exitCode);
}

const { env } = await import("../../config/env.js");
const results = { date, checks: {} };
const redact = (message) => String(message || "").replace(/mongodb(\+srv)?:\/\/[^\s]+/gi, "mongodb://<redacted>").replace(/(key|token|secret)=[^&\s]+/gi, "$1=<redacted>").slice(0, 200);
const timed = async (name, fn) => {
  const started = performance.now();
  try {
    const detail = await fn();
    results.checks[name] = { ok: true, latencyMs: Math.round(performance.now() - started), ...detail };
  } catch (error) {
    results.checks[name] = { ok: false, latencyMs: Math.round(performance.now() - started), error: redact(error && error.message) };
  }
};

await timed("mongodb", async () => {
  const mongoose = (await import("mongoose")).default;
  const conn = await mongoose.createConnection(env.mongoUri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  await conn.db.admin().ping();
  const collections = await conn.db.listCollections({}, { nameOnly: true }).toArray();
  const counts = {};
  for (const { name } of collections) counts[name] = await conn.db.collection(name).estimatedDocumentCount();
  await conn.close();
  return { database: conn.name ? "<named>" : null, collections: counts };
});

await timed("s3", async () => {
  const { S3Client, HeadBucketCommand, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: env.awsRegion, credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey } });
  await s3.send(new HeadBucketCommand({ Bucket: env.s3Bucket }));
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: env.s3Bucket, MaxKeys: 20 }));
  const prefixes = [...new Set((listed.Contents || []).map((o) => (o.Key.includes("/") ? `${o.Key.split("/")[0]}/` : "<root file>")))];
  return { keysListed: (listed.Contents || []).length, truncated: Boolean(listed.IsTruncated), topLevelPrefixes: prefixes };
});

let queryEmbedding = null;
await timed("cohere", async () => {
  const { CohereEmbeddings } = await import("@langchain/cohere");
  const AIConfig = (await import("../../src/ai/AIConfig.js")).default;
  const embeddings = new CohereEmbeddings({ apiKey: env.cohereApiKey, model: AIConfig.embeddingModel });
  queryEmbedding = await embeddings.embedQuery("paddy irrigation schedule in Thanjavur delta");
  return { model: AIConfig.embeddingModel, dimension: queryEmbedding.length };
});

await timed("chroma", async () => {
  const { CloudClient } = await import("chromadb");
  const client = new CloudClient({ apiKey: env.chromaApiKey, tenant: env.chromaTenant, database: env.chromaDatabase });
  const collection = await client.getCollection({ name: (await import("../../config/ragConfig.js")).ragCollectionName() });
  const count = await collection.count();
  let filenames = [];
  if (queryEmbedding) {
    const res = await collection.query({ queryEmbeddings: [queryEmbedding], nResults: 3, include: ["metadatas"] });
    filenames = (res.metadatas?.[0] || []).map((m) => (m && (m.filename || String(m.source || "").split("/").pop())) || null);
  }
  return { collection: "farming-documents", chunks: count, topResultFiles: filenames };
});

await timed("gemini", async () => {
  const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
  const { HumanMessage } = await import("@langchain/core/messages");
  const AIConfig = (await import("../../src/ai/AIConfig.js")).default;
  const model = new ChatGoogleGenerativeAI({ apiKey: env.googleApiKey, model: AIConfig.model, maxOutputTokens: 20 });
  const result = await model.generate([[new HumanMessage("Reply with the single word OK.")]]);
  const text = result.generations?.[0]?.[0]?.text || "";
  const usage = result.llmOutput?.tokenUsage || {};
  return { model: AIConfig.model, replied: text.trim().slice(0, 10), tokens: usage };
});

await timed("copernicus", async () => {
  const { resolveSatelliteConfig } = await import("../../services/satellite/config.js");
  const config = resolveSatelliteConfig();
  const tokenRes = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret }),
  });
  const tokenOk = tokenRes.ok;
  const tokenBody = await tokenRes.json().catch(() => ({}));
  // Catalogue search over a small area near Thanjavur (public), one recent month.
  const search = await fetch(`${config.stacUrl.replace(/\/$/, "")}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collections: ["sentinel-2-l2a"], bbox: [79.10, 10.75, 79.14, 10.79], datetime: "2025-12-01T00:00:00Z/2025-12-31T23:59:59Z", limit: 20 }),
  });
  const searchBody = await search.json().catch(() => ({}));
  return {
    processingEnabled: config.processingEnabled, hasCredentials: config.hasCredentials,
    tokenStatus: tokenRes.status, tokenOk, tokenExpiresIn: tokenBody.expires_in ?? null,
    stacStatus: search.status, scenesFound: Array.isArray(searchBody.features) ? searchBody.features.length : null,
  };
});

writeJsonOnce(outFile, results);
console.log(JSON.stringify(results, null, 2));
process.exit(0);
