import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import LossClaim from "../models/LossClaim.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// Official land-record verification (Phase 15). Regression coverage for two confirmed defects:
//   1. The service destructured a named export from a default-export model, so every call threw a
//      TypeError (HTTP 500) after the provider query and no evidence row was ever persisted.
//   2. The endpoint forwarded a client-supplied `extracted` body to the provider, so a claimant
//      could choose the values the "official" check was run against.
// Deterministic: LAND_RECORD_MODE=mock, mongodb-memory-server, no network.

const sub = (name) => `test-landrecord-${name}`;
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const seedClaim = async (user, key) => {
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api()
    .post("/profile/parcels")
    .set(authHeader(user))
    .send({ name: "Record field", crop: "Paddy", geometry: squareGeometry(0.009) });
  expect(parcel.status).toBe(200);
  const claim = await api()
    .post("/claims")
    .set(authHeader(user))
    .send({
      parcelId: parcel.body.data.parcel.parcelId,
      eventType: "flood",
      eventDate: daysAgo(2),
      geometry: squareGeometry(0.009),
      idempotencyKey: key,
    });
  expect(claim.status).toBe(200);
  return claim.body.data.claim;
};

// An ownership row that already carries a stored AI extraction (what the examination step writes).
const seedExaminedOwnershipRow = (claimId, extracted) =>
  VerificationEvidence.create({
    claimId,
    source: "OWNERSHIP",
    status: "PENDING",
    reference: "upl_test_document_01",
    idempotencyKey: `own_${String(claimId)}_01`,
    result: { aiLandDocumentExamination: { extracted, reviewRequired: false } },
  });

const verifyRecord = (user, claimId, body) =>
  api()
    .post(`/claims/${claimId}/verification/official-land-record`)
    .set(authHeader(user))
    .send(body ?? {});

describe("official land-record verification — regressions", () => {
  let mongo;
  const previous = {};

  beforeAll(async () => {
    mongo = await startTestDatabase();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await clearTestDatabase();
    await LossClaim.deleteMany({});
    await VerificationEvidence.deleteMany({});
    for (const key of ["LAND_RECORD_MODE", "LAND_RECORD_MOCK_OUTCOME"]) previous[key] = process.env[key];
    process.env.LAND_RECORD_MODE = "mock";
    process.env.LAND_RECORD_MOCK_OUTCOME = "match";
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("LR-1: persists an OWNERSHIP verification row instead of throwing a TypeError", async () => {
    const user = sub("persist");
    const claim = await seedClaim(user, "idem-lr-persist");
    await seedExaminedOwnershipRow(claim.id ?? claim._id, {
      surveyNumber: "123/4A",
      district: "Thanjavur",
      holderNames: ["Test Farmer"],
    });

    const response = await verifyRecord(user, claim.id ?? claim._id);
    expect(response.status).toBe(200);
    expect(response.body.data.result.status).toBe("matched");
    expect(response.body.data.result.liveValidated).toBe(false);

    const rows = await VerificationEvidence.find({
      claimId: claim.id ?? claim._id,
      idempotencyKey: /^officialland_/,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("OWNERSHIP");
    expect(rows[0].status).toBe("AVAILABLE");
  });

  it("LR-2: ignores a client-supplied `extracted` body and uses the stored extraction", async () => {
    const user = sub("ignore-client");
    const claim = await seedClaim(user, "idem-lr-ignore");
    await seedExaminedOwnershipRow(claim.id ?? claim._id, {
      surveyNumber: "STORED-777",
      district: "Thanjavur",
      holderNames: ["Stored Holder"],
    });

    const response = await verifyRecord(user, claim.id ?? claim._id, {
      extracted: { surveyNumber: "CLIENT-FORGED-999", holderNames: ["Forger"] },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.result.record.surveyNumber).toBe("STORED-777");
    expect(JSON.stringify(response.body)).not.toContain("CLIENT-FORGED-999");
  });

  it("LR-3: without an examined ownership document it returns 409 and queries nothing", async () => {
    const user = sub("no-extraction");
    const claim = await seedClaim(user, "idem-lr-none");

    const response = await verifyRecord(user, claim.id ?? claim._id, {
      extracted: { surveyNumber: "CLIENT-ONLY-1" },
    });
    expect(response.status).toBe(409);
    const rows = await VerificationEvidence.countDocuments({ claimId: claim.id ?? claim._id });
    expect(rows).toBe(0);
  });

  it("LR-4: a different user cannot run the check on someone else's claim (404)", async () => {
    const owner = sub("owner");
    const claim = await seedClaim(owner, "idem-lr-owner");
    await seedExaminedOwnershipRow(claim.id ?? claim._id, { surveyNumber: "1/1" });

    const response = await verifyRecord(sub("intruder"), claim.id ?? claim._id);
    expect(response.status).toBe(404);
  });

  it("LR-5: a second run updates the same row in place (idempotent), never duplicates", async () => {
    const user = sub("rerun");
    const claim = await seedClaim(user, "idem-lr-rerun");
    await seedExaminedOwnershipRow(claim.id ?? claim._id, { surveyNumber: "9/9" });

    expect((await verifyRecord(user, claim.id ?? claim._id)).status).toBe(200);
    process.env.LAND_RECORD_MOCK_OUTCOME = "mismatch";
    expect((await verifyRecord(user, claim.id ?? claim._id)).status).toBe(200);

    const rows = await VerificationEvidence.find({
      claimId: claim.id ?? claim._id,
      idempotencyKey: /^officialland_/,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("INCONSISTENT");
  });
});
