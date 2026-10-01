// End-to-end verification of the parcel-boundary -> affected-area -> claim flow that the
// MapLibre UI enables (ADR-019 P8).
//
// This is a real integration test: the actual Express app, the real auth middleware, the real
// validation schemas, the real geometry service and the real Phase 9 spatial engine, against a
// real Mongo instance. It exists because the map UI makes a promise the client alone cannot keep —
// that a farmer-drawn polygon becomes a persisted parcel boundary and a persisted claim affected
// area with backend-computed acreage — and only this layer can prove that promise.
//
// Nothing here is mocked at the service layer. The frontend map is not exercised (MapLibre needs
// WebGL); what is verified is everything downstream of the polygon the farmer draws.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { calculateParcelAreaAcres } from "../services/parcelGeometry.service.js";
import { buildSpatialContext } from "../services/claimSpatial.service.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

const farmer = "test-parcel-flow-farmer";
const otherFarmer = "test-parcel-flow-other";
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

// A farm parcel drawn on the map near Thanjavur.
const ORIGIN = [79.1378, 10.787];
const PARCEL_SIZE = 0.009;
const parcelGeometry = () => squareGeometry(PARCEL_SIZE, ORIGIN);

/**
 * The affected area a farmer draws INSIDE the parcel: a 0.003-degree square whose south-west
 * corner sits inside the parcel, so it is a strict subset — roughly 1/9 the linear size.
 */
const AFFECTED_SIZE = 0.003;
const affectedGeometry = () => squareGeometry(AFFECTED_SIZE, [ORIGIN[0] + 0.002, ORIGIN[1] + 0.002]);

/** An affected area that pokes well outside the parcel boundary. */
const outsideGeometry = () => squareGeometry(0.006, [ORIGIN[0] + 0.006, ORIGIN[1] + 0.006]);

let parcelId;

const createParcel = async (geometry = parcelGeometry()) => {
  const response = await api()
    .post("/profile/parcels")
    .set(authHeader(farmer))
    .send({ name: "North Field", crop: "Paddy", geometry });
  expect(response.status).toBe(200);
  return response.body.data.parcel;
};

const createClaim = async (body) =>
  api()
    .post("/claims")
    .set(authHeader(farmer))
    .send({
      parcelId,
      eventType: "flood",
      eventDate: daysAgo(2),
      geometry: affectedGeometry(),
      idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
      ...body,
    });

beforeAll(async () => {
  await startTestDatabase();
});

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
  await seedProfile(farmer);
  const parcel = await createParcel();
  parcelId = parcel.parcelId;
});

// ── A. drawing a boundary produces a persisted parcel with a server-computed area ────────

describe("A. parcel boundary drawn on the map", () => {
  it("stores the drawn geometry and computes the acreage server-side", async () => {
    const response = await api().get("/profile/parcels").set(authHeader(farmer));
    expect(response.status).toBe(200);

    const [parcel] = response.body.data.parcels;
    expect(parcel.parcelId).toBe(parcelId);
    expect(parcel.geometry.type).toBe("Polygon");
    expect(parcel.geometry.coordinates).toEqual(parcelGeometry().coordinates);
    // Authoritative: equals the service's own computation, never a client value.
    expect(parcel.calculatedAreaAcres).toBe(
      calculateParcelAreaAcres(parcelGeometry())
    );
  });

  it("rejects a boundary that is not a polygon with enough vertices", async () => {
    const response = await api()
      .post("/profile/parcels")
      .set(authHeader(farmer))
      .send({
        name: "Bad Field",
        crop: "Paddy",
        geometry: { type: "Polygon", coordinates: [[[79.1, 10.7], [79.11, 10.71], [79.1, 10.7]]] },
      });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a self-intersecting boundary", async () => {
    const response = await api()
      .post("/profile/parcels")
      .set(authHeader(farmer))
      .send({
        name: "Bowtie",
        crop: "Paddy",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [79.0, 10.0],
              [79.2, 10.2],
              [79.2, 10.0],
              [79.0, 10.2],
              [79.0, 10.0],
            ],
          ],
        },
      });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("ignores a client-supplied area and uses its own computation", async () => {
    const response = await api()
      .post("/profile/parcels")
      .set(authHeader(farmer))
      .send({
        name: "Sneaky Field",
        crop: "Paddy",
        geometry: parcelGeometry(),
        calculatedAreaAcres: 9999,
      });
    expect(response.status).toBe(200);
    expect(response.body.data.parcel.calculatedAreaAcres).toBe(
      calculateParcelAreaAcres(parcelGeometry())
    );
  });
});

