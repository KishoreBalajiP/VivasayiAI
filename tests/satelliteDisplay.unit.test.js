import { describe, expect, it } from "vitest";
import { buildSatelliteDisplay, satelliteRowDisplay } from "../services/claimProgress.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { buildClaimWindows } from "../services/satelliteVerification.service.js";

// ADR-022 (plan A6) — the farmer's satellite status, one case per row of the truth table (first match
// wins). Satellite is SUPPORTING evidence only (D1): it is never `passed` unless an analysis actually
// supports the loss, never `failed` for a finding (only for a technical failure with nothing to
// show), and anything not covered falls to `unavailable`, never to `passed` (critique D6).

const NOW = new Date("2026-10-16T09:05:00.000Z");
const policy = resolvePolicy("v1.1-safe-ai");
const claim = (over = {}) => ({ _id: "c1", state: "submitted", eventDate: new Date("2026-10-13T00:00:00.000Z"), ...over });
const windowsFor = (eventDate) => buildClaimWindows({ eventDate, policy, now: NOW });
const display = ({ claimOver = {}, rows = [], job = null, satelliteEnabled = true, automationEnabled = true } = {}) => {
  const c = claim(claimOver);
  return buildSatelliteDisplay({ claim: c, rows, job, windows: windowsFor(c.eventDate), satelliteEnabled, automationEnabled, now: NOW });
};
const row = (status, metadata = {}, result = null, over = {}) => ({
  _id: `r-${status}-${metadata.outcome || "x"}`,
  source: "SATELLITE",
  status,
  idempotencyKey: `sat2_${status}`,
  createdAt: new Date("2026-10-16T09:01:00.000Z"),
  metadata,
  result,
  ...over,
});
const satJob = (status, over = {}) => ({
  _id: "j-sat",
  step: "satellite",
  status,
  runAt: new Date("2026-10-16T09:00:01.000Z"),
  createdAt: new Date("2026-10-16T09:00:01.000Z"),
  startedAt: status === "queued" ? null : new Date("2026-10-16T09:00:05.000Z"),
  deadAt: status === "dead" ? new Date("2026-10-16T09:04:00.000Z") : null,
  ...over,
});
const analysis = (analysisOutcome) => ({
  analyzed: true,
  analysisOutcome,
  deltaNdvi: -0.31,
  before: { series: [{ date: "2026-09-20", ndvi: 0.7 }, { date: "2026-09-25", ndvi: 0.72 }] },
  after: { series: [{ date: "2026-10-15", ndvi: 0.39 }] },
});
const pair = (value) => [value.status, value.reasonCode];

