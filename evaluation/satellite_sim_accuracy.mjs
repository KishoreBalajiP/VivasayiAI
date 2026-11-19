// Confusion-matrix metrics from the existing satellite threshold simulation
// (docs/research/evaluation/results/satelliteSimulation.json; produced by scripts/eval/satellite.sim.eval.js).
// Truth: trueNdviDrop > 0 = damaged, trueNdviDrop = 0 = not damaged. Prediction: SUPPORTS_LOSS = damaged,
// NO_CHANGE = not damaged. INCONCLUSIVE trials are reported separately and excluded from the matrix.
// A sensitivity variant counts only drops >= the 0.15 threshold as damaged.
// SIMULATED data with the simulation's own known truth; NOT real imagery or field-verified damage.
// Run from the repository root: node evaluation/satellite_sim_accuracy.mjs
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "docs/research/evaluation/results/satelliteSimulation.json";
const sim = JSON.parse(readFileSync(SRC, "utf8"));

const metrics = (isDamaged) => {
  let tp = 0, fn = 0, fp = 0, tn = 0, inconclusive = 0, total = 0;
  const excludedCells = [];
  for (const cell of sim.table) {
    const damaged = isDamaged(cell.trueNdviDrop);
    if (damaged === null) { excludedCells.push(cell.trueNdviDrop); continue; }
    total += cell.supportsLoss.n;
    inconclusive += cell.inconclusive.k;
    if (damaged) { tp += cell.supportsLoss.k; fn += cell.noChange.k; } else { fp += cell.supportsLoss.k; tn += cell.noChange.k; }
  }
  const n = tp + fn + fp + tn;
  const accuracy = (tp + tn) / n;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null;
  const pe = ((tp + fp) / n) * ((tp + fn) / n) + ((fn + tn) / n) * ((fp + tn) / n);
  const kappa = (accuracy - pe) / (1 - pe);
  const r = (x) => (x === null ? null : Math.round(x * 10000) / 10000);
  return {
    trials: total, decided: n, inconclusive, inconclusiveRate: r(inconclusive / total),
    confusionMatrix: { "true damaged": { "pred damaged": tp, "pred not_damaged": fn }, "true not_damaged": { "pred damaged": fp, "pred not_damaged": tn } },
    accuracy: r(accuracy), precision: r(precision), recall: r(recall), f1: r(f1), kappa: r(kappa), excludedCells,
  };
};

const result = {
  source: SRC,
  groundTruth: "the simulation's own known parameters (simulated NDVI responses); NOT real satellite imagery or field-verified damage",
  cells: sim.table.map((c) => ({ trueNdviDrop: c.trueNdviDrop, validPixelFractionAfter: c.validPixelFractionAfter, supportsLoss: c.supportsLoss.k, noChange: c.noChange.k, inconclusive: c.inconclusive.k, n: c.supportsLoss.n })),
  primary: { truthRule: "trueNdviDrop > 0 = damaged; 0 = not damaged (as requested)", ...metrics((d) => d > 0) },
  sensitivity: { truthRule: "only trueNdviDrop >= 0.15 (the rule's threshold) = damaged; 0 = not damaged; 0 < drop < 0.15 excluded", ...metrics((d) => (d >= 0.15 ? true : d === 0 ? false : null)) },
  createdAt: new Date().toISOString(),
};
writeFileSync("evaluation/satellite_sim_accuracy.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ cells: result.cells, primary: result.primary, sensitivity: result.sensitivity }, null, 1));
