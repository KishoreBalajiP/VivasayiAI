import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import LossClaim from "../models/LossClaim.js";
import { api, authHeader, clearTestDatabase, seedProfile, squareGeometry, startTestDatabase, stopTestDatabase } from "./helpers.js";

let seq = 0;
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

describe("claimant relationship on claim creation", () => {
  let mongo;
  beforeAll(async () => { mongo = await startTestDatabase(); });
  afterAll(async () => { await stopTestDatabase(mongo); });
  beforeEach(async () => { await clearTestDatabase(); await LossClaim.deleteMany({}); });

  const setup = async () => {
    const user = `rel-${(++seq).toString(36)}`;
    await seedProfile(user);
    const parcel = await api().post("/profile/parcels").set(authHeader(user)).send({ name: "F", crop: "Paddy", geometry: squareGeometry(0.009) });
    return { user, parcelId: parcel.body.data.parcel.parcelId };
  };
  const create = ({ user, parcelId }, extra = {}) =>
    api().post("/claims").set(authHeader(user)).send({
      parcelId, eventType: "flood", eventDate: daysAgo(2), geometry: squareGeometry(0.009), idempotencyKey: `idem-rel-${++seq}`, ...extra,
    });

  it("CRL-1: every supported relationship is stored and returned", async () => {
    for (const claimantRelationship of ["owner", "joint_owner", "tenant", "authorised_cultivator", "heir"]) {
      const response = await create(await setup(), { claimantRelationship });
      expect(response.status).toBe(200);
      expect(response.body.data.claim.claimantRelationship).toBe(claimantRelationship);
    }
  });

  it("CRL-2: omitting it is allowed and reads back as null (existing clients keep working)", async () => {
    const response = await create(await setup());
    expect(response.status).toBe(200);
    expect(response.body.data.claim.claimantRelationship).toBeNull();
  });

  it("CRL-3: an unknown relationship is rejected before anything is stored", async () => {
    const ctx = await setup();
    const response = await create(ctx, { claimantRelationship: "landlord_friend" });
    expect(response.status).toBe(400);
    expect(await LossClaim.countDocuments({ cognitoSub: ctx.user })).toBe(0);
  });
});
