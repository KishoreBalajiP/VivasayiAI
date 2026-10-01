import { describe, expect, it } from "vitest";
import {
  DECISION_STATES,
  evaluateOverrideTransition,
  overridesRequireApprover,
  approverIsValid,
} from "../services/adminOverrideRules.service.js";
import {
  QUEUE_STATES,
  normalizeQueueFilters,
  buildQueueClaimMatch,
  escapeRegExp,
  compareQueueRows,
  serializeQueueEntry,
  buildPostMatch,
} from "../services/adminQueue.service.js";
import {
  computeDashboardMetrics,
  isEmptyDashboard,
} from "../services/adminDashboard.service.js";
import {
  geometryFingerprint,
  buildInvestigationEntries,
  summarizeInvestigation,
} from "../services/adminInvestigation.service.js";
import { APPEAL_ELIGIBLE_STATES } from "../models/Appeal.js";

// Phase 10 (E9-S10) — pure logic suites: admin override rules, review-queue filters/orders,
// dashboard aggregation and fraud-investigation signals. No DB, no HTTP — deterministic only.
// The Mongo-backed admin flows (override persistence, appeal resolution, endpoint auth) live in
// tests/admin.api.test.js.

const DAY_MS = 24 * 60 * 60 * 1000;

describe("adminOverrideRules", () => {
  it("defines the six decision states as the single source of truth", () => {
    expect(DECISION_STATES).toEqual([
      "verified",
      "partially_verified",
      "rejected",
      "out_of_limit",
      "duplicate_area",
      "more_evidence_required",
    ]);
  });

  it("allows a legitimate override rejected → verified", () => {
    expect(evaluateOverrideTransition({ fromState: "rejected", toState: "verified" })).toEqual({
      ok: true,
      reason: null,
    });
  });

  it("rejects a non-decision override target (processing / draft)", () => {
    expect(evaluateOverrideTransition({ fromState: "rejected", toState: "processing" }).ok).toBe(false);
    expect(evaluateOverrideTransition({ fromState: "rejected", toState: "draft" }).ok).toBe(false);
  });

  it("rejects overrides FROM non-overrideable states (draft/submitted/withdrawn)", () => {
    expect(evaluateOverrideTransition({ fromState: "draft", toState: "verified" }).ok).toBe(false);
    expect(evaluateOverrideTransition({ fromState: "submitted", toState: "rejected" }).ok).toBe(false);
    expect(evaluateOverrideTransition({ fromState: "withdrawn", toState: "verified" }).ok).toBe(false);
  });

  it("rejects a no-op override (same state)", () => {
    const result = evaluateOverrideTransition({ fromState: "rejected", toState: "rejected" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/change the claim state/);
  });

  it("allows overrides from more_evidence_required and processing (AI-failure rescue)", () => {
    expect(evaluateOverrideTransition({ fromState: "more_evidence_required", toState: "verified" }).ok).toBe(true);
    expect(evaluateOverrideTransition({ fromState: "processing", toState: "rejected" }).ok).toBe(true);
  });

  it("overridesRequireApprover: disabled at threshold 0 and below", () => {
    expect(overridesRequireApprover({ overriddenAcres: 9999, threshold: 0 })).toBe(false);
    expect(overridesRequireApprover({ overriddenAcres: 9999, threshold: -3 })).toBe(false);
  });

  it("overridesRequireApprover: requires approval only above the threshold", () => {
    expect(overridesRequireApprover({ overriddenAcres: 10, threshold: 5 })).toBe(true);
    expect(overridesRequireApprover({ overriddenAcres: 2, threshold: 5 })).toBe(false);
    expect(overridesRequireApprover({ overriddenAcres: 5, threshold: 5 })).toBe(false);
  });

  it("overridesRequireApprover: non-finite acreage never triggers", () => {
    expect(overridesRequireApprover({ overriddenAcres: null, threshold: 5 })).toBe(false);
    expect(overridesRequireApprover({ overriddenAcres: "abc", threshold: 5 })).toBe(false);
  });

  it("approverIsValid: must be a distinct, non-empty admin identity", () => {
    expect(approverIsValid({ actorSub: "a", approverSub: "b" })).toBe(true);
    expect(approverIsValid({ actorSub: "a", approverSub: "a" })).toBe(false);
    expect(approverIsValid({ actorSub: "a", approverSub: null })).toBe(false);
    expect(approverIsValid({ actorSub: "a", approverSub: "  " })).toBe(false);
  });
});

describe("adminQueue — constants + normalization", () => {
  it("QUEUE_STATES are exactly the engine-review decision states", () => {
    expect(QUEUE_STATES).toEqual([
      "rejected",
      "out_of_limit",
      "duplicate_area",
      "more_evidence_required",
    ]);
  });

  it("normalizeQueueFilters applies safe defaults", () => {
    expect(normalizeQueueFilters({})).toEqual({
      status: null,
      eventType: null,
      search: null,
      withAppeal: null,
      aiFailed: null,
      page: 1,
      limit: 20,
    });
  });

  it("normalizeQueueFilters clamps page/limit and trims strings", () => {
    const filters = normalizeQueueFilters({
      page: "999999999",
      limit: "500",
      status: "  rejected  ",
      search: "   paddy   ",
    });
    expect(filters.page).toBe(10000);
    expect(filters.limit).toBe(100);
    expect(filters.status).toBe("rejected");
    expect(filters.search).toBe("paddy");
  });

  it("normalizeQueueFilters parses strict booleans only", () => {
    expect(normalizeQueueFilters({ withAppeal: "true", aiFailed: "false" })).toMatchObject({
      withAppeal: true,
      aiFailed: false,
    });
    expect(normalizeQueueFilters({ withAppeal: "yes", aiFailed: "1" })).toMatchObject({
      withAppeal: null,
      aiFailed: null,
    });
  });
});

describe("adminQueue — match construction", () => {
  it("buildQueueClaimMatch: empty filters mean no constraint", () => {
    expect(buildQueueClaimMatch(normalizeQueueFilters({}))).toEqual({});
  });

  it("buildQueueClaimMatch: status + eventType project to exact match", () => {
    expect(
      buildQueueClaimMatch(normalizeQueueFilters({ status: "rejected", eventType: "flood" }))
    ).toEqual({ state: "rejected", eventType: "flood" });
  });

  it("buildQueueClaimMatch: search is escaped and applied across display fields", () => {
    const match = buildQueueClaimMatch(normalizeQueueFilters({ search: "Rice (field) #1" }));
    expect(match.$or).toBeDefined();
    expect(match.$or).toHaveLength(5);
    for (const clause of match.$or) {
      const re = Object.values(clause)[0];
      expect(re instanceof RegExp).toBe(true);
    }
    // literal parens must not act as a regex group
    const first = Object.values(match.$or[0])[0];
    expect(String(first.source)).not.toContain("(field)");
  });

  it("escapeRegExp neutralizes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
    expect(escapeRegExp("[x]")).toBe("\\[x\\]");
  });
});

