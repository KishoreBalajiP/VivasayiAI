// Metric helpers shared by the evaluation scripts. Pure and dependency-free.

// Deterministic PRNG (mulberry32): every evaluation is reproducible from its seed.
export const rng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const between = (random, lo, hi) => lo + random() * (hi - lo);
export const pick = (random, list) => list[Math.floor(random() * list.length)];

// Binary classification counts and rates. `positive` cases are those the system SHOULD flag.
export const confusion = (rows) => {
  const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const { expected, actual } of rows) {
    if (expected && actual) c.tp += 1;
    else if (!expected && actual) c.fp += 1;
    else if (!expected && !actual) c.tn += 1;
    else c.fn += 1;
  }
  return c;
};

const ratio = (num, den) => (den === 0 ? null : num / den);
const round = (value, digits = 4) => (value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits);

export const scores = ({ tp, fp, tn, fn }) => {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  return {
    tp, fp, tn, fn,
    n: tp + fp + tn + fn,
    precision: round(precision), recall: round(recall), f1: round(f1),
    falsePositiveRate: round(ratio(fp, fp + tn)),
    falseNegativeRate: round(ratio(fn, fn + tp)),
    accuracy: round(ratio(tp + tn, tp + fp + tn + fn)),
  };
};

export const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

export const summary = (values) => ({
  n: values.length,
  mean: values.length ? round(values.reduce((s, v) => s + v, 0) / values.length, 6) : null,
  min: values.length ? Math.min(...values) : null,
  max: values.length ? Math.max(...values) : null,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
});

// Wilson score interval for a proportion (95%): honest uncertainty on small samples.
export const wilson = (successes, n, z = 1.96) => {
  if (n === 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)) };
};

export const rate = (successes, n) => ({ k: successes, n, value: round(ratio(successes, n)), ci95: wilson(successes, n) });

// Multi-class confusion matrix keyed by expected then actual label.
export const confusionMatrix = (rows, labels) => {
  const matrix = Object.fromEntries(labels.map((e) => [e, Object.fromEntries(labels.map((a) => [a, 0]))]));
  for (const { expected, actual } of rows) {
    if (matrix[expected] && matrix[expected][actual] !== undefined) matrix[expected][actual] += 1;
  }
  return matrix;
};

export default { rng, between, pick, confusion, scores, percentile, summary, wilson, rate, confusionMatrix };
