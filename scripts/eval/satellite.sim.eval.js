import { resolvePolicy } from "../../config/verificationPolicy.js";
import { interpretNdviChange, parseNdviStatisticalResponse } from "../../services/satellite/ndviStatistics.js";
import { between, rate, rng } from "./lib/metrics.js";

// SIMULATION of the NDVI change interpretation. NO real satellite imagery is used.
//
// Statistical API responses are generated from a simple known model (a true pre-event NDVI, a true
// post-event drop, measurement noise, and a masked-pixel fraction from cloud), pushed through the real
// response parser and the real interpretation rule. This shows how the provisional thresholds behave:
// how often a real drop is detected, how often no change is wrongly flagged, and how cloud turns
// results into "inconclusive" rather than guesses. It cannot show that NDVI change identifies crop
// loss in the field. That needs real imagery with independent ground-truth labels (not available).

const response = (ndvi, sampleCount, maskedFraction) => ({
  data: [{ outputs: { ndvi: { bands: { B0: { stats: { mean: ndvi, sampleCount, noDataCount: Math.round(sampleCount * maskedFraction) } } } } } }],
});

const NOISE_SD = 0.03; // assumed per-window measurement noise on the mean NDVI
const normal = (random) => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

export const runSatelliteSimulation = ({ seed = 20261016, trials = 400 } = {}) => {
  const random = rng(seed);
  const thresholds = resolvePolicy("v1-legacy").satellite;
  const drops = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4];
  const valid = [0.9, 0.7, 0.5, 0.3];

  const table = [];
  for (const maskedAfter of valid.map((v) => 1 - v)) {
    for (const drop of drops) {
      const counts = { SUPPORTS_LOSS: 0, NO_CHANGE: 0, INCONCLUSIVE: 0 };
      for (let i = 0; i < trials; i += 1) {
        const preTrue = between(random, 0.5, 0.85);
        const pre = preTrue + NOISE_SD * normal(random);
        const post = preTrue - drop + NOISE_SD * normal(random);
        const before = parseNdviStatisticalResponse(response(pre, 400, 0.05));
        const after = parseNdviStatisticalResponse(response(post, 400, maskedAfter));
        const outcome = before.ok && after.ok
          ? interpretNdviChange({ before: { ndvi: before.ndvi, validPixelFraction: before.validPixelFraction }, after: { ndvi: after.ndvi, validPixelFraction: after.validPixelFraction }, thresholds }).outcome
          : "INCONCLUSIVE";
        counts[outcome] += 1;
      }
      table.push({
        trueNdviDrop: drop, validPixelFractionAfter: Math.round((1 - maskedAfter) * 100) / 100,
        supportsLoss: rate(counts.SUPPORTS_LOSS, trials), noChange: rate(counts.NO_CHANGE, trials), inconclusive: rate(counts.INCONCLUSIVE, trials),
      });
    }
  }

  const cell = (d, v) => table.find((row) => row.trueNdviDrop === d && row.validPixelFractionAfter === v);
  return {
    name: "satelliteSimulation",
    description: "Behaviour of the provisional NDVI-change thresholds on simulated Statistical API responses.",
    groundTruth: "the simulation's own known parameters (true NDVI drop, masked fraction); NO real imagery",
    thresholds: { ...thresholds, source: "provisional, uncalibrated policy values" },
    model: { preEventNdviRange: [0.5, 0.85], measurementNoiseSd: NOISE_SD, trialsPerCell: trials, preEventMaskedFraction: 0.05 },
    table,
    headline: {
      falseSupportAtNoChangeClearSky: cell(0, 0.9).supportsLoss,
      falseSupportAtNoChangeCloudy: cell(0, 0.3).supportsLoss,
      detectionAtDrop015ClearSky: cell(0.15, 0.9).supportsLoss,
      detectionAtDrop030ClearSky: cell(0.3, 0.9).supportsLoss,
      inconclusiveWhenMostlyMasked: cell(0.3, 0.3).inconclusive,
    },
    limitations: [
      "Simulated data only: shows the rule's behaviour, not that NDVI change identifies crop loss.",
      "Noise is Gaussian with a fixed SD; real noise depends on crop, season, atmosphere and sensor geometry.",
      "Normal seasonal change (growth, senescence, harvest, flooding of paddy at transplanting) is not simulated and is the main real-world confound; a drop that large can occur with no damage.",
      "NO_CHANGE never refutes a claim; the rule can only support one.",
    ],
  };
};

export default runSatelliteSimulation;
