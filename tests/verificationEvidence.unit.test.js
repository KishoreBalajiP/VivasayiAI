import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SOURCES,
  EVIDENCE_STATUSES,
  FUTURE_EVIDENCE_SOURCES,
  OPERATIVE_EVIDENCE_SOURCES,
  EVIDENCE_FOUNDATION_VERSION,
  isEvidenceSource,
  isEvidenceStatus,
  isOperativeEvidenceSource,
  validateEvidenceSource,
  validateEvidenceStatus,
  validateEvidenceConfidence,
  validateEvidencePayload,
  sanitizeEvidencePayload,
  buildVerificationEvidence,
  projectExistingEvidence,
} from "../utils/verificationEvidence.js";

// Phase 11 (E11-S11) — pure foundation logic. No DB, no HTTP: the frozen vocabularies, input
// validation, safe-metadata normalization and the read-only projection of EXISTING evidence.
// The Mongo-backed service behaviours (ownership, audit, idempotency) live in
// tests/verificationEvidence.test.js.

describe("Verification Evidence Foundation — vocabulary", () => {
  it("defines exactly the five canonical sources", () => {
    expect(EVIDENCE_SOURCES).toEqual(["GEOMETRY", "AI_IMAGE", "WEATHER", "OWNERSHIP", "SATELLITE"]);
  });

  it("defines exactly the seven evidence-level statuses", () => {
    expect(EVIDENCE_STATUSES).toEqual([
      "NOT_CHECKED",
      "PENDING",
      "AVAILABLE",
      "VERIFIED",
      "INSUFFICIENT",
      "INCONSISTENT",
      "UNAVAILABLE",
    ]);
  });

  it("splits sources into operative vs future without overlap", () => {
    expect(OPERATIVE_EVIDENCE_SOURCES).toEqual(["GEOMETRY", "AI_IMAGE", "WEATHER"]);
    expect(FUTURE_EVIDENCE_SOURCES).toEqual(["OWNERSHIP", "SATELLITE"]);
    const union = [...OPERATIVE_EVIDENCE_SOURCES, ...FUTURE_EVIDENCE_SOURCES];
    expect([...union].sort()).toEqual([...EVIDENCE_SOURCES].sort());
    for (const source of FUTURE_EVIDENCE_SOURCES) {
      expect(isOperativeEvidenceSource(source)).toBe(false);
    }
    for (const source of OPERATIVE_EVIDENCE_SOURCES) {
      expect(isOperativeEvidenceSource(source)).toBe(true);
    }
  });

  it("exposes a foundation version independent of the engine version", () => {
    expect(EVIDENCE_FOUNDATION_VERSION).toBe("1");
  });

  it("recognizes valid sources/statuses and rejects unknown ones", () => {
    expect(isEvidenceSource("GEOMETRY")).toBe(true);
    expect(isEvidenceSource("TELEPATHY")).toBe(false);
    expect(validateEvidenceSource("SATELLITE")).toEqual({ ok: true });
    expect(validateEvidenceSource("GPS").ok).toBe(false);

    expect(isEvidenceStatus("INCONSISTENT")).toBe(true);
    expect(isEvidenceStatus("approved")).toBe(false);
    expect(validateEvidenceStatus("AVAILABLE")).toEqual({ ok: true });
    expect(validateEvidenceStatus("processing").ok).toBe(false);
  });

  it("never treats an evidence status as a claim lifecycle state", () => {
    const CLAIM_STATES = [
      "draft",
      "submitted",
      "processing",
      "verified",
      "partially_verified",
      "more_evidence_required",
      "rejected",
      "out_of_limit",
      "duplicate_area",
      "withdrawn",
    ];
    for (const status of EVIDENCE_STATUSES) {
      expect(CLAIM_STATES).not.toContain(status);
    }
    // The only shared token is "verified" as a DIFFERENT concept (mixed casing keeps it distinct).
    expect(EVIDENCE_STATUSES).not.toContain("verified");
  });
});