describe("adminQueue — post-match (queue membership)", () => {
  it("default queue includes engine-review states OR AI failures", () => {
    const match = buildPostMatch(normalizeQueueFilters({}));
    expect(match.$or[0]).toEqual({ state: { $in: QUEUE_STATES } });
    expect(match.$or[1]).toEqual({ $and: [{ aiFailed: true }] });
  });

  it("status filter narrows to a single state without the AI-failure leg by default", () => {
    const match = buildPostMatch(normalizeQueueFilters({ status: "rejected" }));
    expect(match.$or).toHaveLength(1);
    expect(match.$or[0]).toEqual({ state: "rejected" });
  });

  it("withAppeal=true adds the hasActiveAppeal flag", () => {
    const match = buildPostMatch(normalizeQueueFilters({ withAppeal: "true" }));
    expect(match.$and).toContainEqual({ hasActiveAppeal: true });
  });

  it("withAppeal=false excludes claims with an active appeal", () => {
    const match = buildPostMatch(normalizeQueueFilters({ withAppeal: "false" }));
    expect(match.$and).toContainEqual({ hasActiveAppeal: { $ne: true } });
  });

  it("aiFailed=true shows only AI-failed claims", () => {
    const match = buildPostMatch(normalizeQueueFilters({ aiFailed: "true" }));
    expect(match).toEqual({ $or: [{ $and: [{ aiFailed: true }] }] });
  });

  it("eventType + search compose into a single $and document", () => {
    const match = buildPostMatch(normalizeQueueFilters({ eventType: "flood", search: "paddy" }));
    expect(match.$and).toBeDefined();
    const shapes = match.$and.map((clause) => JSON.stringify(clause).slice(0, 40));
    expect(shapes).toContain('{"eventType":"flood"}');
    expect(shapes.some((s) => s.startsWith('{"$or":['))).toBe(true);
  });
});

