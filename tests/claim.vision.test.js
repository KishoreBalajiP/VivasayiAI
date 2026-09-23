import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";

// E9-S4 (ADR-019) — Claim-Loss Vision service unit tests (P4-V01..).
//
// Exercises the REAL claimVision.service.js normalization/guardrail/failure path with a mocked
// model instance (no live Gemini): the shared `model` export from chat.service.js is replaced,
// exactly like the deterministic image-AI seam but at the unit boundary. IMAGE_AI_MODE is forced
// to "live" so the model branch (not the canned mock branch) runs.

const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));

vi.mock("../services/chat.service.js", () => ({
  model: { generate: (...args) => mockGenerate(...args) },
  generateResponse: vi.fn(),
  performRAG: vi.fn(),
}));

const FROZEN_FIELDS = [
  "cropDetected",
  "damageDetected",
  "damageType",
  "severity",
  "visibleAffectedPortion",
  "confidence",
  "uncertain",
  "inconsistencies",
  "observations",
  "imageQuality",
];

const VALID_OBSERVATION = {
  cropDetected: "rice",
  damageDetected: true,
  damageType: "flood",
  severity: "moderate",
  visibleAffectedPortion: "lower portion of the visible field shows standing water",
  confidence: "medium",
  uncertain: false,
  inconsistencies: [],
  observations: ["standing water in the furrows", "lodged plants near the water line"],
  imageQuality: "good",
};

const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const respondWith = (text) => ({
  generations: [[{ text }]],
});

