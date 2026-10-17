import { afterEach, describe, expect, it, vi } from "vitest";

// ADR-024 (plan A8, HX-1..5) — the hermetic e2e harness's guards, unit-level: refusing production and
// live credentials, the loopback network guard, the fake Gemini against the REAL prompt constants and
// claim-vision code path, and the control server's token rule. The booted harness is covered by
// tests/e2eHarness.smoke.test.js (MK-3, HX-6).
vi.hoisted(() => {
  // The real claim-vision path, so the fake's errors go through the production classification.
  process.env.IMAGE_AI_MODE = "live";
});

import { spawn } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import request from "supertest";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  E2E_ENV_FILE,
  LIVE_CREDENTIAL_KEYS,
  PLACEHOLDER_KEYS,
  applyE2eEnv,
  checkHermeticEnv,
  checkLocalMongoUri,
  isLoopbackMongoUri,
  preflightRefusal,
  readE2eEnvFile,
} from "../scripts/e2e/lib/hermeticEnv.js";
import { installNetworkGuard, isLoopbackHost, networkViolations, uninstallNetworkGuard } from "../scripts/e2e/lib/networkGuard.js";
import { createFakeGemini, installFakeGemini, loadPromptConstants, parseAiMode, providerError, OBSERVATIONS } from "../scripts/e2e/lib/fakeGemini.js";
import { createControlApp, isPublicPath, tokenMatches } from "../scripts/e2e/lib/controlServer.js";
import { parseHarnessArgs } from "../scripts/e2e/hermeticBackend.js";
import { utcEventDate, overLimitGeometry, defaultParcelGeometry } from "../scripts/e2e/lib/seedHelpers.js";
import { CLAIM_LOSS_VISION_INSTRUCTIONS } from "../src/ai/ClaimLossVisionTemplates.js";
import { LAND_DOCUMENT_SYSTEM_INSTRUCTIONS } from "../services/landDocumentExamination.service.js";
import { model } from "../services/chat.service.js";
import { analyzeClaimImage } from "../services/claimVision.service.js";
import { classifyProviderError } from "../utils/providerErrors.js";
import { api, authHeader } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const HARNESS = path.join(ROOT, "scripts", "e2e", "hermeticBackend.js");

const runHarnessChild = (env, args = []) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "./tests/fixtures/networkGuard.js", HARNESS, "--port=0", "--control-port=0", ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });

// A complete, valid harness environment (what e2e.env plus the harness's own values produce).
const hermeticSource = () => {
  const source = applyE2eEnv(readE2eEnvFile(), {});
  source.MONGO_URI = "mongodb://127.0.0.1:27999/vivasayi_e2e";
  source.SESSION_JWT_SECRET = "x".repeat(64);
  return source;
};