describe("Verification Evidence Foundation — validation", () => {
  it("validates confidence as an optional number in [0,1]", () => {
    expect(validateEvidenceConfidence(null)).toEqual({ ok: true });
    expect(validateEvidenceConfidence(0)).toEqual({ ok: true });
    expect(validateEvidenceConfidence(0.87)).toEqual({ ok: true });
    expect(validateEvidenceConfidence(1)).toEqual({ ok: true });
    expect(validateEvidenceConfidence(-0.1).ok).toBe(false);
    expect(validateEvidenceConfidence(1.1).ok).toBe(false);
    expect(validateEvidenceConfidence("high").ok).toBe(false);
  });

  it("accepts safe source-neutral metadata and results", () => {
    expect(validateEvidencePayload({ provider: "open-meteo", precipitationMm: 12 })).toEqual({ ok: true });
    expect(validateEvidencePayload(null)).toEqual({ ok: true });
    expect(validateEvidencePayload({ nested: { depth: { ok: true } } })).toEqual({ ok: true });
  });

  it("refuses storage internals, credentials, prompts and raw content anywhere in metadata", () => {
    for (const forbidden of [
      { s3Key: "claims/x" },
      { s3Bucket: "bucket" },
      { cognitoSub: "user" },
      { token: "abc" },
      { apiKey: "abc" },
      { prompt: "system prompt" },
      { imageBytes: "..." },
      { nested: { signedUrl: "https://..." } },
      { list: [{ password: "x" }] },
    ]) {
      const result = validateEvidencePayload(forbidden);
      expect(result.ok, JSON.stringify(forbidden)).toBe(false);
    }
  });

  it("refuses an oversized metadata payload", () => {
    const huge = { blob: "x".repeat(5000) };
    expect(validateEvidencePayload(huge).ok).toBe(false);
  });

  it("caps nested strings/arrays in the sanitized payload", () => {
    const sanitized = sanitizeEvidencePayload({ note: "y".repeat(1000), list: new Array(100).fill("a") });
    expect(sanitized.note.length).toBeLessThanOrEqual(512);
    expect(sanitized.list.length).toBeLessThanOrEqual(64);
  });
});

describe("Verification Evidence Foundation — canonical builder", () => {
  it("builds a normalized record with defaults and an operative flag", () => {
    const record = buildVerificationEvidence({ source: "AI_IMAGE" });
    expect(record).toMatchObject({
      source: "AI_IMAGE",
      status: "NOT_CHECKED",
      confidence: null,
      observedAt: null,
      provider: null,
      providerVersion: null,
      evidenceVersion: null,
      evaluationVersion: null,
      reference: null,
      metadata: {},
      result: null,
      operative: true,
    });
  });

  it("marks OWNERSHIP / SATELLITE as non-operative but still representable", () => {
    expect(buildVerificationEvidence({ source: "OWNERSHIP", status: "PENDING" }).operative).toBe(false);
    expect(buildVerificationEvidence({ source: "SATELLITE", status: "AVAILABLE" }).operative).toBe(false);
  });

  it("preserves provider/version/timestamp metadata for reproducibility", () => {
    const observedAt = new Date("2026-03-01T10:00:00.000Z");
    const record = buildVerificationEvidence({
      source: "SATELLITE",
      status: "AVAILABLE",
      confidence: 0.72,
      observedAt,
      provider: "example-provider",
      providerVersion: "2.1.0",
      evidenceVersion: "ev-2026-03",
      evaluationVersion: "foundation-1",
      reference: "scene_ref_001",
      metadata: { acquisitionType: "optical", cloudCover: 4 },
    });
    expect(record.observedAt).toEqual(observedAt);
    expect(record.provider).toBe("example-provider");
    expect(record.providerVersion).toBe("2.1.0");
    expect(record.evidenceVersion).toBe("ev-2026-03");
    expect(record.evaluationVersion).toBe("foundation-1");
    expect(record.confidence).toBe(0.72);
  });

  it("throws a 400 ApiError on invalid source/status/confidence/metadata", () => {
    expect(() => buildVerificationEvidence({ source: "MAGIC" })).toThrowError(/source/i);
    expect(() => buildVerificationEvidence({ source: "GEOMETRY", status: "approved" })).toThrowError(/status/i);
    expect(() => buildVerificationEvidence({ source: "GEOMETRY", confidence: 2 })).toThrowError(/confidence/i);
    expect(() => buildVerificationEvidence({ source: "GEOMETRY", metadata: { token: "x" } })).toThrowError(/disallowed/i);
    try {
      buildVerificationEvidence({ source: "MAGIC" });
    } catch (error) {
      expect(error.statusCode).toBe(400);
    }
  });
});