describe("agricultural loss claim — Phase 4 claim-loss vision service", () => {
  let claimVision;

  beforeAll(async () => {
    process.env.IMAGE_AI_MODE = "live";
    vi.resetModules();
    claimVision = await import("../services/claimVision.service.js");
  });

  afterAll(async () => {
    process.env.IMAGE_AI_MODE = "mock";
  });

  afterEach(() => {
    mockGenerate.mockReset();
  });

  const analyze = () =>
    claimVision.analyzeClaimImage({ imageBuffer: PNG_BUFFER, mediaType: "image/png" });

  it("P4-V01: a valid structured response parses into the frozen observation shape", async () => {
    mockGenerate.mockResolvedValue(respondWith(JSON.stringify(VALID_OBSERVATION)));
    const result = await analyze();
    expect(Object.keys(result).sort()).toEqual([...FROZEN_FIELDS].sort());
    expect(result).toEqual({
      ...VALID_OBSERVATION,
      uncertain: false,
      inconsistencies: [],
    });
  });

  it("P4-V02: a JSON response wrapped in markdown fences still parses", async () => {
    mockGenerate.mockResolvedValue(
      respondWith("```json\n" + JSON.stringify(VALID_OBSERVATION) + "\n```")
    );
    const result = await analyze();
    expect(result.cropDetected).toBe("rice");
    expect(result.damageType).toBe("flood");
  });

  it("P4-V03: malformed non-JSON output fails safely into an UNSURE observation", async () => {
    mockGenerate.mockResolvedValue(respondWith("The image seems damaged, I think."));
    const result = await analyze();
    expect(result.uncertain).toBe(true);
    expect(result.confidence).toBe("unclear");
    expect(result.imageQuality).toBe("unclear");
    expect(result.damageDetected).toBeNull();
    expect(result.damageType).toBeNull();
  });

  it("P4-V04: empty model output fails safely into an UNSURE observation", async () => {
    mockGenerate.mockResolvedValue(respondWith(""));
    const result = await analyze();
    expect(result.uncertain).toBe(true);
    expect(result.hasOwnProperty("acreage")).toBe(false);
  });

  it("P4-V05: unknown non-prohibited fields are stripped per the schema policy", async () => {
    mockGenerate.mockResolvedValue(
      respondWith(JSON.stringify({ ...VALID_OBSERVATION, cocktail: "margarita" }))
    );
    const result = await analyze();
    expect(Object.keys(result).sort()).toEqual([...FROZEN_FIELDS].sort());
    expect(result.hasOwnProperty("cocktail")).toBe(false);
  });

  it("P4-V06: acreage/polygon/compensation/approval output is stripped, flagged, never persisted", async () => {
    mockGenerate.mockResolvedValue(
      respondWith(
        JSON.stringify({
          ...VALID_OBSERVATION,
          acreage: 3.2,
          affectedAreaAcres: 2,
          polygon: { type: "Polygon", coordinates: [] },
          compensation: 50000,
          approved: true,
          finalStatus: "verified",
        })
      )
    );
    const result = await analyze();
    for (const forbidden of ["acreage", "affectedAreaAcres", "polygon", "compensation", "approved", "finalStatus"]) {
      expect(result.hasOwnProperty(forbidden)).toBe(false);
    }
    expect(result.uncertain).toBe(true);
    expect(
      result.inconsistencies.some((note) => note.includes("unauthorized field"))
    ).toBe(true);
  });

  it("P4-V07: enum values outside the controlled vocabulary are rounded away (null/unclear), never invented", async () => {
    mockGenerate.mockResolvedValue(
      respondWith(
        JSON.stringify({
          ...VALID_OBSERVATION,
          damageType: "hail",
          severity: "extreme",
          confidence: "very high",
          imageQuality: "excellent",
          damageDetected: "yes",
        })
      )
    );
    const result = await analyze();
    expect(result.damageType).toBeNull();
    expect(result.severity).toBeNull();
    expect(result.confidence).toBe("unclear");
    expect(result.imageQuality).toBe("unclear");
    expect(result.damageDetected).toBeNull();
  });

  it("P4-V08: confidence is clamped, unknowns default to 'unclear'", async () => {
    mockGenerate.mockResolvedValue(
      respondWith(JSON.stringify({ ...VALID_OBSERVATION, confidence: "high" }))
    );
    expect((await analyze()).confidence).toBe("high");

    mockGenerate.mockResolvedValue(respondWith(JSON.stringify({ ...VALID_OBSERVATION })));
    mockGenerate.mockResolvedValueOnce(respondWith(JSON.stringify({ damageDetected: true })));
    const bare = await analyze();
    expect(bare.confidence).toBe("unclear");
    expect(bare.uncertain).toBe(true);
  });

  it("P4-V09: explicit uncertain:false is honored; a missing uncertain defaults to true", async () => {
    mockGenerate.mockResolvedValue(
      respondWith(JSON.stringify({ ...VALID_OBSERVATION, uncertain: false }))
    );
    expect((await analyze()).uncertain).toBe(false);

    const { uncertain, ...withoutUncertain } = VALID_OBSERVATION;
    mockGenerate.mockResolvedValue(respondWith(JSON.stringify(withoutUncertain)));
    expect((await analyze()).uncertain).toBe(true);
  });

  it("P4-V10: visibleAffectedPortion stays a qualitative string, never numeric-converted", async () => {
    mockGenerate.mockResolvedValue(
      respondWith(
        JSON.stringify({ ...VALID_OBSERVATION, visibleAffectedPortion: "about half of the visible field" })
      )
    );
    const result = await analyze();
    expect(result.visibleAffectedPortion).toBe("about half of the visible field");
    expect(typeof result.visibleAffectedPortion).toBe("string");
  });

  it("P4-V11: a provider error surfaces as a sanitized 500 ApiError", async () => {
    mockGenerate.mockRejectedValue(new Error("upstream 500: rate limited"));
    await expect(analyze()).rejects.toMatchObject({ statusCode: 500 });
    await expect(analyze()).rejects.toMatchObject({
      message: "Failed to analyze claim evidence image",
    });
  });

  it("P4-V12: a provider timeout surfaces as the same sanitized 500 ApiError", async () => {
    mockGenerate.mockRejectedValue(new Error("deadline exceeded"));
    await expect(analyze()).rejects.toMatchObject({ statusCode: 500 });
    await expect(analyze()).rejects.toMatchObject({
      message: "Failed to analyze claim evidence image",
    });
  });

  it("P4-V13: normalizeClaimObservation rejects non-object input", () => {
    expect(claimVision.normalizeClaimObservation(null)).toBeNull();
    expect(claimVision.normalizeClaimObservation("text")).toBeNull();
    expect(claimVision.normalizeClaimObservation(42)).toBeNull();
  });
});