describe("adminQueue — ordering + serialization", () => {
  it("compareQueueRows sorts decided claims most-recent-first", () => {
    const a = { decidedAt: daysIso(10), createdAt: daysIso(11) };
    const b = { decidedAt: daysIso(3), createdAt: daysIso(4) };
    const c = { decidedAt: null, createdAt: daysIso(1) };
    expect([a, b, c].sort(compareQueueRows).map((row) => row.decidedAt)).toEqual([
      b.decidedAt,
      a.decidedAt,
      null,
    ]);
  });

  it("compareQueueRows uses createdAt as a stable tiebreak", () => {
    // Every timestamp below is computed EXACTLY once and then compared by identity.
    // daysIso() reads Date.now() on every call, so calling it again inside the expectation
    // produces a string that can differ by 1ms from the one under test. Two separate
    // daysIso(5) calls could also differ by 1ms, which makes the primary decidedAt comparison
    // decide the order so the createdAt tiebreak is never reached. Both mistakes made this test
    // fail intermittently under load instead of testing what it claims to test.
    const decidedAt = daysIso(5);
    const olderCreatedAt = daysIso(9);
    const newerCreatedAt = daysIso(2);

    const a = { decidedAt, createdAt: olderCreatedAt };
    const b = { decidedAt, createdAt: newerCreatedAt };

    expect([a, b].sort(compareQueueRows).map((row) => row.createdAt)).toEqual([
      newerCreatedAt,
      olderCreatedAt,
    ]);
    // Equal decidedAt must fall through to the createdAt comparison, newest created first.
    expect(compareQueueRows(a, b)).toBeGreaterThan(0);
    expect(compareQueueRows(b, a)).toBeLessThan(0);
  });

  it("serializeQueueEntry maps a row to the safe API shape", () => {
    const row = {
      _id: "507f1f77bcf86cd799439011",
      parcelId: "par_00000000-0000-4000-8000-000000000001",
      parcelSnapshot: { name: "North field", crop: "Paddy", parcelAreaAcres: 1.25 },
      eventType: "flood",
      eventDate: daysIso(4),
      claimedAreaAcres: 0.8,
      state: "rejected",
      decidedAt: daysIso(2),
      submittedAt: daysIso(4),
      createdAt: daysIso(4),
      cognitoSub: "cognito-abc",
      profileId: "x",
      idempotencyKey: "idem-abc",
      assessment: { status: "completed", aiAggregate: { uncertain: true }, reason: "x", decidedBy: "engine" },
      appeal: { _id: "507f1f77bcf86cd799439022", status: "submitted", reason: "This is wrong" },
    };
    const entry = serializeQueueEntry(row);
    expect(entry.id).toBe(row._id);
    expect(entry.parcelName).toBe("North field");
    expect(entry.state).toBe("rejected");
    expect(entry.hasAppeal).toBe(true);
    expect(entry.appealStatus).toBe("submitted");
    expect(entry.assessment.aiUncertain).toBe(true);
    expect(entry.assessment.aiFailed).toBe(false);
    // sensitive internals never leak into the queue serialization
    expect(JSON.stringify(entry)).not.toMatch(/cognitoSub|profileId|idempotencyKey|s3Key/);
  });

  it("serializeQueueEntry handles a row without appeal/assessment", () => {
    const entry = serializeQueueEntry({ _id: "507f1f77bcf86cd799439033", state: "out_of_limit" });
    expect(entry.hasAppeal).toBe(false);
    expect(entry.assessment).toBeNull();
    expect(entry.appealId).toBeNull();
  });
});

