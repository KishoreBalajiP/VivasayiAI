import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import * as service from "../services/verificationEvidence.service.js";
import { evaluateClaimVerification } from "../services/claimVerificationEngine.service.js";
import { EVIDENCE_SOURCES, EVIDENCE_STATUSES } from "../utils/verificationEvidence.js";
import { startTestDatabase, stopTestDatabase } from "./helpers.js";

// Phase 11 (E11-S11) — Mongo-backed service behaviours for the Verification Evidence Foundation:
// ownership scoping, validation at the persistence boundary, append-only audit, claim-scoped
// idempotency, backward compatibility for legacy claims, and proof that non-operative sources
// (OWNERSHIP / SATELLITE) cannot change any deterministic decision.

const square = (size = 0.009, origin = [77, 11]) => ({
  type: "Polygon",
  coordinates: [
    [
      [origin[0], origin[1]],
      [origin[0] + size, origin[1]],
      [origin[0] + size, origin[1] + size],
      [origin[0], origin[1] + size],
      [origin[0], origin[1]],
    ],
  ],
});

const seedClaim = async (cognitoSub, overrides = {}) =>
  LossClaim.create({
    cognitoSub,
    profileId: new mongoose.Types.ObjectId(),
    parcelId: "par_test",
    parcelSnapshot: { parcelId: "par_test", name: "Field", crop: "Rice", parcelAreaAcres: 1.0 },
    eventType: "flood",
    eventDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    claimedGeometry: square(),
    claimedAreaAcres: 0.5,
    evidence: [],
    state: "submitted",
    ...overrides,
  });

const engineInput = (claim) => ({
  claim: { ...claim.toObject(), eventDate: new Date("2026-02-28T00:00:00.000Z") },
  assessment: {
    status: "completed",
    aiAggregate: {
      damageDetected: true,
      damageType: "flood",
      severity: "moderate",
      confidence: "high",
      uncertain: false,
      inconsistencies: [],
      imageCount: 1,
    },
    aiImageAssessments: [
      {
        observation: {
          damageDetected: true,
          damageType: "flood",
          severity: "moderate",
          confidence: "high",
          imageQuality: "good",
        },
      },
    ],
  },
  overlap: { status: "none", overlapAreaAcres: 0 },
  evidenceCount: 1,
  now: new Date("2026-03-01T00:00:00.000Z"),
});

