import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-024 (plan A8, DS) — the dev-only upload receiver that stands in for S3 presigned URLs in the
// hermetic e2e harness, and the production guard that keeps every dev/test seam out of production.
// This file runs the app WITH the receiver (mock storage + DEV_STORAGE_RECEIVER=true, not production);
// DS-3 starts child processes with the other configurations.
vi.hoisted(() => {
  process.env.DEV_STORAGE_RECEIVER = "true";
  process.env.DEV_STORAGE_PUBLIC_BASE_URL = "http://127.0.0.1:18080";
});

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ImageRecord from "../models/ImageRecord.js";
import { headObject, getObject, putObject } from "../services/s3.service.js";
import { assertProductionSafety, isDevStorageReceiverEnabled, productionSafetyViolations, PRODUCTION_FORBIDDEN_SEAMS } from "../config/env.js";
import { buildDevStorageUrl, isAllowedDevStorageKey, verifyDevStorage } from "../utils/devStorageSignature.js";
import { maskUrl } from "../utils/logger.js";
import { api, authHeader, startTestDatabase, stopTestDatabase } from "./helpers.js";
import { PNG, createClaim, resetDatabase, seedFarmer } from "./fixtures/claimFlow.js";

const BASE = "http://127.0.0.1:18080";
// The path and query of a receiver URL, to send through supertest.
const pathOf = (url) => {
  expect(url.startsWith(`${BASE}/__dev/storage/`)).toBe(true);
  return url.slice(BASE.length);
};
const withQuery = (url, changes) => {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(changes)) parsed.searchParams.set(key, value);
  return `${parsed.pathname}${parsed.search}`;
};

const runChild = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, LOG_LEVEL: "silent", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
const GUARD = ["--import", "./tests/fixtures/networkGuard.js"];

