import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTION_CODES,
  FORBIDDEN_FARMER_KEYS,
  OVERALL_STATUSES,
  SATELLITE_STATUSES,
  STAGE_IDS,
  STAGE_STATUSES,
  buildFarmerProgress,
  parseCategoryGroups,
  progressContractDocument,
} from "../services/claimProgress.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { buildClaimWindows } from "../services/satelliteVerification.service.js";
import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  NOW,
  PROGRESS_SCENARIOS,
  buildAllScenarioProgress,
  contractDocument,
  exampleDocument,
} from "./fixtures/progressScenarios.js";

// ADR-022 (plan A6, critique A2) — the progress-v1 vocabulary is ONE machine-readable file,
// docs/architecture/progress-contract-v1.json, generated from services/claimProgress.js. The frontend
// copies it and translates exactly these values. These tests keep the file, the builder and the
// frontend example fixture (docs/architecture/progress-v1.example.json) in lock-step.
// Regenerate both files with: VIVASAYI_SKIP_DOTENV=1 node tests/fixtures/progressScenarios.js --write

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// Every key path of a value, for the "never in the farmer model" checks.
const keysOf = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, out));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      keysOf(inner, out);
    }
  }
  return out;
};

describe("progress-v1 contract file (PRG-10)", () => {
  it("PRG-10: the builder emits exactly the vocabulary in docs/architecture/progress-contract-v1.json, and the file is current", async () => {
    const file = readJson(CONTRACT_PATH);
    expect(file).toEqual(progressContractDocument());
    expect(file).toEqual(await contractDocument());

    const all = await buildAllScenarioProgress();
    const stageTriples = new Set();
    const satellitePairs = new Set();
    const overall = new Set();
    const actions = new Set();
    const notes = new Set();
    for (const progress of Object.values(all)) {
      expect(progress.contractVersion).toBe(file.contractVersion);
      overall.add(progress.overallStatus);
      expect(progress.stages.map((stage) => stage.id)).toEqual(file.stageIds);
      for (const stage of progress.stages) stageTriples.add(`${stage.id}|${stage.status}|${stage.explanationKey}`);
      satellitePairs.add(`${progress.satellite.status}|${progress.satellite.reasonCode}`);
      if (progress.satellite.noteCode) notes.add(progress.satellite.noteCode);
      for (const action of progress.actionRequired) {
        actions.add(`${action.code}|${action.stage}|${action.explanationKey}`);
        expect(Object.keys(action.params).sort()).toEqual(file.actions.find((entry) => entry.code === action.code).params.slice().sort());
      }
      if (progress.decision !== null) expect(file.decisionValues).toContain(progress.decision);
    }

    // Subset (nothing outside the file) AND coverage (nothing in the file the builder never emits).
    const fileTriples = new Set(Object.entries(file.stages).flatMap(([id, list]) => list.map((entry) => `${id}|${entry.status}|${entry.explanationKey}`)));
    expect([...stageTriples].sort()).toEqual([...fileTriples].sort());
    expect([...satellitePairs].sort()).toEqual(file.satellite.reasonCodes.map((entry) => `${entry.status}|${entry.reasonCode}`).sort());
    expect([...overall].sort()).toEqual([...file.overallStatuses].sort());
    expect([...actions].sort()).toEqual(file.actions.map((entry) => `${entry.code}|${entry.stage}|${entry.explanationKey}`).sort());
    expect([...notes]).toEqual(file.satellite.noteCodes);

    // The file's enumerations are the builder's own.
    expect(file.overallStatuses).toEqual([...OVERALL_STATUSES]);
    expect(file.stageIds).toEqual([...STAGE_IDS]);
    expect(file.stageStatuses).toEqual([...STAGE_STATUSES]);
    expect(file.satellite.statuses).toEqual([...SATELLITE_STATUSES]);
    expect(file.actions.map((entry) => entry.code)).toEqual([...ACTION_CODES]);
    // One status per explanation key and per satellite reason code (a client can rely on the pair).
    for (const list of Object.values(file.stages)) expect(new Set(list.map((entry) => entry.explanationKey)).size).toBe(list.length);
    expect(file.stages.decision.map((entry) => entry.explanationKey)).toContain("progress.decision.ai_no_damage_review");
  });

  it("PRG-10b: the frontend example fixture is the builder's own output for every scenario", async () => {
    const file = readJson(EXAMPLE_PATH);
    expect(file).toEqual(await exampleDocument());
    expect(Object.keys(file.examples)).toEqual(Object.keys(PROGRESS_SCENARIOS));
    expect(file.response.data.progress.contractVersion).toBe("progress-v1");
  });

  it("PRG-10c: no farmer progress object carries internal fields, codes, review cases or the policy hash", async () => {
    const all = await buildAllScenarioProgress();
    for (const [name, progress] of Object.entries(all)) {
      const keys = keysOf(progress);
      for (const forbidden of FORBIDDEN_FARMER_KEYS) expect(keys.has(forbidden), `${name}: ${forbidden}`).toBe(false);
      const text = JSON.stringify(progress);
      for (const fragment of ["PROVIDER_", "rv_", "automated_step_failed", "not-shown-to-farmers", "review_case", "deltaNdvi", "job0", "quota", "QUOTA"]) {
        expect(text, `${name}: ${fragment}`).not.toContain(fragment);
      }
    }
  });

  it("PRG-10d: decision equals the claim state for every decision state (more_evidence_required included), null otherwise; postEvent.end is null while the window is not open", async () => {
    const all = await buildAllScenarioProgress();
    expect(all.more_evidence_required).toMatchObject({ decision: "more_evidence_required", overallStatus: "action_required" });
    expect(all.decided_verified).toMatchObject({ decision: "verified", overallStatus: "decided" });
    expect(all.decided_by_reviewer).toMatchObject({ decision: "rejected", overallStatus: "decided" });
    for (const name of ["draft_no_photos", "submitted_fresh", "held_ai_no_damage", "deciding", "withdrawn_after_submit"]) expect(all[name].decision).toBeNull();

    const notOpen = all.retrying_event_today.satellite.observedWindows.postEvent;
    expect(notOpen).toEqual({ start: "2026-10-17T00:00:00.000Z", end: null, open: false, complete: false });
    const open = all.submitted_fresh.satellite.observedWindows.postEvent;
    expect(open.open).toBe(true);
    expect(new Date(open.end).getTime()).toBeGreaterThanOrEqual(new Date(open.start).getTime());
  });

  it("PRG-10e: land-document category groups are parsed from missing_document_category reason codes, unknown categories dropped", () => {
    expect(parseCategoryGroups(["missing_document_category:land_record|ownership_deed", "relationship_owner"])).toEqual([["land_record", "ownership_deed"]]);
    expect(parseCategoryGroups(["missing_document_category:lease_agreement", "missing_document_category:land_record|title_deed|tax_receipt"])).toEqual([
      ["lease_agreement"],
      ["land_record", "tax_receipt"],
    ]);
    expect(parseCategoryGroups(["missing_document_category:", "no_land_document"])).toEqual([]);
    expect(parseCategoryGroups(null)).toEqual([]);
  });

  it("PRG-10f: lastUpdatedAt is built from meaningful times only: lease renewals, put-backs and document updatedAt never move it", () => {
    const policy = resolvePolicy("v1.1-safe-ai");
    const claim = PROGRESS_SCENARIOS.submitted_fresh.input.claim;
    const base = {
      claim,
      photos: PROGRESS_SCENARIOS.submitted_fresh.input.photos,
      policy,
      windows: buildClaimWindows({ eventDate: claim.eventDate, policy, now: NOW }),
      now: NOW,
    };
    const queued = { _id: "j1", step: "ai_assessment", status: "queued", attempts: 0, runAt: new Date("2026-10-16T09:00:01Z"), createdAt: new Date("2026-10-16T09:00:01Z"), startedAt: null, lastError: { code: null, at: null } };
    const first = buildFarmerProgress({ ...base, jobs: [queued] });
    // The same job after a heartbeat, a lease change and a put-back: only bookkeeping fields moved.
    const touched = { ...queued, runAt: new Date("2026-10-16T09:04:00Z"), updatedAt: new Date("2026-10-16T09:04:59Z"), leaseUntil: new Date("2026-10-16T09:05:30Z") };
    const second = buildFarmerProgress({ ...base, jobs: [touched] });
    expect(second.lastUpdatedAt).toBe(first.lastUpdatedAt);
    // A real event (the attempt failed) moves it forward.
    const failed = { ...touched, attempts: 1, startedAt: new Date("2026-10-16T09:04:10Z"), lastError: { code: "PROVIDER_QUOTA", kind: "quota", at: new Date("2026-10-16T09:04:12Z") } };
    const third = buildFarmerProgress({ ...base, jobs: [failed] });
    expect(new Date(third.lastUpdatedAt).getTime()).toBe(new Date("2026-10-16T09:04:12Z").getTime());
    expect(third.stages.find((stage) => stage.id === "photos")).toMatchObject({ status: "waiting", explanationKey: "progress.photos.retrying_technical" });
  });
});
