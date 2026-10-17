import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Limits are read once at import time; set small values before anything is imported.
vi.hoisted(() => {
  process.env.CLAIM_RATE_LIMIT_MAX = "2"; // writes
  process.env.CLAIM_READ_RATE_LIMIT_MAX = "4"; // reads
});

import express from "express";
import request from "supertest";
import LossClaim from "../models/LossClaim.js";
import { RATE_LIMIT_DEFAULTS } from "../config/env.js";
import { EXPOSED_HEADERS } from "../middlewares/cors.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// The claim limiter (5 requests per hour per user by default) was applied to READ endpoints as
// well, so a client that merely polled GET /claims/:id and GET /claims/:id/verification locked the
// farmer out of creating or submitting claims. Reads now have their own, larger bucket.

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
let counter = 0;
const newUser = (label) => `test-ratelimit-${label}-${++counter}`;

const seedParcel = async (user) => {
  expect((await seedProfile(user)).status).toBe(200);
  const response = await api()
    .post("/profile/parcels")
    .set(authHeader(user))
    .send({ name: "Limit field", crop: "Paddy", geometry: squareGeometry(0.009) });
  expect(response.status).toBe(200);
  return response.body.data.parcel.parcelId;
};

const createClaim = (user, parcelId, key) =>
  api()
    .post("/claims")
    .set(authHeader(user))
    .send({ parcelId, eventType: "flood", eventDate: daysAgo(2), geometry: squareGeometry(0.009), idempotencyKey: key });