describe("hermetic e2e harness guards (HX)", () => {
  afterEach(() => {
    uninstallNetworkGuard();
  });

  it("HX-1: a production or Lambda process never becomes a harness (refused before anything loads, no out file)", async () => {
    expect(preflightRefusal({ NODE_ENV: "production" })).toMatch(/production/);
    expect(preflightRefusal({ AWS_LAMBDA_FUNCTION_NAME: "tnFarmingAssistant" })).toMatch(/Lambda/);
    expect(preflightRefusal({ NODE_ENV: "development" })).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vivasayi-hx1-"));
    try {
      for (const env of [{ NODE_ENV: "production" }, { AWS_LAMBDA_FUNCTION_NAME: "tnFarmingAssistant" }]) {
        const out = path.join(dir, `${Object.keys(env)[0]}.json`);
        const result = await runHarnessChild(env, [`--out=${out}`]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("refusing to start");
        expect(fs.existsSync(out)).toBe(false);
        expect(result.stderr).not.toContain("EXTERNAL_NETWORK_BLOCKED");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Argument parsing: defaults are the documented ports, bad values are usage errors.
    expect(parseHarnessArgs([])).toMatchObject({ port: 18080, controlPort: 18081, mongo: "memory", worker: "inline", errors: [] });
    expect(parseHarnessArgs(["--port", "19000", "--control-port=19001", "--worker=process", "--mongo", "local"])).toMatchObject({ port: 19000, controlPort: 19001, worker: "process", mongo: "local", errors: [] });
    expect(parseHarnessArgs(["--port=18080", "--control-port=18080"]).errors).toHaveLength(1);
    expect(parseHarnessArgs(["--worker=sometimes", "--bogus"]).errors).toHaveLength(2);
  }, 120_000);

  it("HX-2: the harness refuses any live credential, a non-placeholder AI key, a missing seam or a database that is not on this machine; e2e.env overrides the shell and holds no secret", () => {
    // The committed file: every live credential blank, AI keys the placeholder, nothing secret-looking.
    const file = readE2eEnvFile();
    for (const key of LIVE_CREDENTIAL_KEYS.filter((name) => !name.startsWith("AWS_") || name in file)) expect({ key, value: file[key] }).toEqual({ key, value: "" });
    for (const key of PLACEHOLDER_KEYS) expect(file[key]).toBe("e2e-placeholder");
    expect(file.VIVASAYI_SKIP_DOTENV).toBe("1");
    expect(file.SESSION_JWT_SECRET).toBe("");
    expect(file.MONGO_URI).toBe("");
    expect(file.CLAIM_VERIFICATION_POLICY).toBe("v1.1-safe-ai");
    expect(file.ACCESS_TOKEN_TTL_MS).toBe("7200000");
    expect(file.CORS_ORIGINS.split(",")).toEqual(expect.arrayContaining(["http://127.0.0.1:15173", "http://localhost:15173"]));
    expect(Object.keys(file).filter((key) => /RATE_LIMIT/.test(key))).toEqual([]); // D5 defaults are tested
    expect(fs.readFileSync(E2E_ENV_FILE, "utf8")).not.toMatch(/AIza[0-9A-Za-z_-]{20,}|mongodb\+srv|AKIA[0-9A-Z]{16}/);

    // The shell's credentials are overridden by the file (blanked), whatever they were.
    const shell = { MY_AWS_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE00", GOOGLE_API_KEY: "a-real-looking-key", E2E_MONGO_URI: "mongodb://127.0.0.1:1/vivasayi_e2e_x" };
    applyE2eEnv(file, shell);
    expect(shell).toMatchObject({ MY_AWS_ACCESS_KEY_ID: "", GOOGLE_API_KEY: "e2e-placeholder", E2E_MONGO_URI: "mongodb://127.0.0.1:1/vivasayi_e2e_x" });

    expect(checkHermeticEnv({ source: hermeticSource() })).toEqual([]);
    for (const key of LIVE_CREDENTIAL_KEYS) {
      const problems = checkHermeticEnv({ source: { ...hermeticSource(), [key]: "set" } });
      expect(problems).toEqual([`${key} is set (live credentials must be empty)`]);
    }
    expect(checkHermeticEnv({ source: { ...hermeticSource(), GOOGLE_API_KEY: "AIzaSomethingReal" } })).toEqual(["GOOGLE_API_KEY is not the e2e placeholder"]);
    expect(checkHermeticEnv({ source: { ...hermeticSource(), IMAGE_STORAGE_MODE: "live" } })).toEqual(["IMAGE_STORAGE_MODE must be mock"]);
    expect(checkHermeticEnv({ source: { ...hermeticSource(), CLAIM_VERIFICATION_DRAIN_ON_READ: "true" } })).toEqual(["CLAIM_VERIFICATION_DRAIN_ON_READ must be false"]);
    expect(checkHermeticEnv({ source: { ...hermeticSource(), NODE_ENV: "production" } })).toContain("NODE_ENV is production");
    for (const uri of ["mongodb+srv://user:pw@cluster0.example.mongodb.net/db", "mongodb://db.example.com:27017/x", "mongodb://127.0.0.1:27017,10.0.0.5:27017/x", ""]) {
      expect(checkHermeticEnv({ source: { ...hermeticSource(), MONGO_URI: uri } })).toEqual(["MONGO_URI is not a database on this machine"]);
    }
    // What config/env.js actually loaded is checked too.
    const appEnv = { googleApiKey: "e2e-placeholder", cohereApiKey: "e2e-placeholder", awsAccessKeyId: "", awsSecretAccessKey: "", cognitoClientSecret: "", imageStorageMode: "mock", mongoUri: "mongodb://127.0.0.1:1/vivasayi_e2e" };
    expect(checkHermeticEnv({ source: hermeticSource(), appEnv })).toEqual([]);
    expect(checkHermeticEnv({ source: hermeticSource(), appEnv: { ...appEnv, googleApiKey: "AIza-from-dotenv" } })).toEqual(["config/env.js googleApiKey is not the e2e placeholder"]);
    expect(checkHermeticEnv({ source: hermeticSource(), appEnv: { ...appEnv, awsAccessKeyId: "AKIA" } })).toEqual(["config/env.js awsAccessKeyId is set"]);

    expect(isLoopbackMongoUri("mongodb://localhost:27017/x")).toBe(true);
    expect(isLoopbackMongoUri("mongodb://user:pw@[::1]:27017/x")).toBe(true);
    expect(checkLocalMongoUri("mongodb://127.0.0.1:27017/vivasayi_e2e_run1")).toBeNull();
    expect(checkLocalMongoUri("mongodb+srv://cluster0.example.mongodb.net/vivasayi_e2e")).toMatch(/srv/);
    expect(checkLocalMongoUri("mongodb://10.0.0.5:27017/vivasayi_e2e")).toMatch(/this machine/);
    expect(checkLocalMongoUri("mongodb://127.0.0.1:27017/production")).toMatch(/vivasayi_e2e/);
    expect(checkLocalMongoUri("")).toMatch(/not set/);
  });

  it("HX-3: the network guard blocks and records every non-loopback connect, TLS connect, fetch and DNS query, and lets loopback through", async () => {
    const recorded = [];
    installNetworkGuard({ label: "E2E", onViolation: (violation) => recorded.push(violation) });
    expect(() => net.connect({ host: "192.0.2.10", port: 443 })).toThrow(/E2E_EXTERNAL_NETWORK_BLOCKED: connect 192\.0\.2\.10:443/);
    expect(() => net.connect(80, "203.0.113.7")).toThrow(/E2E_EXTERNAL_NETWORK_BLOCKED/);
    expect(() => tls.connect({ host: "generativelanguage.googleapis.com", port: 443 })).toThrow(/E2E_EXTERNAL_NETWORK_BLOCKED: tls generativelanguage\.googleapis\.com:443/);
    expect(() => dns.lookup("api.open-meteo.com", () => {})).toThrow(/dns\.lookup api\.open-meteo\.com/);
    await expect(dns.promises.resolveSrv("_mongodb._tcp.cluster0.example.mongodb.net")).rejects.toThrow(/dns\.resolveSrv/);
    expect(() => new dns.Resolver().resolve4("catalogue.dataspace.copernicus.eu", () => {})).toThrow(/E2E_EXTERNAL_NETWORK_BLOCKED/);
    await expect(fetch("http://192.0.2.10:8080/")).rejects.toThrow();
    await expect(fetch("https://api.open-meteo.com/v1/forecast")).rejects.toThrow();
    const kinds = networkViolations().map((violation) => `${violation.kind} ${violation.host}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "connect 192.0.2.10",
        "connect 203.0.113.7",
        "tls generativelanguage.googleapis.com",
        "dns.lookup api.open-meteo.com",
        "dns.resolveSrv _mongodb._tcp.cluster0.example.mongodb.net",
        "dns.resolve4 catalogue.dataspace.copernicus.eu",
      ])
    );
    expect(kinds.filter((entry) => entry === "connect 192.0.2.10").length).toBeGreaterThanOrEqual(2); // net.connect + fetch
    expect(recorded.length).toBe(networkViolations().length);
    expect(networkViolations()[0]).toMatchObject({ port: 443 });
    expect(networkViolations()[0].frame).toMatch(/e2eHarness\.unit\.test\.js/);

    // Loopback is allowed: a real round trip to a local server.
    const server = http.createServer((req, res) => res.end("ok"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const local = await fetch(`http://127.0.0.1:${server.address().port}/`);
    expect(await local.text()).toBe("ok");
    const viaName = await fetch(`http://localhost:${server.address().port}/`).catch(() => null);
    if (viaName) expect(viaName.status).toBe(200);
    server.close();
    for (const host of ["127.0.0.1", "localhost", "::1", "127.8.9.10", "::ffff:127.0.0.1", ""]) expect({ host, ok: isLoopbackHost(host) }).toEqual({ host, ok: true });
    for (const host of ["10.0.0.1", "0.0.0.0", "example.com", "128.0.0.1"]) expect({ host, ok: isLoopbackHost(host) }).toEqual({ host, ok: false });

    uninstallNetworkGuard();
    expect(networkViolations()).toEqual([]);
    expect(() => new net.Socket().connect({ path: "/nonexistent/vivasayi.sock" }).on("error", () => {}).destroy()).not.toThrow();
  });

  it("HX-4: the fake Gemini recognises the REAL claim-vision and land-document prompts and drives the real vision code path: damage, no_damage, 429 (quota), 503 (overload), timeout, malformed, empty, failN", async () => {
    const prompts = await loadPromptConstants();
    expect(prompts).toEqual({ claimVision: CLAIM_LOSS_VISION_INSTRUCTIONS, landDocument: LAND_DOCUMENT_SYSTEM_INSTRUCTIONS });
    expect(() => createFakeGemini({ prompts: { claimVision: "x" } })).toThrow(/prompt constants/);
    const fake = createFakeGemini({ prompts, timeoutMs: () => 300 });
    const conversation = (system) => [[new SystemMessage(system), new HumanMessage({ content: [{ type: "text", text: "x" }] })]];
    expect(fake.classify(conversation(CLAIM_LOSS_VISION_INSTRUCTIONS))).toBe("claim_vision");
    expect(fake.classify(conversation(LAND_DOCUMENT_SYSTEM_INSTRUCTIONS))).toBe("land_document");
    expect(fake.classify(conversation("You are Vivasayi AI, a farming assistant."))).toBe("other");

    const restore = installFakeGemini(model, fake);
    try {
      const image = { imageBuffer: Buffer.from("fake-image"), mediaType: "image/jpeg" };
      fake.configure({ ai: "damage" });
      expect(await analyzeClaimImage(image)).toMatchObject({ damageDetected: true, damageType: "flood", confidence: "high", uncertain: false });
      fake.configure({ ai: "no_damage" });
      expect(await analyzeClaimImage(image)).toMatchObject({ damageDetected: false, confidence: "high" });
      fake.configure({ ai: "uncertain" });
      expect(await analyzeClaimImage(image)).toMatchObject({ uncertain: true, confidence: "low" });

      const kindOf = async (options = {}) => {
        try {
          await analyzeClaimImage({ ...image, ...options });
          return "answered";
        } catch (error) {
          return error.kind;
        }
      };
      fake.configure({ ai: "q429" });
      expect(await kindOf()).toBe("quota");
      fake.configure({ ai: "q503" });
      expect(await kindOf()).toBe("overload");
      fake.configure({ ai: "timeout" });
      expect(await kindOf({ timeoutMs: 50 })).toBe("timeout");
      fake.configure({ ai: "malformed" });
      expect(await kindOf({ onUnparseable: "throw" })).toBe("malformed_response");
      expect(await analyzeClaimImage(image)).toMatchObject({ uncertain: true, confidence: "unclear" }); // legacy "unsure"
      fake.configure({ ai: "empty" });
      expect(await kindOf({ onUnparseable: "throw" })).toBe("malformed_response");
      fake.configure({ ai: "failN:q503:2" });
      expect([await kindOf(), await kindOf(), await kindOf()]).toEqual(["overload", "overload", "answered"]);
      // A new scenario restarts the count.
      fake.configure({ ai: "failN:q429:1" });
      expect([await kindOf(), await kindOf()]).toEqual(["quota", "answered"]);

      // Land documents: a normalised extraction naming the farmer, or the selected failure.
      fake.configure({ landDocument: "ok", holderNames: ["Murugan Selvam"] });
      const extraction = JSON.parse((await model.generate(conversation(LAND_DOCUMENT_SYSTEM_INSTRUCTIONS))).generations[0][0].text);
      expect(extraction).toMatchObject({ documentType: "land_record", holderNames: ["Murugan Selvam"], state: "Tamil Nadu", unreadable: false });
      fake.configure({ landDocument: "q429" });
      await expect(model.generate(conversation(LAND_DOCUMENT_SYSTEM_INSTRUCTIONS))).rejects.toMatchObject({ status: 429 });
      expect(fake.snapshot().calls).toMatchObject({ claim_vision: expect.any(Number), land_document: 2 });
    } finally {
      restore();
    }

    // SDK-shaped provider errors, classified by the production taxonomy.
    const quota = providerError("q429");
    expect(quota.constructor.name).toBe("GoogleGenerativeAIFetchError");
    expect(quota).toMatchObject({ status: 429, statusText: "Too Many Requests" });
    expect(quota.message).toMatch(/\[429 Too Many Requests\] Resource has been exhausted/);
    expect(JSON.stringify(quota.errorDetails)).toContain("RESOURCE_EXHAUSTED");
    expect(classifyProviderError(quota)).toBe("quota");
    expect(classifyProviderError(providerError("q503"))).toBe("overload");
    expect(quota.message).not.toMatch(/key=|AIza/);

    expect(parseAiMode("damage")).toEqual({ mode: "damage" });
    expect(parseAiMode("failN:timeout:3")).toEqual({ mode: "failN", failMode: "timeout", count: 3 });
    for (const bad of ["", "failN:damage:2", "failN:q429:x", "q500", "DAMAGE"]) expect({ bad, parsed: parseAiMode(bad) }).toEqual({ bad, parsed: null });
    expect(() => fake.configure({ ai: "q500" })).toThrow(/Unknown ai mode/);
    expect(() => fake.configure({ landDocument: "maybe" })).toThrow(/Unknown landDocument mode/);
    expect(OBSERVATIONS.damage.damageDetected).toBe(true);
  });

  it("HX-5: the control server needs the bearer token for everything but health, tiles and geocoding, and none of it exists on the product API", async () => {
    const token = "hx5-control-token-0123456789";
    const deps = {
      health: async () => ({ apiUrl: "http://127.0.0.1:1" }),
      createSession: async () => ({ accessToken: "a" }),
      getScenario: async () => ({ ai: "damage" }),
      applyScenario: async () => ({ ai: "damage" }),
      scenarios: async () => ({ scenarios: [] }),
      worker: async (action) => ({ action }),
      inspect: async (id) => ({ claimId: id }),
      seedClaim: async () => ({ claimId: "x" }),
      fixtureImage: async () => Buffer.from([0xff, 0xd8, 0xff]),
      violations: async () => [],
      tile: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    };
    expect(() => createControlApp({ token: "short", deps })).toThrow(/at least 16/);
    const app = createControlApp({ token, deps });
    const protectedRoutes = [
      ["post", "/__e2e/session"],
      ["get", "/__e2e/scenario"],
      ["post", "/__e2e/scenario"],
      ["get", "/__e2e/scenarios"],
      ["post", "/__e2e/worker"],
      ["get", "/__e2e/claims/0123456789abcdef01234567/inspect"],
      ["post", "/__e2e/seed-claim"],
      ["get", "/__e2e/fixture-image?seed=1"],
      ["get", "/__e2e/network-violations"],
    ];
    for (const [method, route] of protectedRoutes) {
      expect({ route, status: (await request(app)[method](route)).status }).toEqual({ route, status: 401 });
      expect({ route, status: (await request(app)[method](route).set("Authorization", "Bearer wrong-token-0123456789")).status }).toEqual({ route, status: 401 });
      expect({ route, status: (await request(app)[method](route).set("Authorization", token)).status }).toEqual({ route, status: 401 });
      expect({ route, status: (await request(app)[method](route).set("Authorization", `Bearer ${token}`)).status }).toEqual({ route, status: 200 });
    }
    const health = await request(app).get("/__e2e/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true, apiUrl: "http://127.0.0.1:1" });
    expect(JSON.stringify(health.body)).not.toContain(token);
    const tile = await request(app).get("/tiles/12/2900/1900.png");
    expect(tile.status).toBe(200);
    expect(tile.headers["content-type"]).toBe("image/png");
    expect(tile.headers["access-control-allow-origin"]).toBe("*");
    const geocode = await request(app).get("/geocode/search?q=Thanjavur");
    expect(geocode.status).toBe(200);
    expect(geocode.body[0]).toMatchObject({ lat: "10.7870", lon: "79.1378", display_name: expect.stringContaining("Tamil Nadu") });
    expect((await request(app).get("/geocode/reverse?lat=10.79&lon=79.13")).body.address).toMatchObject({ state: "Tamil Nadu" });
    expect((await request(app).options("/tiles/1/1/1.png").set("Origin", "http://127.0.0.1:15173")).status).toBe(204);
    expect((await request(app).get("/__e2e/unknown").set("Authorization", `Bearer ${token}`)).status).toBe(404);
    expect(isPublicPath("/tiles/1/2/3.png")).toBe(true);
    expect(isPublicPath("/tiles/../__e2e/session")).toBe(false);
    expect(tokenMatches(`Bearer ${token}`, token)).toBe(true);
    expect(tokenMatches(`Bearer ${token}x`, token)).toBe(false);
    expect(tokenMatches(undefined, token)).toBe(false);

    // The product app has no control routes at all: authenticated, they are plain 404s.
    for (const route of ["/__e2e/health", "/__e2e/session", "/tiles/1/1/1.png", "/geocode/search"]) {
      expect({ route, status: (await api().get(route).set(authHeader("hx5-farmer"))).status }).toEqual({ route, status: 404 });
    }

    // Seeding helpers: UTC dates (critique E1) and the over-limit claim geometry.
    expect(utcEventDate(0, new Date("2026-10-16T20:00:00Z"))).toBe("2026-10-16T00:00:00.000Z");
    expect(utcEventDate(3, new Date("2026-10-16T01:00:00Z"))).toBe("2026-10-13T00:00:00.000Z");
    const parcel = defaultParcelGeometry(1);
    const over = overLimitGeometry(parcel);
    const side = (geometry) => geometry.coordinates[0][1][0] - geometry.coordinates[0][0][0];
    expect((side(over) / side(parcel)) ** 2).toBeGreaterThan(1.05);
    expect(defaultParcelGeometry(1).coordinates[0][0]).not.toEqual(defaultParcelGeometry(2).coordinates[0][0]);
  });
});
