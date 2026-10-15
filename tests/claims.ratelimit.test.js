import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Limits are read once at import time; set small values before anything is imported.
vi.hoisted(() => {
  process.env.CLAIM_RATE_LIMIT_MAX = "2"; // writes
  process.env.CLAIM_READ_RATE_LIMIT_MAX = "4"; // reads
});

import LossClaim from "../models/LossClaim.js";
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
});
