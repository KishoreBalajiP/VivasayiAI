import http from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import app from "../app.js";
import { signAccessToken } from "../utils/token.js";
import FarmProfile from "../models/FarmProfile.js";

// One HTTP server per test process, on a port we choose.
//
// supertest's default for a bare app is app.listen(0), i.e. a port assigned by the OS from the
// ephemeral range (49152 and up on macOS). Desktop programs listen in that same range on 127.0.0.1
// (an editor helper process did here), and some connections from the tests ended up answered by such
// a program instead of the app, with a foreign 401 or 404 body. That caused rare, unreproducible test
// failures that appeared only under parallel load, and never in any single file. Choosing a port
// below the ephemeral range, bound to 127.0.0.1, and retrying on a conflict avoids that range.
const PORT_RANGE = { min: 20000, max: 39999 };
const listenOnFreePort = async (server) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = PORT_RANGE.min + Math.floor(Math.random() * (PORT_RANGE.max - PORT_RANGE.min));
    const bound = await new Promise((resolve) => {
      const onError = () => resolve(false);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve(true);
      });
    });
    if (bound) return port;
  }
  throw new Error("Could not find a free local port for the test server");
};

const testServer = http.createServer(app);
await listenOnFreePort(testServer);
testServer.unref();

export const api = () => request(testServer);

export const startTestDatabase = async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "parcel-foundation-test" });
  // Mongoose builds indexes asynchronously after connect. Tests that assert unique-index
  // behaviour (e.g. owner-scoped idempotency keys) would race the build, so wait for every
  // registered model's indexes before any test runs.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  return mongo;
};

export const stopTestDatabase = async (mongo) => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
};

export const clearTestDatabase = async () => {
  await FarmProfile.deleteMany({});
};

export const authHeader = (cognitoSub, email = "farmer@example.com", role = null) => {
  const token = signAccessToken({ cognitoSub, email, role });
  return { Authorization: `Bearer ${token}` };
};

// Phase 10 (E9-S10): convenience header for an authenticated ADMIN (role claim in the token).
export const adminHeader = (cognitoSub, email = "admin@example.com") =>
  authHeader(cognitoSub, email, "admin");

export const seedProfile = async (cognitoSub, overrides = {}) => {
  const agent = api();
  const response = await agent
    .post("/profile")
    .set(authHeader(cognitoSub))
    .send({
      district: "Thanjavur",
      crops: ["Paddy"],
      acres: 2.5,
      ...overrides,
    });
  return response;
};

export const squareGeometry = (sizeDegrees = 0.009, origin = [0, 0]) => {
  const [lon, lat] = origin;
  return {
    type: "Polygon",
    coordinates: [
      [
        [lon, lat],
        [lon + sizeDegrees, lat],
        [lon + sizeDegrees, lat + sizeDegrees],
        [lon, lat + sizeDegrees],
        [lon, lat],
      ],
    ],
  };
};

export const triangleGeometry = () => ({
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [0.004, 0],
      [0, 0.004],
      [0, 0],
    ],
  ],
});

