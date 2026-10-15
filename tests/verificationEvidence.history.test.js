import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import LossClaim from "../models/LossClaim.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import { recordEvidenceRun, recordVerificationEvidence } from "../services/verificationEvidence.service.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// ADR-020 — evidence is append-only. A fixed idempotency key froze the first result of a component
// forever (for example a satellite row written while processing was disabled). Runs are now
// recorded per input set, and the newest row per (claim, component) is the current one.

let seq = 0;
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

const seedClaim = async (label) => {
  const user = `hist-${label}-${(++seq).toString(36)}`;
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api().post("/profile/parcels").set(authHeader(user)).send({ name: "F", crop: "Paddy", geometry: squareGeometry(0.009) });
  const created = await api().post("/claims").set(authHeader(user)).send({
    parcelId: parcel.body.data.parcel.parcelId, eventType: "flood", eventDate: daysAgo(2), geometry: squareGeometry(0.009), idempotencyKey: `idem-hist-${seq}`,
  });
  return { user, claimId: created.body.data.claim.id };
};

const satellite = (user, claimId, inputFingerprint, status, extra = {}) =>
  recordEvidenceRun({
    claimId, cognitoSub: user, component: "satellite", keyPrefix: "sat2", inputFingerprint,
    source: "SATELLITE", status, provider: "cdse", ...extra,
  });

describe("recordEvidenceRun", () => {
  let mongo;
  beforeAll(async () => { mongo = await startTestDatabase(); });
  afterAll(async () => { await stopTestDatabase(mongo); });
  beforeEach(async () => {
    await clearTestDatabase();
    await LossClaim.deleteMany({});
    await VerificationEvidence.deleteMany({});
  });

  it("EH-1: the same inputs are idempotent — the same row, no duplicate", async () => {
    const { user, claimId } = await seedClaim("same");
    const first = await satellite(user, claimId, "inputs-v1", "NOT_CHECKED");
    const second = await satellite(user, claimId, "inputs-v1", "NOT_CHECKED");
    expect(second.idempotent).toBe(true);
    expect(second.evidence.id).toBe(first.evidence.id);
    expect(await VerificationEvidence.countDocuments({ claimId })).toBe(1);
  });

  it("EH-2: different inputs append a new row that supersedes the old one, keeping the history", async () => {
    const { user, claimId } = await seedClaim("new-inputs");
    const first = await satellite(user, claimId, "window-ends-day-10", "INSUFFICIENT");
    const second = await satellite(user, claimId, "window-ends-day-20", "AVAILABLE");
    expect(second.idempotent).toBe(false);
    expect(second.superseded).toBe(true);
    expect(second.evidence.id).not.toBe(first.evidence.id);

    const rows = await VerificationEvidence.find({ claimId, component: "satellite" }).sort({ createdAt: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(String(rows[1].supersedes)).toBe(String(rows[0]._id));
    expect(rows[0].status).toBe("INSUFFICIENT"); // the old row is untouched
  });

  it("EH-3: a transient provider outage (UNAVAILABLE) is retried as a new attempt with the same inputs", async () => {
    const { user, claimId } = await seedClaim("retry");
    await satellite(user, claimId, "inputs-v1", "UNAVAILABLE");
    const retry = await satellite(user, claimId, "inputs-v1", "AVAILABLE");
    expect(retry.idempotent).toBe(false);
    const rows = await VerificationEvidence.find({ claimId, component: "satellite" }).sort({ createdAt: 1 }).lean();
    expect(rows.map((row) => row.attempt)).toEqual([1, 2]);
    // Once the retry succeeded, running again with the same inputs is idempotent.
    expect((await satellite(user, claimId, "inputs-v1", "AVAILABLE")).idempotent).toBe(true);
    expect(await VerificationEvidence.countDocuments({ claimId, component: "satellite" })).toBe(2);
  });

  it("EH-4: retrying can be disabled", async () => {
    const { user, claimId } = await seedClaim("noretry");
    await satellite(user, claimId, "inputs-v1", "UNAVAILABLE");
    const again = await satellite(user, claimId, "inputs-v1", "AVAILABLE", { retryUnavailable: false });
    expect(again.idempotent).toBe(true);
    expect(await VerificationEvidence.countDocuments({ claimId })).toBe(1);
  });

  it("EH-5: components keep separate histories", async () => {
    const { user, claimId } = await seedClaim("components");
    await satellite(user, claimId, "inputs-v1", "AVAILABLE");
    await recordEvidenceRun({ claimId, cognitoSub: user, component: "weather", keyPrefix: "wx", inputFingerprint: "inputs-v1", source: "WEATHER", status: "AVAILABLE" });
    expect(await VerificationEvidence.countDocuments({ claimId, component: "satellite" })).toBe(1);
    expect(await VerificationEvidence.countDocuments({ claimId, component: "weather" })).toBe(1);
  });

  it("EH-6: generated keys fit the 64-character limit and cannot collide with the legacy fixed keys", async () => {
    const { user, claimId } = await seedClaim("keys");
    await recordVerificationEvidence({ claimId, cognitoSub: user, source: "SATELLITE", status: "NOT_CHECKED", idempotencyKey: `satellite_${claimId}` });
    const run = await satellite(user, claimId, "inputs-v1", "AVAILABLE");
    const row = await VerificationEvidence.findById(run.evidence.id);
    expect(row.idempotencyKey.length).toBeLessThanOrEqual(64);
    expect(row.idempotencyKey.startsWith("sat2_")).toBe(true);
    expect(await VerificationEvidence.countDocuments({ claimId, source: "SATELLITE" })).toBe(2);
  });

  it("EH-7: concurrent identical runs produce exactly one row", async () => {
    const { user, claimId } = await seedClaim("race");
    const results = await Promise.all([1, 2, 3].map(() => satellite(user, claimId, "inputs-v1", "AVAILABLE")));
    expect(new Set(results.map((result) => result.evidence.id)).size).toBe(1);
    expect(await VerificationEvidence.countDocuments({ claimId, component: "satellite" })).toBe(1);
  });

  it("EH-8: another farmer cannot record evidence for this claim (404)", async () => {
    const { claimId } = await seedClaim("owner");
    await expect(satellite("intruder-sub", claimId, "x", "AVAILABLE")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("EH-9: input validation", async () => {
    const { user, claimId } = await seedClaim("validation");
    await expect(recordEvidenceRun({ claimId, cognitoSub: user, component: "satellite", keyPrefix: "sat2", source: "SATELLITE" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(recordEvidenceRun({ claimId, cognitoSub: user, component: "satellite", keyPrefix: "bad prefix!", inputFingerprint: "x", source: "SATELLITE" })).rejects.toMatchObject({ statusCode: 400 });
  });
});
