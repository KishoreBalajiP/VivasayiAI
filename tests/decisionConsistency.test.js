import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-022 (plan A11, DC) — decision consistency: a claim built through the real API and decided by
// the real worker (drainDueJobs, never POST /verify) ends exactly where the pure engine says it must
// for the same factors (decide() in scripts/eval/fusion.eval.js, the spec-conformance benchmark),
// under policy v1.1-safe-ai, and its assessment records that policy's id and hash. The model is
// replaced (the photo reading of each scenario); satellite and weather are recorded by in-process
// fakes. Factors: inside the parcel, duplicate of the farmer's own verified claim, overlap with another
// farmer's claim, photos (supportive / no damage / uncertain / none), claimant rights, supporting
// satellite and weather evidence, and an over-limit area.
vi.hoisted(() => {
  process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED = "true";
  process.env.CLAIM_VERIFICATION_DRAIN_ON_READ = "false";
  process.env.CLAIM_VERIFICATION_POLICY = "v1.1-safe-ai";
  process.env.IMAGE_AI_MODE = "live";
});
const mocks = vi.hoisted(() => ({ generate: vi.fn(), getCollection: vi.fn(), embedQuery: vi.fn() }));
vi.mock("chromadb", () => ({ CloudClient: class { getCollection(...a) { return mocks.getCollection(...a); } } }));
vi.mock("@langchain/cohere", () => ({ CohereEmbeddings: class { embedQuery(...a) { return mocks.embedQuery(...a); } } }));
vi.mock("@langchain/google-genai", () => ({ ChatGoogleGenerativeAI: class { generate(...a) { return mocks.generate(...a); } } }));

import fs from "node:fs";
import path from "node:path";
import LossClaim from "../models/LossClaim.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { ensureDefaultExecutors, setExecutor } from "../services/verificationJobs.service.js";
import { drainDueJobs } from "../services/verificationWorker.service.js";
import { recordEvidenceRun } from "../services/verificationEvidence.service.js";
import { evaluateClaimVerification } from "../services/claimVerificationEngine.service.js";
import { resolveComponents } from "../services/verificationComponents.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { decide, NOW as FUSION_NOW } from "../scripts/eval/fusion.eval.js";
import { adminHeader, api, authHeader, squareGeometry, startTestDatabase, stopTestDatabase } from "./helpers.js";
import { OBSERVATIONS, attachDocument, createClaim, fakeSupportingExecutors, modelAnswer, resetDatabase, seedFarmer, submitClaim, uploadPhoto } from "./fixtures/claimFlow.js";

const POLICY = resolvePolicy("v1.1-safe-ai");
// The hermetic e2e scenarios (scripts/e2e/scenarios.json, ADR-024). An entry naming a DC test (`dc`)
// claims the same factors as that test, so its `expected.outcome` is pinned here to the pure engine:
// the Playwright suite (E2E-25) and checkScenarios.js then compare the UI and the API against values
// this suite has checked.
const SCENARIOS = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "scripts", "e2e", "scenarios.json"), "utf8"));
const DC_IDS = new Set(Array.from({ length: 13 }, (_, index) => `DC-${index + 1}`));
const expectScenariosPinned = (dcId, expected) => {
  const pinned = SCENARIOS.scenarios.filter((scenario) => scenario.dc === dcId);
  expect(pinned.length).toBeGreaterThan(0);
  for (const scenario of pinned) {
    expect({ scenario: scenario.id, outcome: scenario.expected.outcome }).toEqual({ scenario: scenario.id, outcome: expected.disposition === "hold" ? null : expected.outcome });
    expect({ scenario: scenario.id, held: Boolean(scenario.expected.held) }).toEqual({ scenario: scenario.id, held: expected.disposition === "hold" });
  }
};
const PHOTO_ANSWER = { supportive: OBSERVATIONS.damage, no_damage: OBSERVATIONS.no_damage, uncertain: OBSERVATIONS.uncertain };
const RIGHTS = {
  none: { relationship: undefined, documents: [] },
  owner_accepted: { relationship: "owner", documents: [["ownership_deed", "AVAILABLE"]] },
  tenant_wrong_docs: { relationship: "tenant", documents: [["ownership_deed", "AVAILABLE"]] },
};

// The worker, batch after batch, on a fake clock (a minute per batch) until no job is left to run.
const runWorker = async () => {
  let clock = Date.now();
  for (let i = 0; i < 60; i += 1) {
    await drainDueJobs({ deadline: clock + 60_000, now: () => new Date(clock), maxJobs: 25 });
    if ((await VerificationJob.countDocuments({ status: { $in: ["queued", "running"] } })) === 0) return;
    clock += 60_000;
  }
  throw new Error("the worker did not settle");
};