describe("farmer satellite status truth table", () => {
  it("SD-1: a withdrawn claim shows unavailable / claim_withdrawn, even with a result recorded", () => {
    const result = display({ claimOver: { state: "withdrawn" }, rows: [row("AVAILABLE", { outcome: "ANALYSIS_COMPLETE" }, analysis("SUPPORTS_LOSS"))], job: satJob("cancelled") });
    expect(pair(result)).toEqual(["unavailable", "claim_withdrawn"]);
    expect(result.nextCheckAt).toBeNull();
    expect(result.supportingOnly).toBe(true);
  });

  it("SD-2: a running satellite job shows processing / checking_imagery", () => {
    expect(pair(display({ job: satJob("running") }))).toEqual(["processing", "checking_imagery"]);
    expect(pair(display({ job: satJob("running"), rows: [row("UNAVAILABLE", { outcome: "TIMEOUT" })] }))).toEqual(["processing", "checking_imagery"]);
  });

  it("SD-3: a dead job with nothing recorded shows failed / technical_issue", () => {
    const result = display({ job: satJob("dead") });
    expect(pair(result)).toEqual(["failed", "technical_issue"]);
    expect(result.noteCode).toBeNull();
    expect(result.updatedAt).toBe("2026-10-16T09:04:00.000Z");
  });

  it("SD-4: an earlier valid result stays when a newer re-check died, with a technical note (never failed)", () => {
    const result = display({ job: satJob("dead"), rows: [row("AVAILABLE", { outcome: "ANALYSIS_COMPLETE", processingStatus: "executed" }, analysis("SUPPORTS_LOSS"))] });
    expect(pair(result)).toEqual(["passed", "vegetation_drop_consistent_with_damage"]);
    expect(result.noteCode).toBe("latest_check_failed");
    const inconclusive = display({ job: satJob("dead"), rows: [row("INSUFFICIENT", { outcome: "CLOUD_OBSCURED" })] });
    expect(pair(inconclusive)).toEqual(["inconclusive", "cloud_cover"]);
    expect(inconclusive.noteCode).toBe("latest_check_failed");
  });

  it("SD-5: nothing recorded and the adapter switched off shows unavailable / not_enabled", () => {
    expect(pair(display({ satelliteEnabled: false }))).toEqual(["unavailable", "not_enabled"]);
    expect(pair(display({ satelliteEnabled: false, job: satJob("queued") }))).toEqual(["unavailable", "not_enabled"]);
  });

  it("SD-6: the post-event window not open yet shows pending / waiting_for_post_event_imagery with the job's real next check", () => {
    const eventToday = { eventDate: new Date("2026-10-16T00:00:00.000Z") };
    const runAt = new Date("2026-10-18T00:00:00.000Z");
    const withJob = display({ claimOver: eventToday, job: satJob("queued", { runAt, resultSummary: { skipped: "post_window_not_open" } }) });
    expect(pair(withJob)).toEqual(["pending", "waiting_for_post_event_imagery"]);
    expect(withJob.nextCheckAt).toBe(runAt.toISOString());
    expect(withJob.observedWindows.postEvent).toEqual({ start: "2026-10-17T00:00:00.000Z", end: null, open: false, complete: false });
    // Without a job there is no next check to promise.
    const withoutJob = display({ claimOver: eventToday });
    expect(pair(withoutJob)).toEqual(["pending", "waiting_for_post_event_imagery"]);
    expect(withoutJob.nextCheckAt).toBeNull();
  });

  it("SD-7: nothing recorded yet: a due job is pending / queued, no job is pending / not_started (unavailable when automation is off)", () => {
    const due = display({ job: satJob("queued") });
    expect(pair(due)).toEqual(["pending", "queued"]);
    expect(due.nextCheckAt).toBeNull(); // due now: no future time to show
    expect(pair(display({}))).toEqual(["pending", "not_started"]);
    expect(pair(display({ claimOver: { state: "draft" } }))).toEqual(["pending", "not_started"]);
    expect(pair(display({ automationEnabled: false }))).toEqual(["unavailable", "not_enabled"]);
  });

  it("SD-8: a disabled-adapter result (CONFIG_DISABLED, or a legacy NOT_CHECKED row) shows unavailable / not_enabled", () => {
    expect(satelliteRowDisplay(row("NOT_CHECKED", { outcome: "CONFIG_DISABLED" }))).toBe("not_enabled");
    expect(satelliteRowDisplay(row("NOT_CHECKED", {}))).toBe("not_enabled");
    expect(pair(display({ rows: [row("NOT_CHECKED", { outcome: "CONFIG_DISABLED" })], job: satJob("succeeded") }))).toEqual(["unavailable", "not_enabled"]);
  });

  it("SD-9: invalid input or an unsupported provider/product/processing shows not_supported / area_not_supported", () => {
    for (const outcome of ["INVALID_INPUT", "UNSUPPORTED_PROVIDER", "UNSUPPORTED_PRODUCT", "UNSUPPORTED_PROCESSING"]) {
      expect(pair(display({ rows: [row("NOT_CHECKED", { outcome })] }))).toEqual(["not_supported", "area_not_supported"]);
    }
    // The satellite step ran but the claim has no polygon to analyse.
    expect(pair(display({ job: satJob("succeeded", { resultSummary: { skipped: "no_geometry" } }) }))).toEqual(["not_supported", "area_not_supported"]);
  });

  it("SD-10: imagery found with processing disabled, without credentials or not attempted is unavailable / analysis_not_enabled — never passed", () => {
    for (const processingStatus of ["disabled", "credentials_required", "not_attempted"]) {
      const result = display({ rows: [row("PENDING", { outcome: "IMAGERY_FOUND", processingStatus, analysisExecuted: false })], job: satJob("succeeded") });
      expect(pair(result)).toEqual(["unavailable", "analysis_not_enabled"]);
      expect(result.imageryDates).toBeNull();
      // A legacy row (no recorded outcome) reads the same way.
      expect(satelliteRowDisplay(row("PENDING", { processingStatus }))).toBe("analysis_not_enabled");
      // Audit C (mutation 9): even a row that carries a SUPPORTS_LOSS analysis result must not read as
      // passed while analysis is not enabled — the row's status/processing flags win over its result.
      const withResult = display({
        rows: [row("PENDING", { outcome: "IMAGERY_FOUND", processingStatus, analysisExecuted: false }, analysis("SUPPORTS_LOSS"))],
        job: satJob("succeeded"),
      });
      expect(pair(withResult)).toEqual(["unavailable", "analysis_not_enabled"]);
      expect(withResult.status).not.toBe("passed");
    }
  });

  it("SD-11: a provider failure (auth, quota, error, timeout, malformed, legacy UNAVAILABLE) is unavailable / provider_unavailable, with the transient retry as next check", () => {
    for (const outcome of ["AUTH_REQUIRED", "QUOTA_EXCEEDED", "PROVIDER_ERROR", "TIMEOUT", "MALFORMED_RESPONSE"]) {
      expect(satelliteRowDisplay(row("UNAVAILABLE", { outcome }))).toBe("provider_unavailable");
    }
    expect(satelliteRowDisplay(row("UNAVAILABLE", {}))).toBe("provider_unavailable");
    const retry = new Date("2026-10-16T10:05:00.000Z");
    const result = display({ rows: [row("UNAVAILABLE", { outcome: "QUOTA_EXCEEDED" })], job: satJob("queued", { runAt: retry, rescheduleCount: 1 }) });
    expect(pair(result)).toEqual(["unavailable", "provider_unavailable"]);
    expect(result.nextCheckAt).toBe(retry.toISOString());
  });

  it("SD-12: no imagery, cloud, too few images or an inconclusive analysis is inconclusive with its reason", () => {
    const cases = [
      [row("UNAVAILABLE", { outcome: "IMAGERY_UNAVAILABLE" }), "no_imagery_for_window"],
      [row("INSUFFICIENT", { outcome: "CLOUD_OBSCURED" }), "cloud_cover"],
      [row("INSUFFICIENT", { outcome: "INSUFFICIENT_TEMPORAL_COVERAGE" }), "not_enough_images"],
      [row("INSUFFICIENT", { outcome: "INCONCLUSIVE", processingStatus: "inconclusive" }), "analysis_inconclusive"],
      [row("INSUFFICIENT", {}), "analysis_inconclusive"],
    ];
    for (const [recorded, reason] of cases) expect(pair(display({ rows: [recorded] }))).toEqual(["inconclusive", reason]);
  });

  it("SD-13: an analysis supporting the loss is passed (supporting only), with the imagery dates and no NDVI values", () => {
    const result = display({ rows: [row("AVAILABLE", { outcome: "ANALYSIS_COMPLETE", processingStatus: "executed", analysisExecuted: true }, analysis("SUPPORTS_LOSS"))], job: satJob("succeeded") });
    expect(result).toMatchObject({ status: "passed", reasonCode: "vegetation_drop_consistent_with_damage", supportingOnly: true, noteCode: null });
    expect(result.imageryDates).toEqual({ preEvent: ["2026-09-20", "2026-09-25"], postEvent: ["2026-10-15"] });
    expect(result.updatedAt).toBe("2026-10-16T09:01:00.000Z");
    expect(JSON.stringify(result)).not.toMatch(/deltaNdvi|ndvi|-0\.31|cdse|provider/i);
  });

  it("SD-14: no clear vegetation change is inconclusive, never failed; any other analysis outcome is inconclusive too", () => {
    expect(pair(display({ rows: [row("AVAILABLE", { outcome: "ANALYSIS_COMPLETE" }, analysis("NO_CHANGE"))] }))).toEqual(["inconclusive", "no_clear_vegetation_change"]);
    expect(pair(display({ rows: [row("AVAILABLE", { outcome: "ANALYSIS_COMPLETE" }, analysis("INCONCLUSIVE"))] }))).toEqual(["inconclusive", "analysis_inconclusive"]);
    // A legacy AVAILABLE row without a recorded outcome reads its analysis the same way.
    expect(satelliteRowDisplay(row("AVAILABLE", {}, analysis("NO_CHANGE")))).toBe("no_clear_vegetation_change");
  });

  it("SD-15: anything the table does not cover is unavailable, never passed; a review case labelled SATELLITE is never read as a result", () => {
    for (const processingStatus of ["unsupported", "failed", "inconclusive", "executed"]) {
      expect(satelliteRowDisplay(row("PENDING", { outcome: "IMAGERY_FOUND", processingStatus }))).toBe("provider_unavailable");
    }
    expect(satelliteRowDisplay(row("VERIFIED", { outcome: "SOMETHING_NEW" }))).toBe("provider_unavailable");
    expect(satelliteRowDisplay(row("AVAILABLE", { outcome: "IMAGERY_FOUND" }, analysis("SUPPORTS_LOSS")))).toBe("provider_unavailable");
    // A finished job that recorded nothing.
    expect(pair(display({ job: satJob("succeeded") }))).toEqual(["unavailable", "provider_unavailable"]);
    // A dead job's review case (labelled SATELLITE) is not satellite data: the earlier result is shown.
    const reviewCase = row("PENDING", { kind: "review_case", reviewRequired: true, failedStep: "satellite" }, { reviewReasons: ["automated_step_failed_satellite"] }, {
      idempotencyKey: "rv_c1_SATELLITE_x",
      createdAt: new Date("2026-10-16T09:04:30.000Z"),
    });
    const result = display({ rows: [row("INSUFFICIENT", { outcome: "CLOUD_OBSCURED" }), reviewCase], job: satJob("succeeded") });
    expect(pair(result)).toEqual(["inconclusive", "cloud_cover"]);
  });
});
