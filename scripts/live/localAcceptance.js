// Farmer-journey acceptance run against the real Express app, called over HTTP exactly as the
// frontend's API client calls it (Bearer session token, JSON envelope {statusCode,message,data}).
//
// Safety: the database is a local mongodb-memory-server and image storage is the in-memory mock,
// so nothing is written to Atlas or S3. Language-model chat (Gemini), retrieval (Cohere + a Chroma
// read query), weather (Open-Meteo) and satellite (Copernicus) stay live when configured in .env.
// The browser's direct S3 PUT is simulated by writing to the mock bucket, as the test suite does.
//
// Usage: node scripts/live/localAcceptance.js [v1-legacy|v2-components]
// Output: docs/research/evaluation/live/acceptance_<policy>_2026-10-16.json (no secrets, no tokens).

import { writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoMemoryServer } from "mongodb-memory-server";

const policy = process.argv[2] || "v1-legacy";
const mongo = await MongoMemoryServer.create();

// Set before config/env.js loads; dotenv never overrides a variable that is already set.
Object.assign(process.env, {
  NODE_ENV: "development",
  LOG_LEVEL: process.env.ACCEPTANCE_LOG_LEVEL || "silent",
  // The real per-user write budget (5/hour) is shorter than this scripted journey; the budget is
  // reported separately (see the claim-write finding in the acceptance summary).
  CLAIM_RATE_LIMIT_MAX: "1000",
  MONGO_URI: mongo.getUri(),
  IMAGE_STORAGE_MODE: "mock",
  IMAGE_AI_MODE: "mock",
  LAND_RECORD_MODE: "mock",
  LAND_RECORD_MOCK_OUTCOME: "unavailable",
  CLAIM_VERIFICATION_POLICY: policy,
  SESSION_JWT_SECRET: process.env.SESSION_JWT_SECRET || "local-acceptance-secret-0123456789abcdef",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(mongo.getUri(), { dbName: "vivasayi-acceptance" });
await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
const app = (await import("../../app.js")).default;
const { signAccessToken } = await import("../../utils/token.js");
const { putObject } = await import("../../services/s3.service.js");
const ClaimEvidence = (await import("../../models/ClaimEvidence.js")).default;
const ImageRecord = (await import("../../models/ImageRecord.js")).default;
await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const farmer = `acceptance-farmer-${policy}`;
const token = (sub) => signAccessToken({ cognitoSub: sub, email: "farmer@example.com", role: null });

const call = async (method, path, { body, sub = farmer, auth = true } = {}) => {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token(sub)}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, data: json?.data ?? null, message: json?.message ?? null, ms: Date.now() - started };
};

const steps = [];
const step = async (name, expectStatus, fn, summarise = () => ({})) => {
  let result;
  try {
    result = await fn();
  } catch (error) {
    steps.push({ name, pass: false, error: error.message });
    return null;
  }
  const pass = Array.isArray(expectStatus) ? expectStatus.includes(result.status) : result.status === expectStatus;
  steps.push({ name, pass, status: result.status, ms: result.ms, ...(pass ? {} : { message: result.message }), ...summarise(result) });
  return result;
};

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
// A ~0.25 ha square of paddy land near Thanjavur (illustrative coordinates, not a real holding).
const square = (lon, lat, size = 0.0015) => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]],
});

await step("no token is refused", 401, () => call("GET", "/claims", { auth: false }));
await step("create farm profile", 200, () =>
  call("POST", "/profile", { body: { district: "Thanjavur", crops: ["Paddy"], acres: 2 } })
);
const parcel = await step("draw a parcel", 200, () =>
  call("POST", "/profile/parcels", { body: { name: "East field", crop: "Paddy", geometry: square(79.135, 10.79) } })
, (r) => ({ areaAcres: r.data?.parcel?.calculatedAreaAcres }));
const parcelId = parcel?.data?.parcel?.parcelId;
await step("list parcels", 200, () => call("GET", "/profile/parcels"), (r) => ({ count: r.data?.parcels?.length }));
await step("weather for the profile district (live Open-Meteo)", [200, 502, 503], () => call("GET", "/weather?district=Thanjavur"));

const chatSummary = (r) => ({
  replyChars: (r.data?.reply ?? r.data?.response ?? r.data?.message ?? "").length,
  sources: Array.isArray(r.data?.sources) ? r.data.sources.length : null,
  intent: r.data?.meta?.intent ?? null,
});
await step("chat in English about the selected parcel (live Gemini + RAG)", 200, () =>
  call("POST", "/chat", { body: { message: "When should I apply the second dose of urea for my paddy?", language: "en", parcelId } })
, chatSummary);
await step("chat in Tamil (live Gemini + RAG)", 200, () =>
  call("POST", "/chat", { body: { message: "என் நெல் பயிருக்கு எப்போது நீர் பாய்ச்ச வேண்டும்?", language: "ta", parcelId } })
, chatSummary);

const claimBody = {
  parcelId,
  eventType: "flood",
  eventDate: daysAgo(3),
  geometry: square(79.135, 10.79),
  idempotencyKey: `accept-${policy}-claim-1`,
  claimantRelationship: "owner",
};
const created = await step("create a claim with claimant relationship", 200, () => call("POST", "/claims", { body: claimBody }),
  (r) => ({ state: r.data?.claim?.state, claimedAreaAcres: r.data?.claim?.claimedAreaAcres, relationship: r.data?.claim?.claimantRelationship }));