describe("adminDashboard — pure aggregation", () => {
  it("computes zeros on an empty feed and reports empty", () => {
    const metrics = computeDashboardMetrics({});
    expect(metrics.total).toBe(0);
    expect(metrics.verified).toBe(0);
    expect(metrics.pendingHumanReview).toBe(0);
    expect(metrics.averageVerificationTimeMs).toBeNull();
    expect(metrics.aiUncertaintyRate).toBeNull();
    expect(isEmptyDashboard(metrics)).toBe(true);
  });

  it("counts decided claims by state (only decided rows are totals)", () => {
    const claims = [
      decided("verified", 3),
      decided("partially_verified", 4),
      decided("rejected", 5),
      decided("out_of_limit", 6),
      decided("duplicate_area", 7),
      decided("more_evidence_required", 8),
      { state: "draft" }, // undecided — never counts toward total
    ];
    const metrics = computeDashboardMetrics({ claims });
    expect(metrics.total).toBe(6);
    expect(metrics.verified).toBe(1);
    expect(metrics.partial).toBe(1);
    expect(metrics.rejected).toBe(1);
    expect(metrics.outOfLimit).toBe(1);
    expect(metrics.duplicate).toBe(1);
    expect(metrics.moreEvidence).toBe(1);
  });

  it("averages verification latency from submittedAt → decidedAt", () => {
    const claims = [
      { state: "verified", submittedAt: daysIso(10), decidedAt: daysIso(8) }, // 2 days
      { state: "rejected", submittedAt: daysIso(10), decidedAt: daysIso(4) }, // 6 days
    ];
    expect(computeDashboardMetrics({ claims }).averageVerificationTimeMs).toBe(4 * DAY_MS);
  });

  it("computes the AI uncertainty rate only over AI-assessed claims", () => {
    const claims = [
      decided("verified", 1, { aiAggregate: { uncertain: true } }),
      decided("verified", 2, { aiAggregate: { uncertain: false } }),
      decided("rejected", 3, {}), // no AI aggregate → excluded from the denominator
    ];
    expect(computeDashboardMetrics({ claims }).aiUncertaintyRate).toBe(0.5);
  });

  it("counts claims with stuck assessment pipelines as AI failures", () => {
    const claims = [
      decided("rejected", 1, { status: "failed" }),
      decided("rejected", 2, { verification: { status: "failed" } }),
      decided("verified", 3, {}),
    ];
    expect(computeDashboardMetrics({ claims }).aiFailedCount).toBe(2);
  });

  it("counts appeals and pending human review", () => {
    const claims = [
      decided("rejected", 1),
      decided("verified", 2),
      { state: "processing", assessment: { status: "failed" } },
      decided("more_evidence_required", 3, {}, { appeal: {} }),
    ];
    const metrics = computeDashboardMetrics({ claims, appeals: [1, 2, 3] });
    expect(metrics.appealCount).toBe(3);
    expect(metrics.pendingHumanReview).toBe(3); // rejected + ai-failed + more_evidence_required w/ appeal
  });
});