describe("dev upload receiver and production guard (DS)", () => {
  let mongo;
  beforeAll(async () => {
    mongo = await startTestDatabase();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it("DS-1: presign returns a signed receiver URL; a raw PUT with the signed type stores the object; complete stores the photo; the /upload presign works the same", async () => {
    expect(isDevStorageReceiverEnabled()).toBe(true);
    const farmer = await seedFarmer("ds1");
    const claimId = await createClaim(farmer);
    const presign = await api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(farmer.user)).send({ contentType: "image/png", size: PNG.length, filename: "photo.png" });
    expect(presign.status).toBe(200);
    const { uploadId, uploadUrl } = presign.body.data;
    expect(uploadUrl).toMatch(new RegExp(`^${BASE}/__dev/storage/uploads/claims/${claimId}/${uploadId}/image\\.png\\?ct=image%2Fpng&exp=\\d+&sig=[A-Za-z0-9_-]+$`));
    // No mock-bucket placeholder and no AWS host.
    expect(uploadUrl).not.toContain("mock-bucket.local");
    expect(uploadUrl).not.toContain("amazonaws");

    const put = await api().put(pathOf(uploadUrl)).set("Content-Type", "image/png").send(PNG);
    expect(put.status).toBe(200);
    const evidence = await ClaimEvidence.findOne({ uploadId }).lean();
    expect(await headObject(evidence.s3Key)).toEqual({ size: PNG.length, mediaType: "image/png" });

    const completed = await api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(farmer.user));
    expect(completed.status).toBe(200);
    expect(completed.body.data.evidence.status).toBe("stored");

    // The farmer's view URL is a signed receiver GET.
    const view = await api().get(`/claims/${claimId}/evidence/${uploadId}/url`).set(authHeader(farmer.user));
    expect(view.status).toBe(200);
    const viewUrl = view.body.data.url || view.body.data.signedUrl;
    expect(viewUrl).toMatch(new RegExp(`^${BASE}/__dev/storage/uploads/claims/${claimId}/${uploadId}/image\\.png\\?exp=\\d+&sig=`));

    // POST /upload/presign (land documents, chat images): key uploads/<cognitoSub>/<uploadId>/...
    const upload = await api().post("/upload/presign").set(authHeader(farmer.user)).send({ contentType: "image/png", size: PNG.length, filename: "doc.png" });
    expect(upload.status).toBe(200);
    expect(upload.body.data.uploadUrl).toContain(`/__dev/storage/uploads/${farmer.user}/${upload.body.data.uploadId}/image.png?ct=image%2Fpng`);
    expect((await api().put(pathOf(upload.body.data.uploadUrl)).set("Content-Type", "image/png").send(PNG)).status).toBe(200);
    expect((await api().post(`/upload/${upload.body.data.uploadId}/complete`).set(authHeader(farmer.user))).status).toBe(200);
    expect((await ImageRecord.findOne({ uploadId: upload.body.data.uploadId }).lean()).status).toBe("stored");
  });

  it("DS-2: a bad signature, an expired link, the wrong Content-Type, a GET-signed link used for PUT, or a key outside the presign layouts is refused (403) and stores nothing; an oversized body is 413", async () => {
    const farmer = await seedFarmer("ds2");
    const claimId = await createClaim(farmer);
    const presign = await api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(farmer.user)).send({ contentType: "image/png", size: PNG.length, filename: "photo.png" });
    const { uploadId, uploadUrl } = presign.body.data;
    const key = (await ClaimEvidence.findOne({ uploadId }).lean()).s3Key;
    const sig = new URL(uploadUrl).searchParams.get("sig");
    const tampered = `${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;

    const refusals = [
      ["tampered signature", api().put(withQuery(uploadUrl, { sig: tampered })).set("Content-Type", "image/png").send(PNG)],
      ["signature for another type", api().put(withQuery(uploadUrl, { ct: "image/jpeg" })).set("Content-Type", "image/jpeg").send(PNG)],
      ["expiry pushed later", api().put(withQuery(uploadUrl, { exp: String(Math.floor(Date.now() / 1000) + 99999) })).set("Content-Type", "image/png").send(PNG)],
      ["wrong Content-Type header", api().put(pathOf(uploadUrl)).set("Content-Type", "image/jpeg").send(PNG)],
      ["expired link", api().put(pathOf(buildDevStorageUrl({ baseUrl: BASE, method: "PUT", key, contentType: "image/png", expiresInSeconds: 60, now: Date.now() - 3_600_000 }))).set("Content-Type", "image/png").send(PNG)],
      ["GET-signed link used to PUT", api().put(withQuery(buildDevStorageUrl({ baseUrl: BASE, method: "GET", key, expiresInSeconds: 60 }), { ct: "image/png" })).set("Content-Type", "image/png").send(PNG)],
      ["validly signed key outside uploads/", api().put(pathOf(buildDevStorageUrl({ baseUrl: BASE, method: "PUT", key: "datasets/rice.csv", contentType: "image/png", expiresInSeconds: 60 }))).set("Content-Type", "image/png").send(PNG)],
      ["validly signed key with another layout", api().put(pathOf(buildDevStorageUrl({ baseUrl: BASE, method: "PUT", key: `uploads/claims/${claimId}/../x/image.png`, contentType: "image/png", expiresInSeconds: 60 }))).set("Content-Type", "image/png").send(PNG)],
      ["no signature", api().put(`/__dev/storage/${key}?ct=image%2Fpng`).set("Content-Type", "image/png").send(PNG)],
    ];
    for (const [label, request] of refusals) {
      const response = await request;
      expect({ label, status: response.status }).toEqual({ label, status: 403 });
    }
    expect(await headObject(key)).toBeNull();

    // Larger than IMAGE_UPLOAD_MAX_BYTES (5 MB): the raw body parser refuses it.
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    expect((await api().put(pathOf(uploadUrl)).set("Content-Type", "image/png").send(big)).status).toBe(413);
    expect(await headObject(key)).toBeNull();

    // The key check on its own: only the two presign layouts.
    expect(isAllowedDevStorageKey(key)).toBe(true);
    expect(isAllowedDevStorageKey(`uploads/${farmer.user}/img_00000000-0000-4000-8000-000000000000/image.jpg`)).toBe(true);
    for (const bad of ["uploads", "uploads/x", "other/claims/0123456789abcdef01234567/img_00000000-0000-4000-8000-000000000000/image.png", `uploads/claims/not-an-id/img_00000000-0000-4000-8000-000000000000/image.png`, "uploads/a/../b/image.png", "uploads//img_00000000-0000-4000-8000-000000000000/image.png", "uploads/a/img_00000000-0000-4000-8000-000000000000/image.gif"]) {
      expect({ bad, allowed: isAllowedDevStorageKey(bad) }).toEqual({ bad, allowed: false });
    }
    // A logged receiver URL never carries its signature.
    expect(maskUrl(pathOf(uploadUrl))).not.toContain(sig);
    expect(maskUrl(pathOf(uploadUrl))).toContain("sig=<redacted>");
    expect(verifyDevStorage({ method: "PUT", key, contentType: "image/png", exp: "abc", sig })).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("DS-3: /__dev/storage is not mounted (404) in production, on Lambda, with live storage, or without the flag; it is mounted only in the dev configuration", async () => {
    const base = { IMAGE_STORAGE_MODE: "mock", DEV_STORAGE_RECEIVER: "true", NODE_ENV: "development", AWS_LAMBDA_FUNCTION_NAME: "" };
    const cases = [
      ["dev configuration", base, { enabled: true, put: 403, get: 403 }],
      ["NODE_ENV=production", { ...base, NODE_ENV: "production" }, { enabled: false, put: 404, get: 404 }],
      ["on Lambda", { ...base, AWS_LAMBDA_FUNCTION_NAME: "tnFarmingAssistant" }, { enabled: false, put: 404, get: 404 }],
      ["live storage", { ...base, IMAGE_STORAGE_MODE: "live" }, { enabled: false, put: 404, get: 404 }],
      ["flag off", { ...base, DEV_STORAGE_RECEIVER: "false" }, { enabled: false, put: 404, get: 404 }],
    ];
    for (const [label, env, expected] of cases) {
      const result = await runChild([...GUARD, "tests/fixtures/devStorageProbe.js"], env);
      expect({ label, code: result.code }).toEqual({ label, code: 0 });
      const lastLine = result.stdout.trim().split("\n").pop();
      expect({ label, ...JSON.parse(lastLine) }).toEqual({ label, ...expected });
      expect(result.stderr).not.toContain("EXTERNAL_NETWORK_BLOCKED");
    }
    // The same rule as a pure function.
    expect(isDevStorageReceiverEnabled({ IMAGE_STORAGE_MODE: "mock", DEV_STORAGE_RECEIVER: "true", NODE_ENV: "test" })).toBe(true);
    expect(isDevStorageReceiverEnabled({ IMAGE_STORAGE_MODE: "MOCK", DEV_STORAGE_RECEIVER: "TRUE", NODE_ENV: "test" })).toBe(false);
    expect(isDevStorageReceiverEnabled({ IMAGE_STORAGE_MODE: "mock", NODE_ENV: "test" })).toBe(false);
  }, 120_000);

  it("DS-4: assertProductionSafety refuses each mock mode, the receiver and the file-backed mock store in production and on Lambda; index.js and the worker run it at boot", async () => {
    const seams = {
      IMAGE_STORAGE_MODE: "mock",
      IMAGE_AI_MODE: "mock",
      LAND_RECORD_MODE: "mock",
      WEATHER_MODE: "mock",
      SATELLITE_MODE: "mock",
      DEV_STORAGE_RECEIVER: "true",
      IMAGE_STORAGE_MOCK_DIR: "/tmp/vivasayi-mock",
    };
    expect(PRODUCTION_FORBIDDEN_SEAMS.map((entry) => entry.key).sort()).toEqual(Object.keys(seams).sort());
    for (const runtime of [{ NODE_ENV: "production" }, { NODE_ENV: "development", AWS_LAMBDA_FUNCTION_NAME: "tnFarmingAssistant" }]) {
      for (const [key, value] of Object.entries(seams)) {
        const source = { ...runtime, [key]: value };
        expect(productionSafetyViolations(source)).toEqual([key]);
        expect(() => assertProductionSafety(source)).toThrow(new RegExp(`Refusing to start: dev/test seam\\(s\\) ${key} `));
      }
      // Case does not help, and the message names variables, never values.
      expect(() => assertProductionSafety({ ...runtime, WEATHER_MODE: "MOCK" })).toThrow(/WEATHER_MODE/);
      try {
        assertProductionSafety({ ...runtime, IMAGE_STORAGE_MOCK_DIR: "/secret/path" });
      } catch (error) {
        expect(error.message).not.toContain("/secret/path");
      }
      expect(assertProductionSafety({ ...runtime, IMAGE_STORAGE_MODE: "live", IMAGE_AI_MODE: "live", LAND_RECORD_MODE: "live", WEATHER_MODE: "live", SATELLITE_MODE: "off", DEV_STORAGE_RECEIVER: "false" })).toBe(true);
    }
    // Development and tests may use every seam.
    expect(assertProductionSafety({ NODE_ENV: "development", ...seams })).toBe(true);
    expect(assertProductionSafety({ NODE_ENV: "test", ...seams })).toBe(true);

    // Boot wiring: the API entry point and the worker refuse to start.
    const required = { MONGO_URI: "mongodb://127.0.0.1:1/ds4", GOOGLE_API_KEY: "test-placeholder", COHERE_API_KEY: "test-placeholder", CHROMA_API_KEY: "test-placeholder", CHROMA_TENANT: "test-placeholder", CHROMA_DATABASE: "test-placeholder" };
    const indexRun = await runChild([...GUARD, "index.js"], { ...required, NODE_ENV: "production", IMAGE_STORAGE_MODE: "mock", AWS_LAMBDA_FUNCTION_NAME: "" });
    expect(indexRun.code).not.toBe(0);
    expect(indexRun.stderr).toContain("Refusing to start: dev/test seam(s) IMAGE_STORAGE_MODE");
    expect(indexRun.stderr).not.toContain("EXTERNAL_NETWORK_BLOCKED");
    const workerRun = await runChild([...GUARD, "scripts/worker.js", "--once"], { ...required, NODE_ENV: "production", SATELLITE_MODE: "mock", IMAGE_STORAGE_MODE: "live", IMAGE_AI_MODE: "live" });
    expect(workerRun.code).toBe(1);
    expect(workerRun.stderr).toContain("Refusing to start: dev/test seam(s) SATELLITE_MODE");
    expect(workerRun.stderr).not.toContain("EXTERNAL_NETWORK_BLOCKED");
  }, 120_000);

  it("DS-5: a signed GET returns the bytes with a cross-origin CORP header and no caching; a tampered or PUT-signed GET is refused", async () => {
    const farmer = await seedFarmer("ds5");
    const claimId = await createClaim(farmer);
    const presign = await api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(farmer.user)).send({ contentType: "image/png", size: PNG.length, filename: "photo.png" });
    const { uploadId, uploadUrl } = presign.body.data;
    expect((await api().put(pathOf(uploadUrl)).set("Content-Type", "image/png").send(PNG)).status).toBe(200);
    const key = (await ClaimEvidence.findOne({ uploadId }).lean()).s3Key;

    const getUrl = buildDevStorageUrl({ baseUrl: BASE, method: "GET", key, expiresInSeconds: 300 });
    const response = await api().get(pathOf(getUrl)).buffer(true).parse((res, done) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    expect(Buffer.compare(response.body, PNG)).toBe(0);
    expect(response.headers["content-type"]).toMatch(/^image\/png/);
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(response.headers["cache-control"]).toBe("private, no-store");

    const sig = new URL(getUrl).searchParams.get("sig");
    expect((await api().get(withQuery(getUrl, { sig: `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}` }))).status).toBe(403);
    // The PUT URL's signature covers method and type: it is not a read capability.
    expect((await api().get(pathOf(uploadUrl))).status).toBe(403);
    // Missing object: 404 (signed correctly for a key that does not exist).
    const missing = buildDevStorageUrl({ baseUrl: BASE, method: "GET", key: key.replace(/img_[0-9a-f-]{36}/, "img_00000000-0000-4000-8000-000000000000"), expiresInSeconds: 60 });
    expect((await api().get(pathOf(missing))).status).toBe(404);
  });

  it("DS-5b: with IMAGE_STORAGE_MOCK_DIR the mock bucket is file-backed, so an object one process stores is read by another (process worker)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vivasayi-ds5b-"));
    try {
      const script = (code) => ["--input-type=module", "-e", `const s3 = await import(${JSON.stringify(path.resolve(import.meta.dirname, "..", "services", "s3.service.js"))});\n${code}`];
      const env = { IMAGE_STORAGE_MODE: "mock", IMAGE_STORAGE_MOCK_DIR: dir, S3_BUCKET: "ds5b" };
      const key = "uploads/claims/0123456789abcdef01234567/img_00000000-0000-4000-8000-000000000000/image.png";
      const writer = await runChild([...GUARD, ...script(`await s3.putObject({ key: ${JSON.stringify(key)}, buffer: Buffer.from(${JSON.stringify(PNG.toString("base64"))}, "base64"), mediaType: "image/png" }); console.log("stored");`)], env);
      expect(writer.stdout.trim()).toBe("stored");
      const reader = await runChild([...GUARD, ...script(`const head = await s3.headObject(${JSON.stringify(key)}); const got = await s3.getObject(${JSON.stringify(key)}); console.log(JSON.stringify({ head, bytes: got.buffer.toString("base64"), mediaType: got.mediaType }));`)], env);
      expect(JSON.parse(reader.stdout.trim())).toEqual({ head: { size: PNG.length, mediaType: "image/png" }, bytes: PNG.toString("base64"), mediaType: "image/png" });
      // Files are named by a hash, never by the key (no key can reach outside the directory).
      const files = fs.readdirSync(dir).sort();
      expect(files).toHaveLength(2);
      for (const file of files) expect(file).toMatch(/^[0-9a-f]{64}\.(bin|json)$/);
      const remover = await runChild([...GUARD, ...script(`await s3.deleteObject(${JSON.stringify(key)}); console.log(JSON.stringify(await s3.headObject(${JSON.stringify(key)})));`)], env);
      expect(remover.stdout.trim()).toBe("null");
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // This process (no IMAGE_STORAGE_MOCK_DIR) still uses the in-memory bucket.
    await putObject({ key: "uploads/x/img_00000000-0000-4000-8000-000000000000/image.png", buffer: PNG, mediaType: "image/png" });
    expect((await getObject("uploads/x/img_00000000-0000-4000-8000-000000000000/image.png")).buffer).toBe(PNG);
  }, 60_000);
});
