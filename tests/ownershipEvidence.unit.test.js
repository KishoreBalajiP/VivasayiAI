import { describe, expect, it } from "vitest";
import {
  DEFAULT_OWNERSHIP_DOCUMENT_CATEGORY,
  DEFAULT_OWNERSHIP_VERIFICATION_METHOD,
  OWNERSHIP_DOCUMENT_CATEGORIES,
  OWNERSHIP_REVIEW_STATUSES,
  OWNERSHIP_TERMINAL_STATUSES,
  OWNERSHIP_AUTHORITATIVE_METHODS,
  OWNERSHIP_INITIAL_STATUS,
  OWNERSHIP_SOURCE,
  deriveOwnershipIdempotencyKey,
  isOwnershipDocumentCategory,
  isOwnershipReviewStatus,
  isOwnershipVerificationMethod,
  ownershipEvidenceFingerprint,
  resolveOwnershipReviewOutcome,
  validateOwnershipDocumentCategory,
  validateOwnershipReviewReason,
  validateOwnershipUploadId,
} from "../utils/ownershipEvidence.js";

// Phase 12 (E12) — pure ownership vocabulary / validation / review-outcome rules.
// No DB, no Express — these are the invariants the service and routes rely on.

const VALID_UPLOAD_ID = "img_123e4567-e89b-12d3-a456-426614174000";

describe("ownership evidence — pure rules (Phase 12)", () => {
  it("OW-U01: source is the canonical Phase 11 OWNERSHIP source", () => {
    expect(OWNERSHIP_SOURCE).toBe("OWNERSHIP");
  });

  it("OW-U02: document categories are a fixed, non-empty vocabulary with an 'other' fallback", () => {
    expect(OWNERSHIP_DOCUMENT_CATEGORIES.length).toBeGreaterThan(0);
    expect(OWNERSHIP_DOCUMENT_CATEGORIES).toContain("other");
    expect(isOwnershipDocumentCategory("land_record")).toBe(true);
    expect(isOwnershipDocumentCategory("made_up")).toBe(false);
  });

  it("OW-U03: empty/undefined category resolves to the default; unknown is rejected", () => {
    expect(validateOwnershipDocumentCategory(undefined)).toEqual({ ok: true });
    expect(validateOwnershipDocumentCategory("")).toEqual({ ok: true });
    expect(validateOwnershipDocumentCategory(DEFAULT_OWNERSHIP_DOCUMENT_CATEGORY)).toEqual({ ok: true });
    expect(validateOwnershipDocumentCategory("nonsense").ok).toBe(false);
  });

  it("OW-U04: uploadId must match the server-generated img_<uuid> format", () => {
    expect(validateOwnershipUploadId(VALID_UPLOAD_ID)).toEqual({ ok: true });
    expect(validateOwnershipUploadId("not-an-id")).toEqual({
      ok: false,
      reason: "Invalid ownership document reference",
    });
    expect(validateOwnershipUploadId(null).ok).toBe(false);
    expect(validateOwnershipUploadId("img_short").ok).toBe(false);
  });

  it("OW-U05: a fresh document starts PENDING (evidence-level, never a claim state)", () => {
    expect(OWNERSHIP_INITIAL_STATUS).toBe("PENDING");
  });

  it("OW-U06: review statuses are a fixed vocabulary; PENDING/NOT_CHECKED are not review outcomes", () => {
    for (const status of ["AVAILABLE", "VERIFIED", "INSUFFICIENT", "INCONSISTENT", "UNAVAILABLE"]) {
      expect(isOwnershipReviewStatus(status)).toBe(true);
    }
    expect(isOwnershipReviewStatus("PENDING")).toBe(false);
    expect(isOwnershipReviewStatus("NOT_CHECKED")).toBe(false);
    expect(OWNERSHIP_TERMINAL_STATUSES).toEqual(OWNERSHIP_REVIEW_STATUSES);
  });

  it("OW-U07: review reason length is bounded", () => {
    expect(validateOwnershipReviewReason("too short").ok).toBe(false);
    expect(validateOwnershipReviewReason("a".repeat(9)).ok).toBe(false);
    expect(validateOwnershipReviewReason("a".repeat(10)).ok).toBe(true);
    expect(validateOwnershipReviewReason("a".repeat(2001)).ok).toBe(false);
    expect(validateOwnershipReviewReason(undefined).ok).toBe(false);
  });

  it("OW-U08: derived idempotency key is stable, prefixed and within the 64-char contract", () => {
    const key = deriveOwnershipIdempotencyKey(VALID_UPLOAD_ID);
    expect(key).toBe(`owndoc_${VALID_UPLOAD_ID}`);
    expect(key.length).toBeLessThanOrEqual(64);
    expect(/^[A-Za-z0-9_-]+$/.test(key)).toBe(true);
  });

  it("OW-U09: fingerprint is deterministic and changes with the document identity", () => {
    const base = { uploadId: VALID_UPLOAD_ID, mediaType: "image/png", size: 100 };
    expect(ownershipEvidenceFingerprint(base)).toBe(ownershipEvidenceFingerprint({ ...base }));
    expect(ownershipEvidenceFingerprint(base)).not.toBe(
      ownershipEvidenceFingerprint({ ...base, size: 101 })
    );
    expect(ownershipEvidenceFingerprint(base)).not.toBeNull();
  });

  it("OW-U10: manual review of a present/consistent document yields a NON-authoritative AVAILABLE", () => {
    expect(
      resolveOwnershipReviewOutcome({ status: "AVAILABLE", method: DEFAULT_OWNERSHIP_VERIFICATION_METHOD })
    ).toEqual({ ok: true, method: "manual_review", authoritative: false });
  });

  it("OW-U11: manual review may record INSUFFICIENT / INCONSISTENT / UNAVAILABLE (all non-authoritative)", () => {
    for (const status of ["INSUFFICIENT", "INCONSISTENT", "UNAVAILABLE"]) {
      expect(resolveOwnershipReviewOutcome({ status })).toEqual({
        ok: true,
        method: "manual_review",
        authoritative: false,
      });
    }
  });

  it("OW-U12: no authoritative ownership provider is configured this phase", () => {
    expect(OWNERSHIP_AUTHORITATIVE_METHODS).toEqual([]);
  });

  it("OW-U13: VERIFIED is refused (authoritative verification is not configured)", () => {
    const result = resolveOwnershipReviewOutcome({ status: "VERIFIED", method: "manual_review" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("OW-U14: unknown review status or method is rejected", () => {
    expect(resolveOwnershipReviewOutcome({ status: "PENDING" }).ok).toBe(false);
    expect(resolveOwnershipReviewOutcome({ status: "APPROVED" }).ok).toBe(false);
    expect(resolveOwnershipReviewOutcome({ status: "AVAILABLE", method: "auto" }).ok).toBe(false);
    expect(isOwnershipVerificationMethod("manual_review")).toBe(true);
    expect(isOwnershipVerificationMethod("government")).toBe(false);
  });
});