describe("adminInvestigation — observation signals", () => {
  it("geometryFingerprint rounds coordinates and sorts edges", () => {
    const geometry = { type: "Polygon", coordinates: [[[0.00001, 0], [0.009999, 0], [0.00999, 0.00999], [0.00001, 0]]] };
    const fp = geometryFingerprint(geometry);
    expect(fp).toBeTruthy();
    expect(fp).not.toContain("0.00001,");
  });

  it("flags a farmer with N rapid successive claims", () => {
    const farmer = rowsFor("rapid", 5, { parcelId: "par_1", state: "submitted" });
    const entries = buildInvestigationEntries(farmer);
    expect(entryFor(entries, "rapid").flags.some((f) => f.code === "rapid_succession")).toBe(true);
  });

  it("flags repeated parcel reuse across claims", () => {
    const farmer = rowsFor("reuse", 2, { parcelId: "par_same", state: "rejected" });
    const entries = buildInvestigationEntries(farmer);
    expect(entryFor(entries, "reuse").flags.some((f) => f.code === "parcel_reuse")).toBe(true);
  });

  it("flags repeated rejections (high severity)", () => {
    const farmer = rowsFor("rej", 2, { parcelId: "p1", state: "rejected" }).map((row) => ({ ...row, parcelId: "p1" }));
    const entries = buildInvestigationEntries(farmer);
    const flags = entryFor(entries, "rej").flags;
    expect(flags.some((f) => f.code === "repeated_rejection")).toBe(true);
    expect(flags.find((f) => f.code === "repeated_rejection").severity).toBe("high");
  });

  it("does NOT flag a single benign claim", () => {
    const entries = buildInvestigationEntries(rowsFor("benign", 1, { parcelId: "p1", state: "verified" }));
    expect(entryFor(entries, "benign").flags).toHaveLength(0);
  });

  it("detects near-identical polygons drawn by two different farmers (geometry twin)", () => {
    // 0.001 vs 0.00103 round to the same 4-decimal fingerprint (>= the default 11m tolerance).
    const a = { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", ownerKey: "farmer-a", claimedGeometry: square(0.001, [0, 0]) };
    const b = { _id: "bbbbbbbbbbbbbbbbbbbbbbbb", ownerKey: "farmer-b", claimedGeometry: square(0.00103, [0, 0]) };
    const entries = buildInvestigationEntries([a, b]);
    expect(entries.some((entry) => entry.flags.some((f) => f.code === "geometry_twin"))).toBe(true);
  });

  it("sorts investigation entries worst-severity first", () => {
    const high = { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", ownerKey: "h", state: "rejected", parcelId: "p" };
    const low = { _id: "bbbbbbbbbbbbbbbbbbbbbbbb", ownerKey: "l", state: "verified" };
    const twin = { _id: "cccccccccccccccccccccccc", ownerKey: "h", state: "rejected", parcelId: "p" };
    const entries = buildInvestigationEntries([low, high, twin]);
    expect(entries[0].flags[0].severity).toBe("high");
    expect(entries[0].flags.some((f) => f.code === "repeated_rejection")).toBe(true);
  });

  it("summarizeInvestigation tallies entries by severity", () => {
    const entries = buildInvestigationEntries([
      { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", ownerKey: "h", state: "rejected", parcelId: "p" },
      { _id: "cccccccccccccccccccccccc", ownerKey: "h", state: "rejected", parcelId: "p" },
      { _id: "bbbbbbbbbbbbbbbbbbbbbbbb", ownerKey: "l", state: "verified" },
    ]);
    const summary = summarizeInvestigation(entries);
    expect(summary.totalEntries).toBe(2);
    expect(summary.high).toBe(1);
  });
});

describe("appeal — eligible engine decisions", () => {
  it("exposes the four appeal-eligible engine decisions", () => {
    expect(APPEAL_ELIGIBLE_STATES).toEqual([
      "rejected",
      "out_of_limit",
      "duplicate_area",
      "more_evidence_required",
    ]);
  });
});

// ---- helpers ----
function daysIso(daysAgo) {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString();
}

function decided(state, seq, assessment = {}, extra = {}) {
  return {
    state,
    submittedAt: daysIso(3),
    decidedAt: daysIso(2),
    assessment: { status: "completed", ...assessment },
    ...extra,
  };
}

function rowsFor(name, count, overrides = {}) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    _id: `00000000000000000000000${name}`.slice(0, 24).padEnd(24, String(i)),
    ownerKey: `${name}-owner`,
    farmerEmail: `${name}@example.com`,
    parcelId: overrides.parcelId ?? `par_${name}_${i}`,
    eventType: overrides.eventType ?? "flood",
    state: overrides.state ?? "submitted",
    createdAt: new Date(now - i * 2 * 24 * 60 * 60 * 1000),
    claimedGeometry: square(0.001, [i * 0.01, 0]),
    assessment: overrides.assessment ?? null,
  }));
}

function entryFor(entries, name) {
  return entries.find((entry) => entry.farmerEmail === `${name}@example.com`);
}

function square(size, origin) {
  const [lon, lat] = origin;
  return {
    type: "Polygon",
    coordinates: [
      [
        [lon, lat],
        [lon + size, lat],
        [lon + size, lat + size],
        [lon, lat + size],
        [lon, lat],
      ],
    ],
  };
}