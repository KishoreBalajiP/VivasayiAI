import { describe, expect, it } from "vitest";
import { confusion, percentile, rate, rng, scores, summary, wilson, confusionMatrix } from "../scripts/eval/lib/metrics.js";
import { SCORED_FIELDS, scoreExtraction } from "../scripts/eval/docExtraction.score.js";
import { runGeometryEvaluation } from "../scripts/eval/geometry.eval.js";
import { runNameEvaluation } from "../scripts/eval/names.eval.js";
import { runFusionEvaluation } from "../scripts/eval/fusion.eval.js";
import { runSatelliteSimulation } from "../scripts/eval/satellite.sim.eval.js";
import { runChatContextEvaluation } from "../scripts/eval/chatContext.eval.js";

// The evaluation harness is part of the research claim, so it is tested: the metric maths is checked
// against hand-computed values, runs are deterministic, and the invariants the write-up relies on hold.

describe("metrics", () => {
  it("EV-1: confusion counts and derived scores match hand-computed values", () => {
    const rows = [
      ...Array(8).fill({ expected: true, actual: true }), ...Array(2).fill({ expected: true, actual: false }),
      ...Array(1).fill({ expected: false, actual: true }), ...Array(9).fill({ expected: false, actual: false }),
    ];
    const s = scores(confusion(rows));
    expect(s).toMatchObject({ tp: 8, fn: 2, fp: 1, tn: 9, n: 20 });
    expect(s.precision).toBeCloseTo(8 / 9, 4);
    expect(s.recall).toBe(0.8);
    expect(s.f1).toBeCloseTo((2 * (8 / 9) * 0.8) / (8 / 9 + 0.8), 4);
    expect(s.falsePositiveRate).toBe(0.1);
  });

  it("EV-2: undefined ratios are null, never 0 or NaN", () => {
    const s = scores({ tp: 0, fp: 0, tn: 5, fn: 0 });
    expect(s.precision).toBeNull();
    expect(s.recall).toBeNull();
    expect(s.f1).toBeNull();
  });

  it("EV-3: percentiles, summaries and the Wilson interval", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
    expect(summary([2, 4]).mean).toBe(3);
    const ci = wilson(0, 50);
    expect(ci.low).toBe(0);
    expect(ci.high).toBeGreaterThan(0.05); // zero errors in 50 still leaves real uncertainty
    expect(rate(5, 10).ci95.low).toBeLessThan(0.5);
    expect(wilson(0, 0)).toBeNull();
  });

  it("EV-4: the PRNG is deterministic per seed and differs across seeds", () => {
    const a = rng(7); const b = rng(7); const c = rng(8);
    const seqA = [a(), a(), a()];
    expect(seqA).toEqual([b(), b(), b()]);
    expect(seqA).not.toEqual([c(), c(), c()]);
  });

  it("EV-5: the multi-class confusion matrix counts by expected then actual", () => {
    const m = confusionMatrix([{ expected: "a", actual: "a" }, { expected: "a", actual: "b" }, { expected: "b", actual: "b" }], ["a", "b"]);
    expect(m).toEqual({ a: { a: 1, b: 1 }, b: { a: 0, b: 1 } });
  });
});

describe("document extraction scorer", () => {
  const labels = {
    d1: { surveyNumber: "123/4A", district: "Thanjavur", holderNames: ["Murugan", "Selvam"], parcelExtent: 1.2 },
    d2: { surveyNumber: "7/1", district: "Madurai", holderNames: ["Lakshmi"], parcelExtent: 2 },
  };

  it("EV-6: perfect predictions score 1 on every labelled field", () => {
    const result = scoreExtraction({ predictions: structuredClone(labels), labels });
    expect(result.documentsFullyCorrect).toBe(2);
    expect(result.perField.surveyNumber).toMatchObject({ tp: 2, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 });
    expect(result.perField.holderNames.f1).toBe(1);
  });

  it("EV-7: a wrong value counts as both a false positive and a false negative; a missing one only a false negative", () => {
    const predictions = { d1: { surveyNumber: "999", district: "Thanjavur", holderNames: ["Murugan"], parcelExtent: 1.2 }, d2: { surveyNumber: null, district: "Madurai", holderNames: ["Lakshmi"], parcelExtent: 2 } };
    const { perField } = scoreExtraction({ predictions, labels });
    expect(perField.surveyNumber).toMatchObject({ tp: 0, fp: 1, fn: 2 });
    expect(perField.holderNames).toMatchObject({ tp: 1, fp: 1, fn: 1 }); // d1 partial list is wrong; d2 right
  });

  it("EV-8: comparison ignores case and spacing, holder order, and a 1% extent tolerance", () => {
    const predictions = { d1: { surveyNumber: " 123/4a ", district: "THANJAVUR", holderNames: ["selvam", "MURUGAN"], parcelExtent: 1.205 }, d2: structuredClone(labels.d2) };
    const { perField } = scoreExtraction({ predictions, labels });
    expect(perField.surveyNumber.tp).toBe(2);
    expect(perField.holderNames.tp).toBe(2);
    expect(perField.parcelExtent.tp).toBe(2);
  });

  it("EV-9: an unlabelled field a system invents is a false positive, not ignored", () => {
    const { perField } = scoreExtraction({ predictions: { d1: { taluk: "Invented" } }, labels: { d1: {} } });
    expect(perField.taluk).toMatchObject({ fp: 1, tp: 0, fn: 0 });
    expect(SCORED_FIELDS).toContain("surveyNumber");
  });
});