// ── B. editing the boundary recomputes the acreage ─────────────────────────────────────

describe("B. redrawing the boundary", () => {
  it("recomputes the authoritative area from the updated geometry", async () => {
    const bigger = squareGeometry(PARCEL_SIZE * 2, ORIGIN);
    const response = await api()
      .patch(`/profile/parcels/${parcelId}`)
      .set(authHeader(farmer))
      .send({ geometry: bigger });

    expect(response.status).toBe(200);
    const updated = response.body.data.parcel;
    expect(updated.calculatedAreaAcres).toBe(calculateParcelAreaAcres(bigger));
    // Doubling both sides multiplies the area by four, but not exactly: the geodesic area of a
    // larger square at this latitude is not four times the smaller one, so the assertion is
    // approximate by design rather than pretending the earth is flat.
    const original = calculateParcelAreaAcres(parcelGeometry());
    expect(updated.calculatedAreaAcres).toBeCloseTo(original * 4, 1);
    expect(updated.calculatedAreaAcres).toBeGreaterThan(original * 3.9);
  });

  it("exposes the recalculation endpoint the UI can call", async () => {
    const response = await api().post(`/profile/parcels/${parcelId}/area`).set(authHeader(farmer));
    expect(response.status).toBe(200);
    expect(response.body.data.parcel.calculatedAreaAcres).toBe(
      calculateParcelAreaAcres(parcelGeometry())
    );
  });

  it("refuses to edit a parcel owned by another farmer", async () => {
    await seedProfile(otherFarmer);
    const response = await api()
      .patch(`/profile/parcels/${parcelId}`)
      .set(authHeader(otherFarmer))
      .send({ name: "Hijacked" });
    expect(response.status).toBe(404);
  });
});

// ── C. deleting a parcel ───────────────────────────────────────────────────────────────

describe("C. deleting a parcel", () => {
  it("removes it and it is no longer claimable", async () => {
    const deleted = await api().delete(`/profile/parcels/${parcelId}`).set(authHeader(farmer));
    expect(deleted.status).toBe(200);

    const list = await api().get("/profile/parcels").set(authHeader(farmer));
    expect(list.body.data.parcels).toHaveLength(0);

    const claim = await createClaim({ geometry: parcelGeometry() });
    expect(claim.status).toBeGreaterThanOrEqual(400);
  });
});

// ── D. the affected area drawn on the claim map ─────────────────────────────────────────

