import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

// The claim-vision call site runs for real against a fake model (no live Gemini). The image-AI mode
// is read once when config/env.js loads, so it is set before any import.
vi.hoisted(() => {
  process.env.IMAGE_AI_MODE = "live";
});

const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));
vi.mock("../services/chat.service.js", () => ({
  model: { generate: (...args) => mockGenerate(...args) },
  generateResponse: vi.fn(),
  performRAG: vi.fn(),
}));

import ApiError from "../utils/ApiError.js";
import { AiTimeoutError } from "../utils/aiTimeout.js";
import logger from "../utils/logger.js";
import {
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_KINDS,
  ProviderError,
  classifyProviderError,
  logProviderError,
  toProviderError,
} from "../utils/providerErrors.js";
import { analyzeClaimImage } from "../services/claimVision.service.js";

// Provider error taxonomy (plan A1): PE-1..PE-3. Pure, apart from the claim-vision call site, which
// uses a fake model.

const withStatus = (status, message = "provider said no") => Object.assign(new Error(message), { status });
const withCode = (code, message = "socket problem") => Object.assign(new Error(message), { code });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// Strings that must never reach a log record.
const SECRET_KEY = "AIzaSyTESTSECRETKEY0123456789";
const PROMPT = "You are an agricultural loss assessor. Return the observation JSON";
const URL_WITH_KEY = `https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${SECRET_KEY}`;
const BODY = '{"error":{"message":"farmer Ravi at 10.78,79.14 quota exhausted"}}';
const leakyProviderError = () =>
  Object.assign(new Error(`[429 Too Many Requests] ${PROMPT} ${URL_WITH_KEY} ${BODY}`), {
    status: 429,
    response: { status: 429, data: BODY, config: { url: URL_WITH_KEY, headers: { "x-goog-api-key": SECRET_KEY } } },
  });

const captureLogger = () => {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { log: pino({ level: "debug" }, stream), lines };
};