describe("claim rate limits — reads and writes are separate buckets", () => {
  let mongo;
  beforeAll(async () => {
    mongo = await startTestDatabase();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await clearTestDatabase();
    await LossClaim.deleteMany({});
  });

  it("RL-1: exhausting the read budget does not block creating a claim", async () => {
    const user = newUser("read-then-write");
    const parcelId = await seedParcel(user);
    for (let i = 0; i < 4; i += 1) {
      expect((await api().get("/claims").set(authHeader(user))).status).toBe(200);
    }
    expect((await api().get("/claims").set(authHeader(user))).status).toBe(429);
    // Regression: this write used to share the exhausted bucket and return 429.
    expect((await createClaim(user, parcelId, "idem-rl-1-aaaa")).status).toBe(200);
  });

  it("RL-2: writing is still strictly limited", async () => {
    const user = newUser("writes");
    const parcelId = await seedParcel(user);
    expect((await createClaim(user, parcelId, "idem-rl-2-aaaa")).status).toBe(200);
    expect((await createClaim(user, parcelId, "idem-rl-2-bbbb")).status).toBe(200);
    expect((await createClaim(user, parcelId, "idem-rl-2-cccc")).status).toBe(429);
  });

  it("RL-3: reading does not consume the write budget", async () => {
    const user = newUser("write-budget");
    const parcelId = await seedParcel(user);
    for (let i = 0; i < 3; i += 1) await api().get("/claims").set(authHeader(user));
    expect((await createClaim(user, parcelId, "idem-rl-3-aaaa")).status).toBe(200);
    expect((await createClaim(user, parcelId, "idem-rl-3-bbbb")).status).toBe(200);
  });

  it("RL-4: limits are per user", async () => {
    const heavy = newUser("heavy");
    const light = newUser("light");
    for (let i = 0; i < 5; i += 1) await api().get("/claims").set(authHeader(heavy));
    expect((await api().get("/claims").set(authHeader(heavy))).status).toBe(429);
    expect((await api().get("/claims").set(authHeader(light))).status).toBe(200);
  });

  it("RL-5: the read routes report their own rate-limit headers", async () => {
    const user = newUser("headers");
    const response = await api().get("/claims").set(authHeader(user));
    expect(response.headers["ratelimit-limit"] ?? response.headers["ratelimit"]).toBeTruthy();
    expect(String(response.headers["ratelimit-limit"] ?? response.headers["ratelimit"])).toContain("4");
  });

  it("RL-6: evidence and ownership signed-URL reads use the read bucket, not the upload budget", async () => {
    const user = newUser("evidence-url");
    const parcelId = await seedParcel(user);
    const created = await createClaim(user, parcelId, "idem-rl-6-aaaa");
    const claimId = created.body.data.claim.id;
    const paths = [
      `/claims/${claimId}/evidence/img_00000000-0000-4000-8000-000000000000/url`,
      `/claims/${claimId}/ownership`,
      `/claims/${claimId}/ownership/0123456789abcdef01234567/url`,
    ];
    for (const path of paths) {
      const response = await api().get(path).set(authHeader(user));
      const header = String(response.headers["ratelimit-limit"] ?? response.headers["ratelimit"] ?? "");
      expect(header).toContain("4"); // the read limit configured for this file
    }
  });

  // ADR-022 / owner decision D5: 15 claim writes and 60 evidence calls per hour by default; reads
  // unchanged. The browser can read the headers it needs to back off and to quote a request.
  it("RL-7: the defaults are 15 claim writes, 60 evidence calls and 600 reads per hour, and the rate-limit headers are exposed to the browser", async () => {
    expect(RATE_LIMIT_DEFAULTS).toEqual({ claimWrites: 15, evidence: 60, reads: 600 });
    expect(Object.isFrozen(RATE_LIMIT_DEFAULTS)).toBe(true);
    expect(EXPOSED_HEADERS).toEqual(["Retry-After", "x-request-id", "RateLimit-Reset"]);

    const user = newUser("cors");
    const origin = "http://localhost:5173"; // the default CORS allow-list
    const read = await api().get("/claims").set(authHeader(user)).set("Origin", origin);
    expect(read.status).toBe(200);
    const exposed = String(read.headers["access-control-expose-headers"] || "").toLowerCase().split(",").map((value) => value.trim());
    expect(exposed).toEqual(expect.arrayContaining(["retry-after", "x-request-id", "ratelimit-reset"]));
    expect(read.headers["x-request-id"]).toBeTruthy();
    expect(read.headers["ratelimit-reset"]).toBeTruthy();
    // A refused request carries Retry-After, which the browser may now read.
    for (let i = 0; i < 4; i += 1) await api().get("/claims").set(authHeader(user)).set("Origin", origin);
    const refused = await api().get("/claims").set(authHeader(user)).set("Origin", origin);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(String(refused.headers["access-control-expose-headers"] || "").toLowerCase()).toContain("retry-after");
  });

  it("RL-8: with the default limits a full claim fits (create, submit, 2 resubmits; 10 photos and 2 documents, with retries) and the limits still hold", async () => {
    const overridden = ["CLAIM_RATE_LIMIT_MAX", "EVIDENCE_RATE_LIMIT_MAX", "CLAIM_READ_RATE_LIMIT_MAX"];
    const saved = Object.fromEntries(overridden.map((key) => [key, process.env[key]]));
    try {
      for (const key of overridden) delete process.env[key];
      // The limiters read the configuration once, at import: load fresh copies with no overrides.
      vi.resetModules();
      const { env } = await import("../config/env.js");
      expect([env.claimRateLimitMax, env.evidenceRateLimitMax, env.claimReadRateLimitMax]).toEqual([15, 60, 600]);
      const { claimLimiter, evidenceLimiter } = await import("../middlewares/rateLimit.js");
      const app = express();
      app.use((req, _res, next) => {
        req.user = { id: "rl8-farmer" };
        next();
      });
      const ok = (_req, res) => res.status(200).json({ ok: true });
      app.post("/claim-write", claimLimiter, ok);
      app.post("/evidence", evidenceLimiter, ok);
      const agent = request(app);
      const statuses = async (path, count) => {
        const out = [];
        for (let i = 0; i < count; i += 1) out.push((await agent.post(path)).status);
        return out;
      };

      // The wizard: create + submit, and up to two resubmissions.
      expect(await statuses("/claim-write", 4)).toEqual(Array(4).fill(200));
      // 10 photos (presign + complete each) and 2 land documents attached = 22 evidence calls, plus a
      // retried photo and a retried attach after a dropped connection = 24.
      expect(await statuses("/evidence", 24)).toEqual(Array(24).fill(200));

      // The limits are still limits: write 15 and evidence 60 per hour, then 429.
      expect(await statuses("/claim-write", 11)).toEqual(Array(11).fill(200));
      expect((await agent.post("/claim-write")).status).toBe(429);
      expect(await statuses("/evidence", 36)).toEqual(Array(36).fill(200));
      expect((await agent.post("/evidence")).status).toBe(429);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.resetModules();
    }
  });
});