describe("evaluation invariants", () => {
  it("EV-10: the geometry evaluation is reproducible and the validator rejects out-of-range coordinates", () => {
    const a = runGeometryEvaluation({ seed: 11 });
    const b = runGeometryEvaluation({ seed: 11 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.invalidGeometry.detectedByKind.outOfRange.k).toBe(a.invalidGeometry.detectedByKind.outOfRange.n);
    expect(a.invalidGeometry.validRejected.k).toBe(0);
  });

  it("EV-11: the server's area differs from an ellipsoidal reference by under 1% and in one direction (a documented, systematic effect)", () => {
    const { area } = runGeometryEvaluation({ seed: 3 });
    expect(area.relativeError.max).toBeLessThan(0.01);
    expect(area.relativeError.min).toBeGreaterThan(0.004);
  });

  it("EV-12: name evaluation: no true match is called a mismatch, and no true mismatch is called a match", () => {
    const result = runNameEvaluation();
    expect(result.n).toBe(60);
    expect(result.matchCalledMismatch.k).toBe(0);
    expect(result.mismatchCalledMatch.k).toBe(0);
    expect(result.tuningHistory.length).toBeGreaterThan(0); // the optimism caveat travels with the number
  });

  it("EV-13: fusion: the gate approves nothing the design rule forbids, and supporting evidence never changes a decision", () => {
    const result = runFusionEvaluation();
    expect(result.policies["full fusion (v2-components)"].invalidApprovalRate.k).toBe(0);
    expect(result.policies["photo-only (v1-legacy)"].invalidApprovalRate.k).toBeGreaterThan(0);
    expect(result.policies["photo-only (v1-legacy)"].adverseOnAiAlone.k).toBeGreaterThan(0);
    expect(result.policies["full fusion (v2-components)"].adverseOnAiAlone.k).toBe(0);
    for (const flips of Object.values(result.supportingEvidenceChangedOutcome)) expect(flips.k).toBe(0);
    // Removing a component re-opens exactly the invalid approvals it prevents.
    expect(result.policies["v2 without claimant_rights"].invalidApprovalsByCause.rights).toBeGreaterThan(0);
    expect(result.policies["v2 without overlap"].invalidApprovalsByCause.cross).toBeGreaterThan(0);
  });

  it("EV-14: satellite simulation: more cloud means more 'inconclusive', never more false support", () => {
    const { table, headline } = runSatelliteSimulation({ seed: 5, trials: 200 });
    const clear = table.find((row) => row.trueNdviDrop === 0.3 && row.validPixelFractionAfter === 0.9);
    const cloudy = table.find((row) => row.trueNdviDrop === 0.3 && row.validPixelFractionAfter === 0.3);
    expect(cloudy.inconclusive.value).toBeGreaterThan(clear.inconclusive.value);
    expect(headline.falseSupportAtNoChangeCloudy.value).toBe(0);
    expect(table.filter((row) => row.trueNdviDrop === 0).every((row) => row.supportsLoss.value <= 0.02)).toBe(true);
  });

  it("EV-15: chat context: the new logic asks only when needed, and the old rule's failures are measured", async () => {
    const result = await runChatContextEvaluation();
    const { newLogic, previousRule } = result.followUp;
    expect(newLogic.unnecessaryFollowUpRate.k).toBe(0);
    expect(newLogic.missedNecessaryFollowUpRate.k).toBe(0);
    expect(previousRule.unnecessaryFollowUpRate.value).toBeGreaterThan(0.5);
    expect(previousRule.silentAssumptionWhenAmbiguous.value).toBe(1);
    expect(result.pending.length).toBeGreaterThan(0); // what was NOT measured travels with the result
  }, 120000);
});
