import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const POOL = "ap-south-1_TESTPOOL1";
const ISS = `https://cognito-idp.ap-south-1.amazonaws.com/${POOL}`;
vi.hoisted(() => {
  process.env.COGNITO_CLIENT_ID = "client-abc";
  process.env.COGNITO_USER_POOL_ID = "ap-south-1_TESTPOOL1";
});

import { _clearCache, _setFetcher, cacheSize } from "../utils/jwks.js";
import { verifyToken } from "../utils/token.js";

// Cognito id-token verification with real RS256 keys. A forged, mis-addressed or wrong-kind token
// must come back null (fail closed). The signing keys are generated here; nothing is a real secret.

const pair = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
let good;
let other;
const jwkOf = (keys, kid) => ({ ...keys.publicKey.export({ format: "jwk" }), kid, kty: "RSA", alg: "RS256", use: "sig" });

const sign = (payload = {}, { key = good, kid = "kid-1", alg = "RS256", noKid = false } = {}) =>
  jwt.sign({ sub: "user-1", email: "a@example.com", token_use: "id", ...payload }, key.privateKey, {
    algorithm: alg, ...(noKid ? {} : { keyid: kid }), issuer: payload.iss ?? ISS, audience: payload.aud ?? "client-abc", expiresIn: 300,
  });

describe("verifyToken (Cognito id tokens)", () => {
  beforeAll(() => { good = pair(); other = pair(); });
  beforeEach(() => {
    _clearCache();
    _setFetcher(async () => ({ keys: [jwkOf(good, "kid-1")] }));
  });

  it("TV-1: a correctly signed id token for this app and pool verifies", async () => {
    const payload = await verifyToken(sign());
    expect(payload).toMatchObject({ sub: "user-1", token_use: "id" });
  });

  it("TV-2: a token signed by a DIFFERENT key but claiming the right kid is rejected", async () => {
    expect(await verifyToken(sign({}, { key: other }))).toBeNull();
  });

  it("TV-3: a token for another app client (audience) is rejected", async () => {
    const token = jwt.sign({ sub: "u", token_use: "id" }, good.privateKey, { algorithm: "RS256", keyid: "kid-1", issuer: ISS, audience: "someone-elses-client", expiresIn: 300 });
    expect(await verifyToken(token)).toBeNull();
  });

  it("TV-4: an expired token is rejected", async () => {
    const token = jwt.sign({ sub: "u", token_use: "id" }, good.privateKey, { algorithm: "RS256", keyid: "kid-1", issuer: ISS, audience: "client-abc", expiresIn: -10 });
    expect(await verifyToken(token)).toBeNull();
  });

  it("TV-5: a token from ANOTHER Cognito pool is rejected when a pool is configured, even if validly signed by that pool", async () => {
    const otherIss = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_ATTACKER9";
    const token = jwt.sign({ sub: "u", token_use: "id" }, good.privateKey, { algorithm: "RS256", keyid: "kid-1", issuer: otherIss, audience: "client-abc", expiresIn: 300 });
    expect(await verifyToken(token)).toBeNull();
  });

  it("TV-6: an access token (token_use: access) is not accepted as an id token", async () => {
    expect(await verifyToken(sign({ token_use: "access" }))).toBeNull();
    expect(await verifyToken(sign({ token_use: undefined }))).toBeNull();
  });

  it("TV-7: algorithm confusion is refused: an HS256 token 'signed' with the public key", async () => {
    const publicPem = good.publicKey.export({ type: "spki", format: "pem" });
    const forged = jwt.sign({ sub: "attacker", token_use: "id" }, publicPem, { algorithm: "HS256", keyid: "kid-1", issuer: ISS, audience: "client-abc", expiresIn: 300 });
    expect(await verifyToken(forged)).toBeNull();
  });

  it("TV-8: alg none, a missing kid, an unknown kid and a tampered payload are all rejected", async () => {
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "kid-1" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "x", iss: ISS, aud: "client-abc", token_use: "id", exp: 9999999999 })).toString("base64url")}.`;
    expect(await verifyToken(none)).toBeNull();
    expect(await verifyToken(sign({}, { noKid: true }))).toBeNull();
    expect(await verifyToken(sign({}, { kid: "unknown-kid" }))).toBeNull();
    const [h, , s] = sign().split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: "admin", iss: ISS, aud: "client-abc", token_use: "id", exp: 9999999999 })).toString("base64url")}.${s}`;
    expect(await verifyToken(tampered)).toBeNull();
  });

  it("TV-9: a non-Cognito issuer never triggers a key fetch", async () => {
    const fetcher = vi.fn(async () => ({ keys: [] }));
    _setFetcher(fetcher);
    const token = jwt.sign({ sub: "u", token_use: "id" }, good.privateKey, { algorithm: "RS256", keyid: "kid-1", issuer: "https://evil.example.com/pool", audience: "client-abc", expiresIn: 300 });
    expect(await verifyToken(token)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("TV-10: a failing key endpoint fails closed", async () => {
    _setFetcher(async () => { throw new Error("network"); });
    expect(await verifyToken(sign())).toBeNull();
  });

  it("TV-11: the key cache is bounded, so many issuers cannot grow it without limit", async () => {
    for (let i = 0; i < 40; i += 1) {
      const iss = `https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_POOL${i}`;
      const token = jwt.sign({ sub: "u", token_use: "id" }, good.privateKey, { algorithm: "RS256", keyid: "kid-1", issuer: iss, audience: "client-abc", expiresIn: 300 });
      await verifyToken(token);
    }
    expect(cacheSize()).toBeLessThanOrEqual(8);
  });
});

describe("diagnoseAccessToken", () => {
  it("TV-12: reports a category for each way a session token can be refused, and never the token", async () => {
    const { diagnoseAccessToken, signAccessToken } = await import("../utils/token.js");
    const valid = signAccessToken({ cognitoSub: "u1", email: "a@example.com" });
    expect(diagnoseAccessToken(valid)).toBe("valid");
    expect(diagnoseAccessToken(undefined)).toBe("missing_token");
    expect(diagnoseAccessToken("")).toBe("missing_token");
    expect(diagnoseAccessToken("not.a.jwt")).toMatch(/^invalid_/);
    expect(diagnoseAccessToken(`${valid.slice(0, -4)}AAAA`)).toMatch(/^invalid_/);
    const expired = jwt.sign({ sub: "u1", tokenType: "access" }, process.env.SESSION_JWT_SECRET, { algorithm: "HS256", issuer: "vivasayi-api", audience: "session", expiresIn: -5 });
    expect(diagnoseAccessToken(expired)).toBe("expired");
    const refresh = jwt.sign({ sub: "u1", tokenType: "refresh" }, process.env.SESSION_JWT_SECRET, { algorithm: "HS256", issuer: "vivasayi-api", audience: "session", expiresIn: 60 });
    expect(diagnoseAccessToken(refresh)).toBe("wrong_token_type");
    expect(String(diagnoseAccessToken(valid))).not.toContain(valid);
  });
});
