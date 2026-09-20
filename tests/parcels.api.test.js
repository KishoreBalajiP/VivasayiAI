import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import FarmProfile from "../models/FarmProfile.js";
import { calculateParcelAreaAcres } from "../services/parcelGeometry.service.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
  triangleGeometry,
} from "./helpers.js";

const sub = (name) => `test-user-${name}`;
const PARCEL_ID_PATTERN = /^par_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bowtieGeometry = () => ({
  type: "Polygon",
  coordinates: [[[0, 0], [0.01, 0.01], [0, 0.01], [0.01, 0], [0, 0]]],
});
const collinearGeometry = () => ({
  type: "Polygon",
  coordinates: [[[0, 0], [0.01, 0.01], [0.02, 0.02], [0.03, 0.03], [0, 0]]],
});

const createParcel = async (user, body) =>
  api().post("/profile/parcels").set(authHeader(user)).send(body);

describe("parcel CRUD API foundation", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase(mongo);
  });

  beforeEach(async () => {
    await clearTestDatabase();
  });

  it("1: creates a parcel with a server-generated id, geometry, authoritative area, and timestamps", async () => {
    const user = sub("create-valid");
    expect((await seedProfile(user)).status).toBe(200);
    const geometry = squareGeometry(0.009);
    const response = await createParcel(user, { name: "North field", crop: "Paddy", geometry });

    expect(response.status).toBe(200);
    expect(response.body.data.parcel.parcelId).toMatch(PARCEL_ID_PATTERN);
    expect(response.body.data.parcel.name).toBe("North field");
    expect(response.body.data.parcel.crop).toBe("Paddy");
    expect(response.body.data.parcel.geometry).toEqual(geometry);
    expect(response.body.data.parcel.calculatedAreaAcres).toBe(calculateParcelAreaAcres(geometry));
    expect(response.body.data.parcel.createdAt).toBeTruthy();
    expect(response.body.data.parcel.updatedAt).toBeTruthy();
    expect(response.body.data.parcel).not.toHaveProperty("_id");
  });

  it("2: ignores a client-supplied parcelId and always generates par_<uuid>", async () => {
    const user = sub("create-id");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await createParcel(user, {
      name: "Owned field",
      crop: "Paddy",
      parcelId: "par_12345678-1234-1234-1234-123456789012",
      geometry: squareGeometry(0.009),
    });

    expect(response.status).toBe(200);
    expect(response.body.data.parcel.parcelId).toMatch(PARCEL_ID_PATTERN);
    expect(response.body.data.parcel.parcelId).not.toBe("par_12345678-1234-1234-1234-123456789012");
  });

  it("3: ignores client-supplied area and stores only the server-computed acres", async () => {
    const user = sub("create-area");
    expect((await seedProfile(user)).status).toBe(200);
    const geometry = squareGeometry(0.009);
    const response = await createParcel(user, {
      name: "Area field",
      crop: "Paddy",
      geometry,
      calculatedAreaAcres: 9999,
      area: 555,
      acres: 1,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.parcel.calculatedAreaAcres).toBe(calculateParcelAreaAcres(geometry));
    expect(response.body.data.parcel.calculatedAreaAcres).not.toBe(9999);
  });

  it("4: requires an existing farm profile before a parcel can be created", async () => {
    const response = await createParcel(sub("no-profile"), {
      name: "Orphan field",
      crop: "Paddy",
      geometry: squareGeometry(0.009),
    });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("Farm profile not found");
  });

  it("5: rejects parcel creation when required fields are missing", async () => {
    const user = sub("create-missing");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await createParcel(user, { crop: "Paddy" });

    expect(response.status).toBe(400);
    expect(response.body.data).toEqual({});
  });

  it("6: rejects non-Polygon geometry", async () => {
    const user = sub("geometry-type");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await createParcel(user, {
      name: "Point field",
      crop: "Paddy",
      geometry: { type: "Point", coordinates: [80, 10] },
    });

    expect(response.status).toBe(400);
  });

  it("7: rejects malformed coordinates", async () => {
    const user = sub("geometry-malformed");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await createParcel(user, {
      name: "Malformed field",
      crop: "Paddy",
      geometry: { type: "Polygon", coordinates: "not-an-array" },
    });

    expect(response.status).toBe(400);
  });

  it("8: rejects an open linear ring", async () => {
    const user = sub("geometry-open");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await createParcel(user, {
      name: "Open field",
      crop: "Paddy",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0.004, 0], [0, 0.004], [0.001, 0.001]]] },
    });

    expect(response.status).toBe(400);
  });

  it("9: rejects a ring with fewer than four positions", async () => {
    const user = sub("geometry-short");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await createParcel(user, {
      name: "Short field",
      crop: "Paddy",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0.004, 0], [0, 0]]] },
    });

    expect(response.status).toBe(400);
  });

  it("10: rejects out-of-range and non-numeric coordinates", async () => {
    const user = sub("geometry-range");
    expect((await seedProfile(user)).status).toBe(200);
    const outOfRange = await createParcel(user, {
      name: "Far field",
      crop: "Paddy",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [999, 0], [0, 0.004], [0, 0]]] },
    });
    const nonNumeric = await createParcel(user, {
      name: "String field",
      crop: "Paddy",
      geometry: { type: "Polygon", coordinates: [[[0, 0], ["east", 0], [0, 0.004], [0, 0]]] },
    });

    expect(outOfRange.status).toBe(400);
    expect(nonNumeric.status).toBe(400);
  });

  it("11: rejects a self-intersecting polygon", async () => {
    const user = sub("geometry-self");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await createParcel(user, {
      name: "Bowtie field",
      crop: "Paddy",
      geometry: bowtieGeometry(),
    });

    expect(response.status).toBe(400);
  });

  it("12: rejects a degenerate zero-area polygon", async () => {
    const user = sub("geometry-degenerate");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await createParcel(user, {
      name: "Line field",
      crop: "Paddy",
      geometry: collinearGeometry(),
    });

    expect(response.status).toBe(400);
  });

  it("13: rejects polygon holes in this phase", async () => {
    const user = sub("geometry-holes");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await createParcel(user, {
      name: "Hole field",
      crop: "Paddy",
      geometry: {
        type: "Polygon",
        coordinates: [
          squareGeometry(0.004).coordinates[0],
          squareGeometry(0.001).coordinates[0],
        ],
      },
    });

    expect(response.status).toBe(400);
  });

  it("14: requires authentication for parcel reads", async () => {
    const response = await api().get("/profile/parcels");
    expect(response.status).toBe(401);
    expect(response.body.message).toBe("Authentication required");
  });

  it("15: isolates parcels by owner across read, update, and delete", async () => {
    const owner = sub("owner");
    const stranger = sub("stranger");
    expect((await seedProfile(owner)).status).toBe(200);
    expect((await seedProfile(stranger)).status).toBe(200);
    const created = await createParcel(owner, {
      name: "Owner field",
      crop: "Paddy",
      geometry: squareGeometry(0.009),
    });
    const parcelId = created.body.data.parcel.parcelId;
    const strangerApi = () => api();

    const read = await strangerApi().get(`/profile/parcels/${parcelId}`).set(authHeader(stranger));
    const patch = await strangerApi()
      .patch(`/profile/parcels/${parcelId}`)
      .set(authHeader(stranger))
      .send({ name: "Hijacked" });
    const remove = await strangerApi()
      .delete(`/profile/parcels/${parcelId}`)
      .set(authHeader(stranger));

    expect(read.status).toBe(404);
    expect(patch.status).toBe(404);
    expect(remove.status).toBe(404);

    const ownerRead = await api().get(`/profile/parcels/${parcelId}`).set(authHeader(owner));
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.body.data.parcel.name).toBe("Owner field");
  });

  it("16: never takes parcel ownership from the request body", async () => {
    const owner = sub("body-owner");
    const attacker = sub("body-attacker");
    expect((await seedProfile(owner)).status).toBe(200);
    const response = await createParcel(owner, {
      name: "Body field",
      crop: "Paddy",
      geometry: squareGeometry(0.009),
      cognitoSub: attacker,
      userEmail: "attacker@example.com",
    });

    expect(response.status).toBe(200);
    const attackerList = await api().get("/profile/parcels").set(authHeader(attacker));
    const ownerList = await api().get("/profile/parcels").set(authHeader(owner));
    expect(attackerList.status).toBe(200);
    expect(attackerList.body.data.parcels).toEqual([]);
    expect(ownerList.body.data.parcels).toHaveLength(1);
  });

  it("17: never fabricates parcel geometry from profile acres", async () => {
    const user = sub("no-fabrication");
    expect((await seedProfile(user, { acres: 2.5 })).status).toBe(200);

    const list = await api().get("/profile/parcels").set(authHeader(user));
    const profile = await api().get("/profile").set(authHeader(user));
    const missingGeometry = await createParcel(user, { name: "No geometry", crop: "Paddy" });

    expect(list.status).toBe(200);
    expect(list.body.data.parcels).toEqual([]);
    expect(profile.status).toBe(200);
    expect(profile.body.data.profile.acres).toBe(2.5);
    expect(profile.body.data.profile.parcels).toEqual([]);
    expect(missingGeometry.status).toBe(400);
  });

  it("18: updates parcel name and crop without changing authoritative area", async () => {
    const user = sub("patch-metadata");
    expect((await seedProfile(user)).status).toBe(200);
    const geometry = squareGeometry(0.009);
    const created = await createParcel(user, { name: "Old name", crop: "Paddy", geometry });
    const parcelId = created.body.data.parcel.parcelId;

    const response = await api()
      .patch(`/profile/parcels/${parcelId}`)
      .set(authHeader(user))
      .send({ name: "New name", crop: "Sugarcane" });

    expect(response.status).toBe(200);
    expect(response.body.data.parcel.name).toBe("New name");
    expect(response.body.data.parcel.crop).toBe("Sugarcane");
    expect(response.body.data.parcel.geometry).toEqual(geometry);
    expect(response.body.data.parcel.calculatedAreaAcres).toBe(calculateParcelAreaAcres(geometry));
    expect(new Date(response.body.data.parcel.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(response.body.data.parcel.createdAt).getTime()
    );
  });

  it("19: recalculates authoritative area when geometry changes", async () => {
    const user = sub("patch-geometry");
    expect((await seedProfile(user)).status).toBe(200);
    const created = await createParcel(user, {
      name: "Changing field",
      crop: "Paddy",
      geometry: squareGeometry(0.009),
    });
    const parcelId = created.body.data.parcel.parcelId;
    const nextGeometry = triangleGeometry();

    const response = await api()
      .patch(`/profile/parcels/${parcelId}`)
      .set(authHeader(user))
      .send({ geometry: nextGeometry });

    expect(response.status).toBe(200);
    expect(response.body.data.parcel.geometry).toEqual(nextGeometry);
    expect(response.body.data.parcel.calculatedAreaAcres).toBe(
      calculateParcelAreaAcres(nextGeometry)
    );
    expect(response.body.data.parcel.calculatedAreaAcres).not.toBe(
      created.body.data.parcel.calculatedAreaAcres
    );
  });

  it("20: rejects an empty parcel update", async () => {
    const user = sub("patch-empty");
    expect((await seedProfile(user)).status).toBe(200);
    const created = await createParcel(user, {
      name: "Empty patch field",
      crop: "Paddy",
      geometry: squareGeometry(0.009),
    });
    const parcelId = created.body.data.parcel.parcelId;

    const response = await api()
      .patch(`/profile/parcels/${parcelId}`)
      .set(authHeader(user))
      .send({});

    expect(response.status).toBe(400);
  });

  it("21: ignores non-modifiable parcel fields sent in an update", async () => {
    const user = sub("patch-immutable");
    expect((await seedProfile(user)).status).toBe(200);
    const created = await createParcel(user, {
      name: "Immutable field",
      crop: "Paddy",
      geometry: squareGeometry(0.009),
    });
    const parcelId = created.body.data.parcel.parcelId;

    const response = await api()
      .patch(`/profile/parcels/${parcelId}`)
      .set(authHeader(user))
      .send({
        name: "Still mine",
        parcelId: "par_12345678-1234-1234-1234-123456789012",
        calculatedAreaAcres: 1,
        cognitoSub: sub("someone-else"),
      });

    expect(response.status).toBe(200);
    expect(response.body.data.parcel.parcelId).toBe(parcelId);
    expect(response.body.data.parcel.name).toBe("Still mine");
    expect(response.body.data.parcel.calculatedAreaAcres).toBe(
      created.body.data.parcel.calculatedAreaAcres
    );
  });

  it("22: preserves the stored parcel when an update has invalid geometry", async () => {
    const user = sub("patch-invalid");
    expect((await seedProfile(user)).status).toBe(200);
    const geometry = squareGeometry(0.009);
    const created = await createParcel(user, {
      name: "Preserved field",
      crop: "Paddy",
      geometry,
    });
    const parcelId = created.body.data.parcel.parcelId;

    const response = await api()
      .patch(`/profile/parcels/${parcelId}`)
      .set(authHeader(user))
      .send({ geometry: bowtieGeometry() });
    const reread = await api().get(`/profile/parcels/${parcelId}`).set(authHeader(user));

    expect(response.status).toBe(400);
    expect(reread.status).toBe(200);
    expect(reread.body.data.parcel.geometry).toEqual(geometry);
  });

  it("23: returns 404 when updating a parcel that does not belong to the caller", async () => {
    const user = sub("patch-missing");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await api()
      .patch("/profile/parcels/par_12345678-1234-1234-1234-123456789012")
      .set(authHeader(user))
      .send({ name: "Ghost" });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("Parcel not found");
  });

  it("24: deletes only the selected parcel and keeps the profile and siblings", async () => {
    const user = sub("delete-one");
    expect((await seedProfile(user)).status).toBe(200);
    const first = await createParcel(user, {
      name: "First field",
      crop: "Paddy",
      geometry: squareGeometry(0.009),
    });
    const second = await createParcel(user, {
      name: "Second field",
      crop: "Sugarcane",
      geometry: triangleGeometry(),
    });
    const firstId = first.body.data.parcel.parcelId;
    const secondId = second.body.data.parcel.parcelId;

    const response = await api().delete(`/profile/parcels/${firstId}`).set(authHeader(user));
    const list = await api().get("/profile/parcels").set(authHeader(user));
    const profile = await api().get("/profile").set(authHeader(user));
    const missing = await api().get(`/profile/parcels/${firstId}`).set(authHeader(user));

    expect(response.status).toBe(200);
    expect(list.body.data.parcels.map((parcel) => parcel.parcelId)).toEqual([secondId]);
    expect(profile.status).toBe(200);
    expect(missing.status).toBe(404);
  });

  it("25: returns 404 when deleting a parcel that does not belong to the caller", async () => {
    const user = sub("delete-missing");
    expect((await seedProfile(user)).status).toBe(200);
    const response = await api()
      .delete("/profile/parcels/par_12345678-1234-1234-1234-123456789012")
      .set(authHeader(user));

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("Parcel not found");
  });

  it("26: keeps a legacy profile without parcels readable with an empty parcel list", async () => {
    const user = sub("legacy-readable");
    await FarmProfile.collection.insertOne({
      cognitoSub: user,
      userEmail: "legacy@example.com",
      district: "Thanjavur",
      crops: ["Paddy"],
      acres: 2.5,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const list = await api().get("/profile/parcels").set(authHeader(user));
    const profile = await api().get("/profile").set(authHeader(user));

    expect(list.status).toBe(200);
    expect(list.body.data.parcels).toEqual([]);
    expect(profile.status).toBe(200);
    expect(profile.body.data.profile.parcels).toEqual([]);
  });

  it("27: adds a parcel to a legacy profile without migrating unrelated fields", async () => {
    const user = sub("legacy-additive");
    await FarmProfile.collection.insertOne({
      cognitoSub: user,
      userEmail: "legacy@example.com",
      district: "Thanjavur",
      crops: ["Paddy"],
      acres: 2.5,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await createParcel(user, {
      name: "Legacy field",
      crop: "Paddy",
      geometry: squareGeometry(0.009),
    });
    const profile = await api().get("/profile").set(authHeader(user));

    expect(response.status).toBe(200);
    expect(profile.status).toBe(200);
    expect(profile.body.data.profile.acres).toBe(2.5);
    expect(profile.body.data.profile.parcels).toHaveLength(1);
  });

  it("28: does not convert profile acres into parcel geometry", async () => {
    const user = sub("legacy-acres");
    expect((await seedProfile(user, { acres: 2.5 })).status).toBe(200);
    const geometry = squareGeometry(0.004);
    const created = await createParcel(user, { name: "Small field", crop: "Paddy", geometry });
    const profile = await api().get("/profile").set(authHeader(user));

    expect(created.body.data.parcel.calculatedAreaAcres).toBe(calculateParcelAreaAcres(geometry));
    expect(created.body.data.parcel.calculatedAreaAcres).not.toBe(2.5);
    expect(profile.body.data.profile.acres).toBe(2.5);
  });

  it("29: rejects malformed parcel identifiers without exposing data", async () => {
    const user = sub("param-validation");
    expect((await seedProfile(user)).status).toBe(200);
    const numeric = await api().get("/profile/parcels/123").set(authHeader(user));
    const uppercase = await api()
      .get("/profile/parcels/par_12345678-1234-1234-1234-123456789ABC")
      .set(authHeader(user));

    expect(numeric.status).toBe(400);
    expect(numeric.body.message).toBe("Invalid parcel ID");
    expect(uppercase.status).toBe(400);
    expect(numeric.body.data).toEqual({});
  });

  it("30: returns sanitized errors that never echo crafted request body", async () => {
    const user = sub("sanitized-errors");
    expect((await seedProfile(user)).status).toBe(200);
    const crafted = "77.123456";
    const response = await createParcel(user, {
      name: "Crafted field",
      crop: "Paddy",
      geometry: { type: "Point", coordinates: [crafted, 0] },
    });

    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty("geometry");
    expect(JSON.stringify(response.body)).not.toContain(crafted);
    expect(response.body.data).toEqual({});
  });

  it("31: rejects malformed JSON with a sanitized error", async () => {
    const response = await api()
      .post("/profile/parcels")
      .set(authHeader(sub("malformed-json")))
      .set("Content-Type", "application/json")
      .send('{"name": "Broken field",');

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Invalid JSON payload");
    expect(response.body.data).toEqual({});
  });
});
