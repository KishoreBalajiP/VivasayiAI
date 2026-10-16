// Shared helpers for the live evaluations in scripts/live/.
//
// SAFETY: `isolateSharedInfrastructure()` MUST run before config/env.js is imported. dotenv never
// overrides a variable that is already set (even to an empty string), so this pins:
//   - MONGO_URI to an unreachable local address (the scripts connect mongoose to an in-memory server
//     themselves; nothing can reach MongoDB Atlas);
//   - the AWS credentials to empty strings and IMAGE_STORAGE_MODE to "mock" (S3 is never contacted;
//     objects live in services/s3.service.js's in-process mock bucket).
// Gemini, Cohere and Chroma keys are left as loaded from .env. Chroma is only ever QUERIED.
// Nothing here prints or writes a credential.

export const isolateSharedInfrastructure = (extra = {}) => {
  process.env.LOG_LEVEL ||= "silent";
  process.env.MONGO_URI = "mongodb://127.0.0.1:1/live-eval-atlas-disabled";
  process.env.MY_AWS_ACCESS_KEY_ID = "";
  process.env.MY_AWS_SECRET_ACCESS_KEY = "";
  process.env.S3_BUCKET = "live-eval-mock-bucket";
  process.env.IMAGE_STORAGE_MODE = "mock";
  process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED = "false";
  process.env.CLAIM_VERIFICATION_DRAIN_ON_READ = "false";
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
};

// Price source (fetched 2026-10-16 from https://ai.google.dev/gemini-api/docs/pricing, page marked
// "Last updated 2026-10-15 UTC"): Gemini 2.5 Flash, paid tier, Standard, per 1M tokens:
// input (text/image/video) USD 0.30; output INCLUDING thinking tokens USD 2.50.
export const PRICING = Object.freeze({
  model: "gemini-2.5-flash",
  inputUsdPerMTok: 0.3,
  outputIncludingThinkingUsdPerMTok: 2.5,
  source: "https://ai.google.dev/gemini-api/docs/pricing (page 'Last updated 2026-10-15 UTC', fetched 2026-10-16), paid tier Standard",
  note: "Estimate only. Ignores free-tier quotas, context caching, batch discounts and taxes.",
});

// usage_metadata from @langchain/google-genai 1.0.0: output_tokens EXCLUDES thinking; total_tokens
// includes it, so thinking = total - input - output (verified on a probe call).
export const readUsage = (result) => {
  const message = result && result.generations && result.generations[0] && result.generations[0][0] && result.generations[0][0].message;
  const u = (message && message.usage_metadata) || {};
  const prompt = Number(u.input_tokens ?? 0);
  const candidates = Number(u.output_tokens ?? 0);
  const total = Number(u.total_tokens ?? 0);
  const thinking = Math.max(0, total - prompt - candidates);
  const costUsd = (prompt * PRICING.inputUsdPerMTok + (candidates + thinking) * PRICING.outputIncludingThinkingUsdPerMTok) / 1e6;
  const info = result && result.generations && result.generations[0] && result.generations[0][0] && result.generations[0][0].generationInfo;
  return { prompt, candidates, thinking, total, estCostUsd: Math.round(costUsd * 1e7) / 1e7, finishReason: (info && info.finishReason) || null };
};

// Wrap the shared production model instance so every call is counted and its raw result kept.
// The production services call `model.generate(...)` through the exported object, so they see this.
export const instrumentModel = (model) => {
  const original = model.generate.bind(model);
  const calls = [];
  model.generate = async (...args) => {
    const started = performance.now();
    try {
      const result = await original(...args);
      calls.push({ ok: true, ms: Math.round(performance.now() - started), result });
      return result;
    } catch (error) {
      calls.push({ ok: false, ms: Math.round(performance.now() - started), error: redact(error && error.message) });
      throw error;
    }
  };
  return calls;
};

export const redact = (message) =>
  String(message || "")
    .replace(/mongodb(\+srv)?:\/\/[^\s]+/gi, "mongodb://<redacted>")
    .replace(/(key|token|secret|tenant)=[^&\s]+/gi, "$1=<redacted>")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "<redacted-key>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<redacted-id>")
    .slice(0, 300);

const round = (v, d = 4) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
export const stats = (values, digits = 2) => {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, mean: null, median: null, p95: null, min: null, max: null, sum: null };
  const q = (p) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))];
  const sum = xs.reduce((s, v) => s + v, 0);
  return { n: xs.length, mean: round(sum / xs.length, digits), median: q(0.5), p95: q(0.95), min: xs[0], max: xs[xs.length - 1], sum: round(sum, 6) };
};

export const TAMIL_LETTER = /[஀-௿]/g;
export const tamilRatio = (text) => {
  const tamil = (String(text).match(TAMIL_LETTER) || []).length;
  const latin = (String(text).match(/[A-Za-z]/g) || []).length;
  return tamil + latin === 0 ? null : round(tamil / (tamil + latin), 3);
};

export const gitInfo = async () => {
  const { execSync } = await import("node:child_process");
  try {
    const commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    return { commit, dirtyWorkingTree: dirty };
  } catch {
    return { commit: null, dirtyWorkingTree: null };
  }
};

// A Gemini quota / rate-limit failure. The free tier allows only 20 generate requests per day for
// gemini-2.5-flash; LangChain retries a 429 several times with backoff before surfacing it, so a
// quota problem first shows up as a timeout or a very slow call.
export const isQuotaError = (message) => /\b429\b|quota|RESOURCE_EXHAUSTED|Too Many Requests|rate.?limit/i.test(String(message || ""));