describe("Verification Evidence Foundation — existing-evidence projection", () => {
  const claim = {
    _id: "c_1",
    parcelId: "par_1",
    claimedAreaAcres: 0.5,
    claimedGeometry: { type: "Polygon", coordinates: [[[77, 11], [77.1, 11], [77.1, 11.1], [77, 11]]] },
  };

  it("always represents GEOMETRY from a persisted claim (server authority)", () => {
    const records = projectExistingEvidence({ claim });
    const geometry = records.filter((r) => r.source === "GEOMETRY");
    expect(geometry).toHaveLength(1);
    expect(geometry[0].status).toBe("AVAILABLE");
    expect(geometry[0].provider).toBe("server-geometry");
    expect(geometry[0].metadata.claimedAreaAcres).toBe(0.5);
    expect(geometry[0].evidenceVersion).toBeTruthy();
    expect(geometry[0].operative).toBe(true);
  });

  it("represents AI_IMAGE only for stored evidence, mapping the assessment status", () => {
    const records = projectExistingEvidence({
      claim,
      assessment: {
        status: "completed",
        model: "gemini/x",
        version: "1",
        evidenceVersion: "ev-1",
        aiImageAssessments: [
          { uploadId: "img_a", observation: { damageDetected: true, damageType: "flood", severity: "moderate", imageQuality: "good" } },
        ],
      },
      evidenceDocs: [
        { uploadId: "img_a", status: "stored", mediaType: "image/png", width: 10, height: 10 },
        { uploadId: "img_b", status: "pending", mediaType: "image/png" },
      ],
    });
    const ai = records.filter((r) => r.source === "AI_IMAGE");
    expect(ai).toHaveLength(1); // pending evidence never projects
    expect(ai[0].reference).toBe("img_a");
    expect(ai[0].status).toBe("AVAILABLE");
    expect(ai[0].provider).toBe("gemini/x");
    expect(ai[0].result.damageDetected).toBe(true);
  });

  it("maps a failed/pending assessment to UNAVAILABLE/PENDING", () => {
    const failed = projectExistingEvidence({
      claim,
      assessment: { status: "failed", aiImageAssessments: [] },
      evidenceDocs: [{ uploadId: "img_a", status: "stored" }],
    }).find((r) => r.source === "AI_IMAGE");
    expect(failed.status).toBe("UNAVAILABLE");

    const pending = projectExistingEvidence({
      claim,
      assessment: { status: "processing", aiImageAssessments: [] },
      evidenceDocs: [{ uploadId: "img_a", status: "stored" }],
    }).find((r) => r.source === "AI_IMAGE");
    expect(pending.status).toBe("PENDING");
  });

  it("represents WEATHER only when a correlation exists", () => {
    expect(projectExistingEvidence({ claim }).some((r) => r.source === "WEATHER")).toBe(false);
    const records = projectExistingEvidence({
      claim,
      weatherCorrelation: { eventMatch: true, precipitationMm: 30, weatherCode: 65, source: "open-meteo" },
    });
    const weather = records.find((r) => r.source === "WEATHER");
    expect(weather).toBeTruthy();
    expect(weather.status).toBe("AVAILABLE");
    expect(weather.provider).toBe("open-meteo");
    expect(weather.result.eventMatch).toBe(true);
  });

  it("never projects OWNERSHIP/SATELLITE (they have no existing backing data)", () => {
    const sources = projectExistingEvidence({ claim }).map((r) => r.source);
    expect(sources).not.toContain("OWNERSHIP");
    expect(sources).not.toContain("SATELLITE");
  });
});
