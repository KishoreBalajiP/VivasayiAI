import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import app from "../app.js";
import { signAccessToken } from "../utils/token.js";
import FarmProfile from "../models/FarmProfile.js";

export const api = () => request(app);

export const startTestDatabase = async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "parcel-foundation-test" });
  return mongo;
};

export const stopTestDatabase = async (mongo) => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
};

export const clearTestDatabase = async () => {
  await FarmProfile.deleteMany({});
};

export const authHeader = (cognitoSub, email = "farmer@example.com") => {
  const token = signAccessToken({ cognitoSub, email });
  return { Authorization: `Bearer ${token}` };
};

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