// Build the scenario through the API, run the worker, and return what was persisted.
const runScenario = async (label, { inside = true, duplicate = false, cross = false, photos = "supportive", rights = "none", area = "normal" }) => {
  const farmer = await seedFarmer(label);
  if (duplicate) {
    // The farmer's own earlier claim over the same land, already verified.
    const earlier = await createClaim(farmer, { eventDaysAgo: 5 });
    await uploadPhoto(farmer.user, earlier);
    await submitClaim(farmer.user, earlier);
    mocks.generate.mockResolvedValue(modelAnswer(OBSERVATIONS.damage));
    await runWorker();
    expect((await LossClaim.findById(earlier).lean()).state).toBe("verified");
  }
  if (cross) {
    // Another farmer's claim (still being decided) over the same land.
    const neighbour = await seedFarmer(`${label}-neighbour`);
    const theirs = await createClaim(neighbour);
    await submitClaim(neighbour.user, theirs);
    await VerificationJob.updateMany({ claimId: theirs }, { $set: { status: "succeeded" }, $unset: { activeKey: "" } });
  }
  const geometry = area === "over_limit" ? squareGeometry(0.0096) : inside ? squareGeometry(0.009) : squareGeometry(0.009, [0.5, 0.5]);
  const claimId = await createClaim(farmer, { geometry, relationship: RIGHTS[rights].relationship });
  if (photos !== "none") await uploadPhoto(farmer.user, claimId);
  const documents = [];
  for (const [category] of RIGHTS[rights].documents) documents.push(await attachDocument(farmer.user, claimId, category));
  await submitClaim(farmer.user, claimId);
  for (const [index, [, status]] of RIGHTS[rights].documents.entries()) {
    const reviewed = await api().post(`/admin/claims/${claimId}/ownership/${documents[index]}/review`).set(adminHeader("dc-admin")).send({ status, reason: "Reviewed the document by hand" });
    expect(reviewed.status).toBe(200);
  }
  if (photos !== "none") mocks.generate.mockResolvedValue(modelAnswer(PHOTO_ANSWER[photos]));
  await runWorker();
  const [claim, assessment, progress] = await Promise.all([
    LossClaim.findById(claimId).lean(),
    ClaimAssessment.findOne({ claimId }).lean(),
    api().get(`/claims/${claimId}/progress`).set(authHeader(farmer.user)),
  ]);
  return { claimId, user: farmer.user, claim, assessment, progress: progress.body.data.progress };
};

// The persisted result must be the pure engine's, and recorded under v1.1's id and hash.
const expectMatchesEngine = (result, expected) => {
  expect(result.assessment.policy).toEqual({ id: POLICY.id, hash: POLICY.hash });
  if (expected.disposition === "hold") {
    expect(result.claim.state).toBe("submitted");
    expect(result.assessment.state).toBeNull();
    expect(result.assessment.verification.status).toBe("held");
    expect(result.progress).toMatchObject({ overallStatus: "waiting_for_review", decision: null });
  } else {
    expect(result.claim.state).toBe(expected.outcome);
    expect(result.assessment.state).toBe(expected.outcome);
    expect(result.assessment.verification.status).toBe("completed");
    expect(result.progress.decision).toBe(expected.outcome);
    expect(result.progress.overallStatus).toBe(expected.outcome === "more_evidence_required" ? "action_required" : "decided");
  }
};
const factors = (over = {}) => ({ policy: POLICY, inside: true, duplicate: false, cross: false, photos: "supportive", rights: "none", ...over });

