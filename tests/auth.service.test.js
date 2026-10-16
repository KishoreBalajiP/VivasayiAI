import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Cognito config is read once at import time (config/env.js), so it must be set before any import.
const SECRET = vi.hoisted(() => {
  process.env.COGNITO_CLIENT_ID = "test-client-id";
  process.env.COGNITO_CLIENT_SECRET = "super-secret-value-123";
  process.env.COGNITO_DOMAIN = "auth.example.test";
  process.env.COGNITO_REDIRECT_URI = "http://localhost:5173";
  return "super-secret-value-123";
});

vi.mock("axios", () => ({
  default: { post: vi.fn(), get: vi.fn(), create: vi.fn(() => ({ post: vi.fn(), get: vi.fn() })) },
}));
vi.mock("../utils/token.js", async (importOriginal) => ({
  ...(await importOriginal()),
  verifyToken: vi.fn(),
}));

import axios from "axios";
import User from "../models/User.js";
import logger from "../utils/logger.js";
import { verifyToken, verifyAccessToken } from "../utils/token.js";
import { googleSignIn } from "../services/auth.service.js";
import { startTestDatabase, stopTestDatabase } from "./helpers.js";

// E1-S2/E1-S3 login. Regressions covered:
//   - every failure (bad code, Cognito outage, bad token) was flattened into HTTP 500 "Authentication
//     failed", so a client could not tell a bad code from an outage;
//   - the raw AxiosError (whose config carries client_secret and the authorization code) was logged;
//   - a legacy user was linked by email without checking `email_verified`, and an existing user bound
//     to a DIFFERENT Cognito identity had its cognitoSub silently overwritten.

const axiosError = ({ status, data, code } = {}) =>
  Object.assign(new Error(status ? `Request failed with status code ${status}` : "network"), {
    isAxiosError: true,
    code,
    response: status ? { status, data } : undefined,
    config: { data: `grant_type=authorization_code&client_secret=${SECRET}&code=the-auth-code` },
  });

const claims = (overrides = {}) => ({
  sub: "sub-new-1",
  email: "farmer@example.com",
  email_verified: true,
  name: "Farmer One",
  ...overrides,
});

const cognitoOk = (decoded) => {
  axios.post.mockResolvedValueOnce({ data: { id_token: "id-token" } });
  verifyToken.mockResolvedValueOnce(decoded);
};

describe("googleSignIn — error mapping, log hygiene, account linking", () => {
  let mongo;
  let errorLog;

  beforeAll(async () => {
    mongo = await startTestDatabase();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await User.deleteMany({});
    axios.post.mockReset();
    verifyToken.mockReset();
    errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorLog.mockRestore();
  });

  it("AU-1: a rejected authorization code is a 401, not a 500", async () => {
    axios.post.mockRejectedValueOnce(axiosError({ status: 400, data: { error: "invalid_grant" } }));
    await expect(googleSignIn("bad-code")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("AU-2: a Cognito outage or timeout is a 502, distinguishable from a bad code", async () => {
    axios.post.mockRejectedValueOnce(axiosError({ code: "ECONNABORTED" }));
    await expect(googleSignIn("code")).rejects.toMatchObject({ statusCode: 502 });
    axios.post.mockRejectedValueOnce(axiosError({ status: 503, data: {} }));
    await expect(googleSignIn("code")).rejects.toMatchObject({ statusCode: 502 });
  });

  it("AU-3: an id_token that fails verification is a 401", async () => {
    cognitoOk(null);
    await expect(googleSignIn("code")).rejects.toMatchObject({ statusCode: 401, message: "Invalid ID token" });
  });

  it("AU-4: failures never log the client secret or the authorization code", async () => {
    axios.post.mockRejectedValueOnce(axiosError({ status: 400, data: { error: "invalid_grant" } }));
    await googleSignIn("the-auth-code").catch(() => {});
    const logged = JSON.stringify(errorLog.mock.calls, (_key, value) =>
      value instanceof Error ? { message: value.message, config: value.config, response: value.response } : value
    );
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("the-auth-code");
    expect(logged).toContain("invalid_grant");
  });

  it("AU-5: the token exchange has a timeout so a hung Cognito cannot hold the Lambda", async () => {
    cognitoOk(claims());
    await googleSignIn("code");
    const config = axios.post.mock.calls[0][2];
    expect(config.timeout).toBeGreaterThan(0);
    expect(config.timeout).toBeLessThanOrEqual(15000);
  });

  it("AU-6: first login creates the user and mints verifiable session tokens with the admin role from the token", async () => {
    cognitoOk(claims({ sub: "sub-admin-1", email: "admin@example.com", "cognito:groups": ["admin"] }));
    const result = await googleSignIn("code");
    expect(result.role).toBe("admin");
    expect(result.user.cognitoSub).toBe("sub-admin-1");
    const verified = verifyAccessToken(result.accessToken);
    expect(verified).toMatchObject({ sub: "sub-admin-1", role: "admin" });
  });

  it("AU-7: a legacy user without a cognitoSub is linked only when the email is verified", async () => {
    await User.create({ name: "Legacy", email: "legacy@example.com" });
    cognitoOk(claims({ sub: "sub-legacy-1", email: "legacy@example.com", email_verified: true }));
    const result = await googleSignIn("code");
    expect(result.user.cognitoSub).toBe("sub-legacy-1");
    expect(await User.countDocuments({ email: "legacy@example.com" })).toBe(1);
  });

  it("AU-8: an UNVERIFIED email never links to a legacy account (403, account untouched)", async () => {
    await User.create({ name: "Legacy", email: "victim@example.com" });
    cognitoOk(claims({ sub: "sub-attacker-1", email: "victim@example.com", email_verified: false }));
    await expect(googleSignIn("code")).rejects.toMatchObject({ statusCode: 403 });
    const legacy = await User.findOne({ email: "victim@example.com" });
    expect(legacy.cognitoSub).toBeUndefined();
  });

  it("AU-9: a user already bound to another Cognito identity is never re-bound (409)", async () => {
    await User.create({ name: "Owner", email: "owner@example.com", cognitoSub: "sub-original" });
    cognitoOk(claims({ sub: "sub-other", email: "owner@example.com", email_verified: true }));
    await expect(googleSignIn("code")).rejects.toMatchObject({ statusCode: 409 });
    expect((await User.findOne({ email: "owner@example.com" })).cognitoSub).toBe("sub-original");
  });

  it("AU-10: a token without an email never matches an unrelated email-less record", async () => {
    await User.create({ name: "Nameless legacy" });
    cognitoOk(claims({ sub: "sub-noemail-1", email: undefined, email_verified: undefined }));
    const result = await googleSignIn("code");
    expect(result.user.cognitoSub).toBe("sub-noemail-1");
    const legacy = await User.findOne({ name: "Nameless legacy" });
    expect(legacy.cognitoSub).toBeUndefined();
  });

  it("AU-11: an unexpected internal failure is still a sanitized 500", async () => {
    cognitoOk(claims());
    const spy = vi.spyOn(User, "findOne").mockRejectedValueOnce(new Error("db exploded"));
    await expect(googleSignIn("code")).rejects.toMatchObject({ statusCode: 500, message: "Authentication failed" });
    spy.mockRestore();
  });
});