describe("provider error taxonomy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockGenerate.mockReset();
  });

  it("PE-1: the classifier maps each provider failure to exactly one kind", () => {
    const table = [
      [withStatus(429), "quota"],
      [new Error("[429] RESOURCE_EXHAUSTED: You exceeded your current quota"), "quota"],
      [withStatus(503), "overload"],
      [withStatus(502), "overload"],
      [withStatus(504), "overload"],
      [new Error("The model is overloaded. Please try again later."), "overload"],
      [new Error("[503 Service Unavailable] UNAVAILABLE"), "overload"],
      [withStatus(401), "auth_config"],
      [withStatus(403), "auth_config"],
      [withStatus(400, "API key not valid. Please pass a valid API key."), "auth_config"],
      [new AiTimeoutError("claim.vision_analyze", 25000), "timeout"],
      [withCode("ECONNABORTED"), "timeout"],
      [withCode("ETIMEDOUT"), "timeout"],
      [Object.assign(new Error("This operation was aborted"), { name: "AbortError" }), "timeout"],
      [withCode("ECONNRESET"), "network"],
      [withCode("ENOTFOUND"), "network"],
      [withCode("EAI_AGAIN"), "network"],
      [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), "network"],
      [new TypeError("Cannot read properties of undefined (reading 'text')"), "application_defect"],
      [new Error("anything else"), "application_defect"],
      [null, "application_defect"],
      // Our own envelopes describe OUR response, not the provider's: a 500 "storage unavailable"
      // ApiError is not a provider overload.
      [ApiError.internal("Image storage unavailable"), "application_defect"],
      [ApiError.serviceUnavailable("Something"), "application_defect"],
      // A kind decided deeper down is never re-guessed.
      [new ProviderError({ kind: "storage" }), "storage"],
      [new ProviderError({ kind: "malformed_response" }), "malformed_response"],
    ];
    for (const [error, kind] of table) {
      expect(classifyProviderError(error), String(error && error.message)).toBe(kind);
    }
    expect(Object.values(PROVIDER_ERROR_KINDS).sort()).toEqual(
      ["application_defect", "auth_config", "malformed_response", "network", "overload", "quota", "storage", "timeout"]
    );
  });

  it("PE-2: ProviderError keeps ApiError behaviour, carries kind/code/retryable, and its messages are farmer-safe", () => {
    for (const kind of Object.values(PROVIDER_ERROR_KINDS)) {
      const error = new ProviderError({ kind, provider: "gemini", operation: "op" });
      expect(error).toBeInstanceOf(ApiError);
      expect(error.kind).toBe(kind);
      expect(error.code).toBe(PROVIDER_ERROR_CODES[kind]);
      expect(error.retryable).toBe(kind !== "application_defect");
      expect(error.statusCode).toBe(["quota", "overload", "auth_config"].includes(kind) ? 503 : 500);
      expect(error.message).not.toMatch(/gemini|google|langchain|stack|key/i);
    }
    expect(new ProviderError({ kind: "quota" }).message).toBe("AI service is busy. Please try again later.");
    expect(new ProviderError({ kind: "auth_config" }).message).toBe("AI service is temporarily unavailable");
    // A call site can keep its historical status and message while gaining a kind.
    const legacy = new ProviderError({ kind: "quota", statusCode: 500, message: "Failed to analyze claim evidence image" });
    expect(legacy.statusCode).toBe(500);
    expect(legacy.message).toBe("Failed to analyze claim evidence image");
    expect(legacy.code).toBe("PROVIDER_QUOTA");
    // toProviderError wraps once and never re-classifies an existing ProviderError.
    const wrapped = toProviderError(withStatus(503), { provider: "gemini", operation: "x" });
    expect(wrapped).toMatchObject({ kind: "overload", httpStatus: 503, provider: "gemini", operation: "x", retryable: true });
    expect(toProviderError(wrapped)).toBe(wrapped);
    // An unknown kind is a defect, never a silently retried "transient".
    expect(new ProviderError({ kind: "made-up" }).kind).toBe("application_defect");
  });

  it("PE-3: provider-error logs carry codes only: no prompt, key, URL or response body", async () => {
    const { log, lines } = captureLogger();
    const record = logProviderError(log, leakyProviderError(), { claimId: "c1", requestId: "r1", prompt: PROMPT, url: URL_WITH_KEY });
    expect(record).toMatchObject({ code: "PROVIDER_QUOTA", kind: "quota", retryable: true, claimId: "c1", requestId: "r1" });

    // The ProviderError itself, logged as `err` by the HTTP error middleware, keeps no provider text.
    log.error({ err: toProviderError(leakyProviderError(), { provider: "gemini", operation: "claim.vision_analyze" }) }, "request failed");

    // The real claim-vision call site: its log calls carry no provider text either.
    const seen = [];
    for (const level of ["error", "warn", "info", "debug"]) {
      vi.spyOn(logger, level).mockImplementation((...args) => { seen.push(JSON.stringify(args)); });
    }
    mockGenerate.mockRejectedValueOnce(leakyProviderError());
    await expect(analyzeClaimImage({ imageBuffer: PNG, mediaType: "image/png" })).rejects.toMatchObject({
      statusCode: 500,
      message: "Failed to analyze claim evidence image",
      kind: "quota",
      code: "PROVIDER_QUOTA",
    });

    const output = [...lines, ...seen].join("\n");
    expect(output).toContain("PROVIDER_QUOTA");
    for (const forbidden of [SECRET_KEY, PROMPT, "generativelanguage.googleapis.com", "farmer Ravi", "10.78,79.14", "x-goog-api-key"]) {
      expect(output).not.toContain(forbidden);
    }
    // auth_config and defects are errors an operator must act on; transient kinds are warnings.
    const levels = [];
    const spyLog = { error: () => levels.push("error"), warn: () => levels.push("warn") };
    logProviderError(spyLog, withStatus(401));
    logProviderError(spyLog, new TypeError("bug"));
    logProviderError(spyLog, withStatus(503));
    expect(levels).toEqual(["error", "error", "warn"]);
    expect(logProviderError(() => {}, withStatus(403)).operatorAction).toBe(true);
  });
});