describe("API + worker decisions equal the pure engine under v1.1-safe-ai (DC)", () => {
  let mongo;
  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    await ensureDefaultExecutors();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
    fakeSupportingExecutors();
    setExecutor("land_documents", async () => ({ fake: "land_documents" }));
    setExecutor("official_land_record", async () => ({ fake: "official_land_record" }));
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(modelAnswer(OBSERVATIONS.damage));
  });

  it("DC-1: supportive photos, inside the parcel: verified by the worker alone (no verify call)", async () => {
    const expected = decide(factors());
    expect(expected.outcome).toBe("verified");
    expectScenariosPinned("DC-1", expected);
    const result = await runScenario("dc1", {});
    expectMatchesEngine(result, expected);
    expect(await ClaimAudit.countDocuments({ claimId: result.claimId, action: "verified" })).toBe(1);
  });

  it("DC-2: an AI-only 'no damage' reading is held for a reviewer with one review case — never rejected", async () => {
    const expected = decide(factors({ photos: "no_damage" }));
    expect(expected).toMatchObject({ outcome: null, disposition: "hold" });
    expectScenariosPinned("DC-2", expected);
    const result = await runScenario("dc2", { photos: "no_damage" });
    expectMatchesEngine(result, expected);
    const cases = await VerificationEvidence.find({ claimId: result.claimId, "metadata.kind": "review_case" }).lean();
    expect(cases.map((row) => [row.source, row.result.reviewReasons])).toEqual([["AI_IMAGE", ["ai_no_damage_needs_review"]]]);
    expect(result.progress.stages.find((stage) => stage.id === "decision").explanationKey).toBe("progress.decision.ai_no_damage_review");
  });

  it("DC-3: uncertain photos ask for more evidence", async () => {
    const expected = decide(factors({ photos: "uncertain" }));
    expect(expected.outcome).toBe("more_evidence_required");
    expectMatchesEngine(await runScenario("dc3", { photos: "uncertain" }), expected);
  });

  it("DC-4: a tenant without the right documents follows the spec: v1.1 keeps claimant rights optional, so the claim is verified", async () => {
    const expected = decide(factors({ rights: "tenant_wrong_docs" }));
    expect(expected.outcome).toBe("verified");
    // S10 is the tenant without documents; claimant rights are optional under v1.1 either way.
    expectScenariosPinned("DC-4", expected);
    const result = await runScenario("dc4", { rights: "tenant_wrong_docs" });
    expectMatchesEngine(result, expected);
    expect(result.assessment.components.claimant_rights).toMatchObject({ outcome: "unverified", required: false });
  });

  it("DC-5: an area beyond the parcel limit is out_of_limit through the worker, as the pure engine decides for the same facts", async () => {
    const result = await runScenario("dc5", { area: "over_limit" });
    // The pure engine on the stored facts: claimed area over parcel area x (1 + overage).
    const facts = result.claim;
    expect(facts.claimedAreaAcres).toBeGreaterThan(facts.parcelSnapshot.parcelAreaAcres * 1.05);
    const engine = evaluateClaimVerification({
      claim: facts,
      assessment: result.assessment,
      overlap: { status: "unchecked", overlapAreaAcres: 0 },
      evidenceCount: 1,
      now: new Date(),
      components: resolveComponents({ claim: facts, assessment: result.assessment, evidenceCount: 1, policy: POLICY }),
      policy: POLICY,
    });
    expect(engine.outcome).toBe("out_of_limit");
    expectMatchesEngine(result, { outcome: engine.outcome, disposition: engine.disposition });
    expectScenariosPinned("DC-5", { outcome: engine.outcome, disposition: engine.disposition });
  });

  it("DC-6: overlap with another farmer's claim is decided as the spec says (verified under v1.1) and flagged for admins only", async () => {
    const expected = decide(factors({ cross: true }));
    expect(expected.outcome).toBe("verified");
    expectScenariosPinned("DC-6", expected);
    for (const scenario of SCENARIOS.scenarios.filter((entry) => entry.dc === "DC-6")) expect(scenario.expected.audits).toEqual({ cross_farmer_overlap_flagged: 1 });
    const result = await runScenario("dc6", { cross: true });
    expectMatchesEngine(result, expected);
    expect(await ClaimAudit.countDocuments({ claimId: result.claimId, action: "cross_farmer_overlap_flagged" })).toBe(1);
  });

  it("DC-7: a claim outside the registered parcel is rejected", async () => {
    const expected = decide(factors({ inside: false }));
    expect(expected.outcome).toBe("rejected");
    expectMatchesEngine(await runScenario("dc7", { inside: false }), expected);
  });

  it("DC-8: outside the parcel AND an AI 'no damage' reading is still rejected (the rejection is not the AI's), not held", async () => {
    const expected = decide(factors({ inside: false, photos: "no_damage" }));
    expect(expected).toMatchObject({ outcome: "rejected", disposition: "decide" });
    const result = await runScenario("dc8", { inside: false, photos: "no_damage" });
    expectMatchesEngine(result, expected);
    expect(await VerificationEvidence.countDocuments({ claimId: result.claimId, "metadata.kind": "review_case" })).toBe(0);
  });

  it("DC-9: a claim duplicating the farmer's own verified claim is duplicate_area", async () => {
    const expected = decide(factors({ duplicate: true }));
    expect(expected.outcome).toBe("duplicate_area");
    expectMatchesEngine(await runScenario("dc9", { duplicate: true }), expected);
  });

  it("DC-10: no photos at all asks for more evidence (no model call)", async () => {
    const expected = decide(factors({ photos: "none" }));
    expect(expected.outcome).toBe("more_evidence_required");
    expectScenariosPinned("DC-10", expected);
    expectMatchesEngine(await runScenario("dc10", { photos: "none" }), expected);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("DC-11: an owner with a reviewer-accepted deed is verified, the claimant-rights component recorded as verified (not authoritative)", async () => {
    const expected = decide(factors({ rights: "owner_accepted" }));
    expect(expected.outcome).toBe("verified");
    const result = await runScenario("dc11", { rights: "owner_accepted" });
    expectMatchesEngine(result, expected);
    expect(result.assessment.components.claimant_rights).toMatchObject({ outcome: "verified", authoritative: false });
  });

  it("DC-12: satellite support and missing weather change nothing: the same decision as without them", async () => {
    const expected = decide(factors({ satellite: "supports", weather: "unavailable" }));
    expect(expected.outcome).toBe(decide(factors()).outcome);
    // S13 (satellite supports the loss) and S16 (weather unavailable): the same decision as S01.
    expectScenariosPinned("DC-12", expected);
    // Supporting evidence as the fusion scenario has it: an analysis supporting the loss, no rainfall.
    setExecutor("satellite", async (job) => {
      await recordEvidenceRun({
        claimId: job.claimId, cognitoSub: job.cognitoSub, component: "satellite", keyPrefix: "sat2", inputFingerprint: `sat-${String(job.claimId)}`,
        source: "SATELLITE", status: "AVAILABLE", metadata: { outcome: "ANALYSIS_COMPLETE", processingStatus: "executed", analysisExecuted: true },
        result: { analyzed: true, analysisOutcome: "SUPPORTS_LOSS", deltaNdvi: -0.3 },
      });
      return { recorded: true };
    });
    setExecutor("weather", async (job) => {
      await recordEvidenceRun({
        claimId: job.claimId, cognitoSub: job.cognitoSub, component: "weather", keyPrefix: "wx", inputFingerprint: `wx-${String(job.claimId)}`,
        source: "WEATHER", status: "UNAVAILABLE", metadata: { reason: "archive_unavailable" }, result: { reason: "archive_unavailable" },
      });
      return { status: "UNAVAILABLE" };
    });
    const result = await runScenario("dc12", {});
    expectMatchesEngine(result, expected);
    expect(result.assessment.components.satellite.outcome).toBe("verified");
    expect(result.assessment.components.weather.outcome).toBe("unavailable");
    expect(result.progress.satellite).toMatchObject({ status: "passed", supportingOnly: true });
    // The fusion benchmark's clock is fixed; the API runs on today's. The event is 2 days before both.
    expect(FUSION_NOW).toBeInstanceOf(Date);
  });
  it("DC-13: scripts/e2e/scenarios.json is consistent: every `dc` names a DC test, every decided scenario names a decision, every held one none, and satellite never changes an outcome", () => {
    expect(SCENARIOS.policy).toBe(POLICY.id);
    const decisions = new Set(["verified", "partially_verified", "rejected", "duplicate_area", "out_of_limit", "more_evidence_required"]);
    const ids = SCENARIOS.scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["S00", "S01", "S06", "S06b", "S07", "S08a", "S08b", "S08c", "S09", "S10", "S11", "S12", "S13", "S13b", "S14", "S15", "S16"]));
    for (const scenario of SCENARIOS.scenarios) {
      if (scenario.dc) expect({ id: scenario.id, dc: DC_IDS.has(scenario.dc) }).toEqual({ id: scenario.id, dc: true });
      if (scenario.settle === "decided") {
        expect({ id: scenario.id, decision: decisions.has(scenario.expected.outcome) }).toEqual({ id: scenario.id, decision: true });
        expect(scenario.expected.decision).toBe(scenario.expected.outcome);
      } else {
        expect({ id: scenario.id, settle: scenario.settle, outcome: scenario.expected.outcome, held: scenario.expected.held }).toEqual({ id: scenario.id, settle: scenario.settle, outcome: null, held: true });
      }
    }
    // D1: a satellite-only change of setup never changes the expected outcome.
    const base = SCENARIOS.scenarios.find((scenario) => scenario.id === "S01").expected.outcome;
    for (const id of ["S13", "S13b", "S14", "S14b", "S15"]) expect({ id, outcome: SCENARIOS.scenarios.find((scenario) => scenario.id === id).expected.outcome }).toEqual({ id, outcome: base });
    // Critique E1: the satellite-pending case is an event today, in UTC.
    expect(SCENARIOS.scenarios.find((scenario) => scenario.id === "S13b").claim.eventDaysAgo).toBe(0);
    // The hold cases are what the pure engine says for an AI-only "no damage" reading (DC-2) or a technical failure.
    expect(decide(factors({ photos: "no_damage", satellite: "supports" }))).toMatchObject({ outcome: null, disposition: "hold" });
  });
});