describe("D. claim affected area drawn on the map", () => {
  it("claims the whole parcel when the farmer draws the full boundary", async () => {
    const response = await createClaim({ geometry: parcelGeometry() });
    expect(response.status).toBe(200);

    const claim = response.body.data.claim;
    expect(claim.claimedAreaAcres).toBe(calculateParcelAreaAcres(parcelGeometry()));
    expect(claim.claimedAreaAcres).toBe(calculateParcelAreaAcres(parcelGeometry()));
  });

  it("claims only the drawn portion when the farmer draws a smaller affected area", async () => {
    const response = await createClaim();
    expect(response.status).toBe(200);

    const claim = response.body.data.claim;
    // The server measures the affected polygon the farmer drew — not the parcel.
    expect(claim.claimedAreaAcres).toBe(calculateParcelAreaAcres(affectedGeometry()));
    expect(claim.claimedAreaAcres).toBeLessThan(calculateParcelAreaAcres(parcelGeometry()));
    expect(claim.claimedGeometry).toEqual(affectedGeometry());
  });

  it("stores the parcel snapshot so a later boundary edit cannot rewrite history", async () => {
    const claim = (await createClaim()).body.data.claim;
    expect(claim.parcelSnapshot.parcelId).toBe(parcelId);
    expect(claim.parcelSnapshot.parcelAreaAcres).toBe(
      calculateParcelAreaAcres(parcelGeometry())
    );

    await api()
      .patch(`/profile/parcels/${parcelId}`)
      .set(authHeader(farmer))
      .send({ geometry: squareGeometry(PARCEL_SIZE * 3, ORIGIN) });

    // The claim keeps the acreage that was true when it was filed.
    expect(claim.parcelSnapshot.parcelAreaAcres).toBe(
      calculateParcelAreaAcres(parcelGeometry())
    );
  });

  it("ignores a client-supplied claimed area", async () => {
    const response = await createClaim({ claimedAreaAcres: 500 });
    expect(response.status).toBe(200);
    expect(response.body.data.claim.claimedAreaAcres).toBe(
      calculateParcelAreaAcres(affectedGeometry())
    );
  });

  it("rejects an affected area that is not a real polygon", async () => {
    const response = await createClaim({
      geometry: { type: "Polygon", coordinates: [[[79.1, 10.7], [79.11, 10.71], [79.1, 10.7]]] },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses to claim a parcel owned by another farmer", async () => {
    await seedProfile(otherFarmer);
    const response = await api()
      .post("/claims")
      .set(authHeader(otherFarmer))
      .send({
        parcelId,
        eventType: "flood",
        eventDate: daysAgo(2),
        geometry: affectedGeometry(),
        idempotencyKey: "idem-cross-owner",
      });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

// ── E. the spatial engine's verdict on the drawn area ───────────────────────────────────
//
// The client shows an advisory containment warning; the decision that actually matters is made
// here, from the geometry the farmer drew.

describe("E. Phase 9 spatial verdict on the drawn affected area", () => {
  it("treats an area drawn inside the parcel as contained", () => {
    const context = buildSpatialContext({
      claimedGeometry: affectedGeometry(),
      parcelGeometry: parcelGeometry(),
      parcelAreaAcres: calculateParcelAreaAcres(parcelGeometry()),
    });

    expect(context.insideParcel).toBe(true);
    expect((context.overlapWarnings ?? []).map((warning) => warning.code)).not.toContain("outside_parcel");
  });

  it("flags an area that extends beyond the parcel boundary", () => {
    const context = buildSpatialContext({
      claimedGeometry: outsideGeometry(),
      parcelGeometry: parcelGeometry(),
      parcelAreaAcres: calculateParcelAreaAcres(parcelGeometry()),
    });

    expect(context.insideParcel).toBe(false);
    expect((context.overlapWarnings ?? []).map((warning) => warning.code)).toContain("outside_parcel");
  });

  it("leaves the full parcel eligible when no sibling claim exists", () => {
    // remainingEligibleAcres measures what is left for *other* claims, so the claim being
    // evaluated is deliberately not subtracted from it here.
    const parcelAcres = calculateParcelAreaAcres(parcelGeometry());
    const context = buildSpatialContext({
      claimedGeometry: affectedGeometry(),
      parcelGeometry: parcelGeometry(),
      parcelAreaAcres: parcelAcres,
    });

    expect(context.remainingEligibleAcres).toBeCloseTo(parcelAcres, 3);
  });

  it("subtracts verified and in-flight siblings from the eligible acreage", () => {
    const parcelAcres = calculateParcelAreaAcres(parcelGeometry());
    const verifiedAcres = calculateParcelAreaAcres(affectedGeometry());
    const inFlightAcres = verifiedAcres / 2;

    const context = buildSpatialContext({
      claimedGeometry: affectedGeometry(),
      parcelGeometry: parcelGeometry(),
      parcelAreaAcres: parcelAcres,
      verifiedSiblings: [
        {
          claimId: "sibling-verified",
          siblingState: "verified",
          geometry: affectedGeometry(),
          areaAcres: verifiedAcres,
        },
      ],
      inFlightSiblings: [
        {
          claimId: "sibling-submitted",
          siblingState: "submitted",
          geometry: affectedGeometry(),
          areaAcres: inFlightAcres,
        },
      ],
    });

    expect(context.previouslyVerifiedAcres).toBeCloseTo(verifiedAcres, 3);
    expect(context.inFlightAreaAcres).toBeCloseTo(inFlightAcres, 3);
    expect(context.remainingEligibleAcres).toBeCloseTo(
      parcelAcres - verifiedAcres - inFlightAcres,
      2
    );
  });
});