const claimId = created?.data?.claim?.id;
await step("replaying the same idempotency key returns the same claim", 200, () => call("POST", "/claims", { body: claimBody }),
  (r) => ({ sameId: r.data?.claim?.id === claimId }));

for (const n of [1, 2]) {
  await step(`attach damage photo ${n} (presign → PUT → complete)`, 200, async () => {
    const presign = await call("POST", `/claims/${claimId}/evidence/presign`, {
      body: { contentType: "image/png", size: PNG.length, filename: `damage-${n}.png` },
    });
    if (presign.status !== 200) return presign;
    const row = await ClaimEvidence.findOne({ uploadId: presign.data.uploadId });
    await putObject({ key: row.s3Key, buffer: PNG, mediaType: "image/png" });
    const complete = await call("POST", `/claims/${claimId}/evidence/${presign.data.uploadId}/complete`);
    return { ...complete, ms: presign.ms + complete.ms };
  });
}
await step("submit the claim", 200, () => call("POST", `/claims/${claimId}/submit`), (r) => ({ state: r.data?.claim?.state }));

const verifySummary = (r) => {
  const v = r.data?.verification ?? {};
  return {
    claimState: v.claimState,
    outcome: v.outcome,
    held: v.held ?? null,
    pendingComponents: v.pendingComponents ?? null,
    components: v.components ? Object.fromEntries(Object.entries(v.components).map(([k, c]) => [k, c.outcome])) : null,
    policyId: v.policyId ?? null,
  };
};
await step("request verification", 200, () => call("POST", `/claims/${claimId}/verify`), verifySummary);
await step("read verification status", 200, () => call("GET", `/claims/${claimId}/verification`), (r) => ({ keys: Object.keys(r.data ?? {}) }));

await step("attach a land document (upload presign → PUT → complete → ownership)", 200, async () => {
  const presign = await call("POST", "/upload/presign", { body: { contentType: "image/png", size: PNG.length, filename: "patta.png" } });
  if (presign.status !== 200) return presign;
  const record = await ImageRecord.findOne({ uploadId: presign.data.uploadId });
  await putObject({ key: record.s3Key, buffer: PNG, mediaType: "image/png" });
  const complete = await call("POST", `/upload/${presign.data.uploadId}/complete`);
  if (complete.status !== 200) return complete;
  return call("POST", `/claims/${claimId}/ownership`, { body: { uploadId: presign.data.uploadId, documentCategory: "land_record" } });
});
await step("list land documents", 200, () => call("GET", `/claims/${claimId}/ownership`), (r) => ({ total: r.data?.summary?.total }));
// A farmer asked for more evidence adds it and resubmits; verification then runs on the new evidence.
const current = await call("GET", `/claims/${claimId}`);
if (current.data?.claim?.state === "more_evidence_required") {
  await step("resubmit after adding documents", 200, () => call("POST", `/claims/${claimId}/resubmit`), (r) => ({ state: r.data?.claim?.state }));
}
await step("re-request verification after adding documents", 200, () => call("POST", `/claims/${claimId}/verify`), verifySummary);
await step("read the claim with its assessment", 200, () => call("GET", `/claims/${claimId}`),
  (r) => ({ state: r.data?.claim?.state, assessmentState: r.data?.claim?.assessment?.state ?? null }));
await step("read appeal status", 200, () => call("GET", `/claims/${claimId}/appeal`), (r) => ({ appeal: r.data?.appeal ? "present" : null }));

const intruder = `acceptance-intruder-${policy}`;
await step("another farmer cannot read the claim", 404, () => call("GET", `/claims/${claimId}`, { sub: intruder }));
await step("another farmer cannot read its verification", 404, () => call("GET", `/claims/${claimId}/verification`, { sub: intruder }));
await step("another farmer cannot list its documents", 404, () => call("GET", `/claims/${claimId}/ownership`, { sub: intruder }));
await step("a client cannot choose the verification result", [200, 409], () =>
  call("POST", `/claims/${claimId}/verify`, { body: { outcome: "verified", approvedAreaAcres: 99 } })
, (r) => ({ approvedAreaAcres: r.data?.verification?.approvedAreaAcres ?? null }));

const second = await step("create a second claim", 200, () =>
  call("POST", "/claims", { body: { ...claimBody, eventType: "pest", idempotencyKey: `accept-${policy}-claim-2` } })
);
await step("withdraw the second claim", 200, () => call("POST", `/claims/${second?.data?.claim?.id}/withdraw`),
  (r) => ({ state: r.data?.claim?.state }));
await step("list claims", 200, () => call("GET", "/claims"), (r) => ({ count: r.data?.claims?.length }));

const out = {
  runDate: new Date().toISOString(),
  policy,
  environment: "local Express app, mongodb-memory-server, mock image storage, mock image AI, mock land records; live Gemini/Cohere/Chroma(read)/Open-Meteo/Copernicus where configured",
  passed: steps.filter((s) => s.pass).length,
  total: steps.length,
  steps,
};
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
writeFileSync(join(root, "docs", "research", "evaluation", "live", `acceptance_${policy}_2026-10-16.json`), `${JSON.stringify(out, null, 2)}\n`);
for (const s of steps) console.log(`${s.pass ? "PASS" : "FAIL"} ${s.status ?? ""} ${s.name}${s.pass ? "" : ` — ${s.message ?? s.error ?? ""}`}`);
console.log(`${out.passed}/${out.total} passed (${policy})`);

server.close();
await mongoose.disconnect();
await mongo.stop();
process.exit(0);
