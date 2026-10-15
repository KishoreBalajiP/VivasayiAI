import { afterEach, describe, expect, it, vi } from "vitest";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import { errorHandler } from "../middlewares/error.js";
import { api } from "./helpers.js";

// Body-parser errors other than a JSON syntax error used to be reported as HTTP 500, and every
// expected 4xx was logged at error level (inflating alarms on ordinary client mistakes).

const run = (err) => {
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  errorHandler(err, { requestId: "r1", method: "POST", originalUrl: "/x" }, res, () => {});
  return res;
};

describe("errorHandler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("EM-1: an oversized JSON body is 413, not 500 (real app, 1mb limit)", async () => {
    const big = JSON.stringify({ code: "x".repeat(1_200_000) });
    const response = await api().post("/auth/google").set("Content-Type", "application/json").send(big);
    expect(response.status).toBe(413);
    expect(response.body.message).toBe("Request body too large");
  });

  it("EM-2: malformed JSON stays 400", async () => {
    const response = await api().post("/auth/google").set("Content-Type", "application/json").send("{not json");
    expect(response.status).toBe(400);
  });

  it("EM-3: unsupported charset or encoding is 415", () => {
    expect(run(Object.assign(new Error("x"), { type: "charset.unsupported" })).statusCode).toBe(415);
    expect(run(Object.assign(new Error("x"), { type: "encoding.unsupported" })).statusCode).toBe(415);
  });

  it("EM-4: an unknown error is a sanitized 500", () => {
    const res = run(new Error("secret internals"));
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe("Internal server error");
    expect(JSON.stringify(res.body)).not.toContain("secret internals");
  });

  it("EM-5: expected 4xx are logged as warnings, only 5xx as errors", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    run(ApiError.notFound("nope"));
    run(ApiError.unauthorized("nope"));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    run(new Error("boom"));
    expect(error).toHaveBeenCalledTimes(1);
  });
});
