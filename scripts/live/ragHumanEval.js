import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCsv } from "../../rag/ingestHelpers.js";
import { writeJsonOnce } from "./lib/writeOnce.js";
import { agreement, buildPool, csvEscape, disagreements, finalQrels, humanMetrics, validateLabels } from "./lib/ragHumanEval.js";

// Human relevance workflow. See docs/research/evaluation/human_relevance/ASSESSOR_INSTRUCTIONS.md.
//   pack     --runs=a.json,b.json --out=<dir>     blinded packet (one CSV) + key.json with conditions
//   check    --key=<key> --a=<a.csv> --b=<b.csv> --out=<agreement.json>   validates, agreement, disagreement list
//   metrics  --key=<key> --a --b [--adjudicated=<csv>] --runs=... --out=<metrics.json>
// Packets hold chunk text from sources marked all-rights-reserved: keep them out of the repository.

const [command] = process.argv.slice(2);
const arg = (name) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 3);
};
const loadRuns = () => arg("runs").split(",").map((path) => JSON.parse(readFileSync(resolve(path), "utf8"))).map((run) => ({ condition: run.condition, rows: run.rows }));
const loadLabels = (path) => {
  const [headers, ...rows] = parseCsv(readFileSync(resolve(path), "utf8"));
  return rows.map((values) => Object.fromEntries(headers.map((header, i) => [header.trim(), (values[i] ?? "").trim()])));
};
const checked = (key, path) => {
  const labels = loadLabels(path);
  const report = validateLabels(labels, key.items.map((item) => item.pool_id));
  if (!report.ok) {
    console.error(`${path}: ${report.errors.slice(0, 20).join("; ")}`);
    process.exit(1);
  }
  return labels;
};

if (command === "pack") {
  const pool = buildPool(loadRuns());
  const out = resolve(arg("out"));
  mkdirSync(out, { recursive: true });
  const header = "pool_id,query,chunk_text,source_url,label,notes,assessor_id,assessor_type\n";
  const csv = header + pool.map((item) => [item.pool_id, item.query, item.chunk_text, item.source_url, "", "", "", ""].map(csvEscape).join(",")).join("\n") + "\n";
  writeFileSync(join(out, "assessor_packet.csv"), csv, { flag: "wx" });
  writeJsonOnce(join(out, "key.json"), { name: "ragHumanPoolKey", createdAt: new Date().toISOString(), packetSha256: createHash("sha256").update(csv).digest("hex"), items: pool.map(({ pool_id, query_id, appearsIn }) => ({ pool_id, query_id, appearsIn })) });
  console.log(JSON.stringify({ items: pool.length, out }));
} else if (command === "check" || command === "metrics") {
  const key = JSON.parse(readFileSync(resolve(arg("key")), "utf8"));
  const a = checked(key, arg("a"));
  const b = checked(key, arg("b"));
  if (command === "check") {
    writeJsonOnce(resolve(arg("out")), { name: "ragHumanAgreement", agreement: agreement(a, b), disagreements: disagreements(a, b) });
  } else {
    const qrels = finalQrels(a, b, arg("adjudicated") ? loadLabels(arg("adjudicated")) : []);
    const results = loadRuns().map(({ condition, rows }) => ({ condition, at1: humanMetrics(rows, qrels, 1), at3: humanMetrics(rows, qrels, 3), at5: humanMetrics(rows, qrels, 5) }));
    writeJsonOnce(resolve(arg("out")), { name: "ragHumanMetrics", groundTruth: "adjudicated human labels (grade 2 = answer-bearing)", judgedItems: qrels.size, results });
  }
  console.log(`Wrote ${arg("out")}`);
} else {
  console.error("Usage: ragHumanEval.js pack|check|metrics (see the header comment)");
  process.exit(1);
}
process.exit(0);