describe("Phase 11 — verification evidence service", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase(mongo);
  });

  beforeEach(async () => {
    await Promise.all([
      LossClaim.deleteMany({}),
      ClaimEvidence.deleteMany({}),
      ClaimAssessment.deleteMany({}),
      ClaimAudit.deleteMany({}),
      VerificationEvidence.deleteMany({}),
    ]);
  });

  it("P11-01: accepts every supported evidence source", async () => {
    const claim = await seedClaim("sub-sources");
    const seen = [];
    for (const source of EVIDENCE_SOURCES) {
      const { evidence, idempotent } = await service.recordVerificationEvidence({
        claimId: claim._id,
        cognitoSub: "sub-sources",
        source,
      });
      expect(evidence.source).toBe(source);
      expect(evidence.status).toBe("NOT_CHECKED");
      expect(evidence.operative).toBe(["GEOMETRY", "AI_IMAGE", "WEATHER"].includes(source));
      expect(idempotent).toBe(false);
      seen.push(evidence.source);
    }
    expect(seen).toEqual(EVIDENCE_SOURCES);
    expect(await VerificationEvidence.countDocuments({ claimId: claim._id })).toBe(EVIDENCE_SOURCES.length);
  });

  it("P11-02: rejects an invalid evidence source (400)", async () => {
    const claim = await seedClaim("sub-badsrc");
    await expect(
      service.recordVerificationEvidence({ claimId: claim._id, cognitoSub: "sub-badsrc", source: "TELEPATHY" })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await VerificationEvidence.countDocuments({})).toBe(0);
  });

  it("P11-03/04: accepts every valid status and rejects an invalid one", async () => {
    const claim = await seedClaim("sub-status");
    for (const status of EVIDENCE_STATUSES) {
      const { evidence } = await service.recordVerificationEvidence({
        claimId: claim._id,
        cognitoSub: "sub-status",
        source: "WEATHER",
        status,
      });
      expect(evidence.status).toBe(status);
    }
    await expect(
      service.recordVerificationEvidence({
        claimId: claim._id,
        cognitoSub: "sub-status",
        source: "WEATHER",
        status: "approved",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("P11-05: recorded evidence belongs to the correct claim", async () => {
    const claimA = await seedClaim("sub-a");
    const claimB = await seedClaim("sub-b");
    await service.recordVerificationEvidence({ claimId: claimA._id, cognitoSub: "sub-a", source: "GEOMETRY" });
    const listA = await service.listVerificationEvidenceForClaim({ claimId: claimA._id, cognitoSub: "sub-a" });
    const listB = await service.listVerificationEvidenceForClaim({ claimId: claimB._id, cognitoSub: "sub-b" });
    expect(listA).toHaveLength(1);
    expect(listA[0].claimId).toBe(String(claimA._id));
    expect(listB).toHaveLength(0);
  });

  it("P11-06: ownership scoping is preserved for record/list/view/update (404)", async () => {
    const claim = await seedClaim("sub-owner");
    await expect(
      service.recordVerificationEvidence({ claimId: claim._id, cognitoSub: "sub-intruder", source: "GEOMETRY" })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.listVerificationEvidenceForClaim({ claimId: claim._id, cognitoSub: "sub-intruder" })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.getVerificationEvidenceView({ claimId: claim._id, cognitoSub: "sub-intruder" })
    ).rejects.toMatchObject({ statusCode: 404 });

    const { evidence } = await service.recordVerificationEvidence({
      claimId: claim._id,
      cognitoSub: "sub-owner",
      source: "AI_IMAGE",
    });
    await expect(
      service.updateVerificationEvidenceStatus({
        evidenceId: evidence.id,
        cognitoSub: "sub-intruder",
        status: "VERIFIED",
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    // The owner's row is untouched by the rejected foreign update.
    const stored = await VerificationEvidence.findById(evidence.id);
    expect(stored.status).toBe("NOT_CHECKED");
  });

  it("P11-07: metadata validation runs at the persistence boundary", async () => {
    const claim = await seedClaim("sub-meta");
    await expect(
      service.recordVerificationEvidence({
        claimId: claim._id,
        cognitoSub: "sub-meta",
        source: "WEATHER",
        metadata: { s3Key: "claims/evil.png" },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.recordVerificationEvidence({
        claimId: claim._id,
        cognitoSub: "sub-meta",
        source: "WEATHER",
        metadata: { blob: "x".repeat(6000) },
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const { evidence } = await service.recordVerificationEvidence({
      claimId: claim._id,
      cognitoSub: "sub-meta",
      source: "WEATHER",
      metadata: { precipitationMm: 22, weatherCode: 65 },
    });
    expect(evidence.metadata).toEqual({ precipitationMm: 22, weatherCode: 65 });
  });

  it("P11-08: provider/version metadata is representable and round-trips", async () => {
    const claim = await seedClaim("sub-version");
    const observedAt = new Date("2026-02-02T08:30:00.000Z");
    const { evidence } = await service.recordVerificationEvidence({
      claimId: claim._id,
      cognitoSub: "sub-version",
      source: "SATELLITE",
      status: "AVAILABLE",
      confidence: 0.66,
      observedAt,
      provider: "example-provider",
      providerVersion: "2.1.0",
      evidenceVersion: "ev-2026-02",
      evaluationVersion: "foundation-1",
      reference: "scene_ref_1",
    });
    const reloaded = (await service.listVerificationEvidenceForClaim({ claimId: claim._id, cognitoSub: "sub-version" }))[0];
    expect(reloaded.provider).toBe("example-provider");
    expect(reloaded.providerVersion).toBe("2.1.0");
    expect(reloaded.evidenceVersion).toBe("ev-2026-02");
    expect(reloaded.evaluationVersion).toBe("foundation-1");
    expect(reloaded.confidence).toBe(0.66);
    expect(new Date(reloaded.observedAt).toISOString()).toBe(observedAt.toISOString());
    expect(evidence.operative).toBe(false);
  });

  it("P11-09: every change is auditable via the append-only ClaimAudit trail", async () => {
    const claim = await seedClaim("sub-audit");
    const { evidence } = await service.recordVerificationEvidence({
      claimId: claim._id,
      cognitoSub: "sub-audit",
      source: "AI_IMAGE",
      requestId: "req-1",
    });
    await service.updateVerificationEvidenceStatus({
      evidenceId: evidence.id,
      cognitoSub: "sub-audit",
      status: "VERIFIED",
      result: { consistent: true },
      requestId: "req-2",
    });

    const rows = await ClaimAudit.find({ claimId: claim._id }).sort({ createdAt: 1 });
    const recorded = rows.find((r) => r.action === "evidence_recorded");
    const updated = rows.find((r) => r.action === "evidence_status_updated");
    expect(recorded).toBeTruthy();
    expect(recorded.actor).toBe("engine");
    expect(recorded.metadata.source).toBe("AI_IMAGE");
    expect(recorded.metadata).not.toHaveProperty("s3Key");
    expect(recorded.requestId).toBe("req-1");
    expect(updated.metadata.fromStatus).toBe("NOT_CHECKED");
    expect(updated.metadata.toStatus).toBe("VERIFIED");
    expect(updated.requestId).toBe("req-2");
  });

  it("P11-10: existing claims without the foundation keep working (no migration)", async () => {
    const claim = await seedClaim("sub-legacy");
    expect(await service.claimHasVerificationEvidence(claim._id)).toBe(false);

    const view = await service.getVerificationEvidenceView({ claimId: claim._id, cognitoSub: "sub-legacy" });
    expect(view.persisted).toEqual([]);
    // The legacy claim still projects its existing GEOMETRY evidence — nothing was fabricated.
    expect(view.existing.map((r) => r.source)).toContain("GEOMETRY");
    expect(await service.listVerificationEvidenceForClaim({ claimId: claim._id, cognitoSub: "sub-legacy" })).toEqual([]);
    // The claim document itself is unchanged.
    const stored = await LossClaim.findById(claim._id);
    expect(stored.state).toBe("submitted");
    expect(stored.claimedAreaAcres).toBe(0.5);
  });

  it("P11-11/12/13: existing AI_IMAGE, WEATHER and GEOMETRY evidence are represented compatibly", async () => {
    const claim = await seedClaim("sub-existing");
    await ClaimEvidence.create({
      claimId: claim._id,
      uploadId: "img_11111111-1111-4111-8111-111111111111",
      s3Key: "claims/x/img/image.png",
      mediaType: "image/png",
      size: 100,
      width: 12,
      height: 12,
      status: "stored",
      uploadedAt: new Date(),
    });
    await ClaimAssessment.create({
      claimId: claim._id,
      status: "completed",
      model: "gemini/x",
      version: "1",
      evidenceVersion: "ev-1",
      aiImageAssessments: [
        {
          evidenceId: new mongoose.Types.ObjectId(),
          uploadId: "img_11111111-1111-4111-8111-111111111111",
          observation: { damageDetected: true, damageType: "flood", severity: "moderate", imageQuality: "good" },
        },
      ],
      weatherCorrelation: { eventMatch: true, precipitationMm: 30, weatherCode: 65, source: "open-meteo" },
    });

    const view = await service.getVerificationEvidenceView({ claimId: claim._id, cognitoSub: "sub-existing" });
    const bySource = Object.fromEntries(view.existing.map((r) => [r.source, r]));
    expect(bySource.GEOMETRY.status).toBe("AVAILABLE");
    expect(bySource.AI_IMAGE.reference).toBe("img_11111111-1111-4111-8111-111111111111");
    expect(bySource.AI_IMAGE.provider).toBe("gemini/x");
    expect(bySource.WEATHER.provider).toBe("open-meteo");
    expect(bySource.WEATHER.result.eventMatch).toBe(true);
    // The existing ClaimEvidence/ClaimAssessment rows were only READ — never mutated.
    expect((await ClaimEvidence.findById((await ClaimEvidence.findOne({}))._id)).status).toBe("stored");
  });

  it("P11-14/15: OWNERSHIP and SATELLITE evidence never change a claim decision", async () => {
    const claim = await seedClaim("sub-nono");
    const baseline = evaluateClaimVerification(engineInput(claim));

    await service.recordVerificationEvidence({ claimId: claim._id, cognitoSub: "sub-nono", source: "OWNERSHIP", status: "AVAILABLE" });
    await service.recordVerificationEvidence({ claimId: claim._id, cognitoSub: "sub-nono", source: "SATELLITE", status: "INCONSISTENT" });

    const after = evaluateClaimVerification(engineInput(claim));
    expect(after).toEqual(baseline);
    // And the foundation explicitly labels them non-operative.
    const persisted = await service.listVerificationEvidenceForClaim({ claimId: claim._id, cognitoSub: "sub-nono" });
    expect(persisted.every((row) => row.operative === false)).toBe(true);
  });

  it("P11-16: existing deterministic verification outcomes are unchanged (pure + repeatable)", async () => {
    const claim = await seedClaim("sub-reg");
    const first = evaluateClaimVerification(engineInput(claim));
    const second = evaluateClaimVerification(engineInput(claim));
    expect(first).toEqual(second);
    expect(first.outcome).toBe("verified");
    expect(first.approvedAreaAcres).toBe(0.5);
  });

  it("P11-17: duplicate evidence operations are idempotent (claim-scoped key)", async () => {
    const claim = await seedClaim("sub-idem");
    const args = {
      claimId: claim._id,
      cognitoSub: "sub-idem",
      source: "WEATHER",
      status: "AVAILABLE",
      idempotencyKey: "idem-key-0001",
    };
    const one = await service.recordVerificationEvidence(args);
    const two = await service.recordVerificationEvidence(args);
    expect(one.idempotent).toBe(false);
    expect(two.idempotent).toBe(true);
    expect(two.evidence.id).toBe(one.evidence.id);
    expect(await VerificationEvidence.countDocuments({ claimId: claim._id })).toBe(1);

    await service.recordVerificationEvidence({ ...args, idempotencyKey: "idem-key-0002" });
    expect(await VerificationEvidence.countDocuments({ claimId: claim._id })).toBe(2);
  });

  it("P11-18: unauthorized access is rejected", async () => {
    const claim = await seedClaim("sub-unauth");
    await expect(
      service.recordVerificationEvidence({ claimId: claim._id, source: "GEOMETRY" })
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      service.recordVerificationEvidence({ claimId: "not-an-id", cognitoSub: "sub-unauth", source: "GEOMETRY" })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
