import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QUERIES, T, labelHit, labelHits, labelHitsRowTextOnly, rowTextOf, summarizeRows } from "../scripts/live/lib/ragEvalSpec.js";
import { extractFrozenBlocks, gitHistoryAvailable, readProvenance, readSpec, sha256, specSha256, verifyRagSpec, SPEC_PATH } from "../scripts/live/verifyRagSpec.js";
import { compareRuns } from "../scripts/live/ragParity.js";
import { buildComparison, renderMarkdown } from "../scripts/live/ragCompare.js";

// The frozen RAG relevance rule (plan A10): hash pins, labels, and reproduction of the frozen
// 2026-10-16 baseline. No provider is called.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(readFileSync(join(root, "docs", "research", "evaluation", "live", "rag_retrieval_2026-10-16.json"), "utf8"));
const query = (id) => QUERIES.find((q) => q.id === id);

// Scripts run in a child process with no .env, blank provider keys and a preload that makes every
// socket connection throw, so a missing guard fails instead of reaching a provider.
const runScript = (script, args, { cwd = root } = {}) => {
  const preload = join(mkdtempSync(join(tmpdir(), "rag-spec-preload-")), "no-network.mjs");
  writeFileSync(preload, 'import net from "node:net";\nconst blocked = () => { throw new Error("network blocked by the RAG spec test"); };\nnet.Socket.prototype.connect = blocked;\nglobalThis.fetch = async () => blocked();\n');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", LOG_LEVEL: "silent", VIVASAYI_SKIP_DOTENV: "1" };
  for (const key of ["COHERE_API_KEY", "CHROMA_API_KEY", "CHROMA_TENANT", "CHROMA_DATABASE", "GOOGLE_API_KEY", "MY_AWS_ACCESS_KEY_ID", "MY_AWS_SECRET_ACCESS_KEY", "MONGO_URI"]) env[key] = "";
  return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, ...args], { cwd, env, encoding: "utf8", timeout: 60000 });
};

describe("frozen RAG evaluation spec", () => {
  it("RS-1: every frozen block and the whole spec file hash to the provenance pins", () => {
    const provenance = readProvenance();
    const blocks = extractFrozenBlocks(readSpec());
    expect([...blocks.keys()]).toEqual(provenance.blocks.map((b) => b.name));
    expect(provenance.blocks.map((b) => b.name)).toEqual(["T", "QUERIES", "helpers", "kind", "labelHits", "partition", "summarize"]);
    for (const pin of provenance.blocks) expect(sha256(blocks.get(pin.name)), pin.name).toBe(pin.sha256);
    expect(specSha256()).toBe(provenance.spec.specSha256);
    expect(provenance.source).toMatchObject({ commit: "6dbe6b8", path: "scripts/live/ragRetrieval.live.js" });
    expect(verifyRagSpec({ useGit: false })).toMatchObject({ ok: true, errors: [] });
    // A one-character change to a block changes its hash.
    const tampered = extractFrozenBlocks(readSpec().replace('erode: ["erode"]', 'erode: ["erode", "irode"]'));
    expect(sha256(tampered.get("T"))).not.toBe(provenance.blocks.find((b) => b.name === "T").sha256);
    expect(QUERIES).toHaveLength(22);
  });

  it("RS-1: ragRetrieval and ragEmbedQueries refuse a spec that no longer matches its pin, before any provider or index work", () => {
    // A copy of scripts/live whose spec was edited OUTSIDE the frozen blocks: every block still hashes
    // to its pin, so only the whole-file pin catches it. config/, src/ and rag/ are the real ones.
    const work = mkdtempSync(join(tmpdir(), "rag-spec-pin-"));
    cpSync(join(root, "scripts", "live"), join(work, "scripts", "live"), { recursive: true });
    for (const dir of ["config", "src", "rag"]) symlinkSync(join(root, dir), join(work, dir), "dir");
    writeFileSync(join(work, "package.json"), '{ "type": "module" }\n');
    const specCopy = join(work, SPEC_PATH);
    writeFileSync(specCopy, `${readFileSync(specCopy, "utf8")}\n// an edit outside the frozen blocks\n`);
    const report = verifyRagSpec({ useGit: false, base: work });
    expect(report.ok).toBe(false);
    expect(report.blocks.every((block) => block.ok)).toBe(true);
    expect(report.errors).toEqual([expect.stringMatching(/^specSha256 [0-9a-f]{64} differs from the pin/)]);

    const out = join(work, "out");
    const retrieval = runScript(join(work, "scripts", "live", "ragRetrieval.live.js"), ["--date=2026-10-20", "--backend=json", "--tag=pin", `--index=${join(work, "no-index")}`, `--query-vectors=${join(work, "no-vectors.json")}`, `--out-dir=${out}`], { cwd: work });
    expect(retrieval.status, retrieval.stderr).toBe(1);
    expect(retrieval.stderr).toMatch(/The RAG evaluation rule does not match its pin .*specSha256 [0-9a-f]{64} differs from the pin/);
    const embed = runScript(join(work, "scripts", "live", "ragEmbedQueries.js"), [`--out=${join(out, "query_vectors.json")}`], { cwd: work });
    expect(embed.status, embed.stderr).toBe(1);
    expect(embed.stderr).toMatch(/The RAG evaluation rule does not match its pin/);
    expect(existsSync(out)).toBe(false);

    // In the real scripts the check sits before the first provider import.
    for (const rel of ["scripts/live/ragRetrieval.live.js", "scripts/live/ragEmbedQueries.js"]) {
      const source = readFileSync(join(root, rel), "utf8");
      const check = source.indexOf("verifyRagSpec();");
      expect(check, rel).toBeGreaterThan(0);
      for (const provider of ['import("chromadb")', 'import("@langchain/cohere")']) {
        if (source.includes(provider)) expect(source.indexOf(provider), `${rel}: ${provider}`).toBeGreaterThan(check);
      }
    }
  });

  it("RS-1: ragCompare calls conditions comparable only when every run used the pinned rule, and ragParity records the pin", () => {
    const pin = readProvenance().spec.specSha256;
    const vectors = "a".repeat(64);
    const run = (spec) => ({ ...structuredClone(baseline), backend: "json", specSha256: spec, queryVectorsSha256: vectors });
    const parity = (spec) => ({ verdict: "PASS", date: "2026-10-20", diffs: [], candidate: { specSha256: spec, queryVectorsSha256: vectors } });

    const pinned = buildComparison({ baseline, legacy: run(pin), table: run(pin), parity: parity(pin) });
    expect(pinned.consistency).toEqual({ sameSpecSha256: true, specMatchesPin: true, sameQueryVectors: true, parityUsedSameSpec: true, parityUsedSameQueryVectors: true });
    expect(pinned).toMatchObject({ comparable: true, pinnedSpecSha256: pin });

    // Every run and the parity replay share one edited rule: consistent with each other, and parity can
    // still pass (an edit that only touches new-format chunks leaves the baseline labels alone).
    const edited = "e".repeat(64);
    const unpinned = buildComparison({ baseline, legacy: run(edited), table: run(edited), parity: parity(edited) });
    expect(unpinned.consistency).toEqual({ sameSpecSha256: true, specMatchesPin: false, sameQueryVectors: true, parityUsedSameSpec: true, parityUsedSameQueryVectors: true });
    expect(unpinned.comparable).toBe(false);
    expect(renderMarkdown(unpinned, { date: "2026-10-20" })).toMatch(/Comparability NOT ESTABLISHED/);
    expect(buildComparison({ baseline, legacy: run(pin), table: run(edited), parity: parity(pin) }).consistency.specMatchesPin).toBe(false);
    expect(buildComparison({ baseline, legacy: run(edited), table: run(edited), parity: parity(edited), pinnedSpecSha256: edited }).comparable).toBe(true);

    // ragParity: a replay on an edited rule can still PASS row by row, and says it was not the pinned rule.
    const work = mkdtempSync(join(tmpdir(), "rag-parity-pin-"));
    for (const [tag, spec, matches] of [["edited", edited, false], ["pinned", pin, true]]) {
      const candidate = join(work, `${tag}.json`);
      writeFileSync(candidate, JSON.stringify(run(spec)));
      const parityRun = runScript(join(root, "scripts", "live", "ragParity.js"), [`--candidate=${candidate}`, "--date=2026-10-20", `--tag=${tag}`, `--out-dir=${join(work, "out")}`]);
      expect(parityRun.status, parityRun.stderr).toBe(0);
      const written = JSON.parse(readFileSync(join(work, "out", `rag_parity_2026-10-20_${tag}.json`), "utf8"));
      expect(written).toMatchObject({ verdict: "PASS", pinnedSpecSha256: pin, specMatchesPin: matches, specMatchesCandidate: matches, candidate: { specSha256: spec } });
    }
  });

  it("RS-2: labels on synthetic hits, and re-labelling the frozen baseline rows reproduces their labels and summaries", () => {
    const rice = { filename: "production_of_rice_in_2017_18.csv", chunk_index: 3 };
    const relevant = labelHit(query("A1"), "File: production_of_rice_in_2017_18.csv\nRow 25: District: Thanjavur; Total: 9", rice, 0.812345, 0);
    expect(relevant).toMatchObject({ rank: 1, filename: rice.filename, chunkIndex: 3, distance: 0.8123, fileKind: "csv_statistics", relevant: true, fileMatch: true, termsMatch: true, topical: null, headerOnly: false });
    const header = labelHit(query("A1"), "File: production_of_rice_in_2017_18.csv\nHeaders: S.No,District", rice, 0.75, 1);
    expect(header).toMatchObject({ rank: 2, relevant: false, fileMatch: true, termsMatch: false, headerOnly: true });
    const wrongFile = labelHit(query("A1"), "Row 1: District: Tanjore", { filename: "cocoa_2016_17.csv", chunk_index: 2 }, 1.1, 2);
    expect(wrongFile).toMatchObject({ relevant: false, fileMatch: false, termsMatch: true });
    // A9 needs both groups; A12 has none, so any chunk of the pest file counts.
    const a9 = labelHits(query("A9"), ["Row 9: District_Name: ERODE; Crop: Rice", "Row 10: District_Name: ERODE; Crop: Sugarcane"], [{ filename: "Tamilnadu agriculture yield data.csv" }, { source: "s3://b/Tamilnadu agriculture yield data.csv" }], [1, 1.2]);
    expect(a9.map((h) => [h.termsMatch, h.relevant])).toEqual([[false, false], [true, true]]);
    expect(labelHit(query("A12"), "File: RICE_PestPredictionKnowledgeBase.csv\nHeaders: Year", { filename: "RICE_PestPredictionKnowledgeBase.csv" }, 1)).toMatchObject({ relevant: true, headerOnly: true });
    const advisory = labelHit(query("B1"), "Row 3: Crop: Paddy", { filename: "tamil-nadu.kml" }, 1.3);
    expect(advisory).toMatchObject({ relevant: false, fileMatch: null, termsMatch: null, topical: true, fileKind: "kml_geography" });
    expect(T.thanjavur).toEqual(["thanjavur", "tanjore", "thanjavoor"]);
    // Row-text-only sensitivity: the file name in the preamble no longer counts.
    expect(rowTextOf("File: production_of_rice.csv\nTable: x\nColumns: a\nRow 1: a: 1")).toBe("Row 1: a: 1");
    const [sensitive] = labelHitsRowTextOnly(query("B1"), ["File: production_of_rice_in_2017_18.csv\nTable: production of rice\nColumns: District\nRow 1: District: Salem"], [rice], [1]);
    expect(sensitive).toEqual({ rank: 1, relevant: false, termsMatch: null, topical: false });
    expect(labelHit(query("B1"), "File: production_of_rice_in_2017_18.csv\nRow 1: District: Salem", rice, 1).topical).toBe(true);

    // Re-label the baseline: its rows store filename, chunkIndex, distance and a 160-character
    // whitespace-normalised snippet of each document.
    let exact = 0;
    for (const row of baseline.rows) {
      const item = query(row.id);
      expect(item.q).toBe(row.query);
      expect(item.kind).toBe(row.kind);
      const again = labelHits(item, row.hits.map((h) => h.snippet), row.hits.map((h) => ({ filename: h.filename, chunk_index: h.chunkIndex })), row.hits.map((h) => h.distance));
      row.hits.forEach((hit, i) => {
        const got = again[i];
        expect({ rank: got.rank, filename: got.filename, chunkIndex: got.chunkIndex, distance: got.distance, fileKind: got.fileKind, fileMatch: got.fileMatch, snippet: got.snippet })
          .toEqual({ rank: hit.rank, filename: hit.filename, chunkIndex: hit.chunkIndex, distance: hit.distance, fileKind: hit.fileKind, fileMatch: hit.fileMatch, snippet: hit.snippet });
        if (hit.snippet.length < 160) {
          // The snippet is the whole document: every label must match exactly.
          exact += 1;
          expect({ relevant: got.relevant, termsMatch: got.termsMatch, topical: got.topical, headerOnly: got.headerOnly }).toEqual({ relevant: hit.relevant, termsMatch: hit.termsMatch, topical: hit.topical, headerOnly: hit.headerOnly });
        } else {
          // A prefix: a term found in it is in the document, and a Row line in it rules out headerOnly.
          for (const label of ["relevant", "termsMatch", "topical"]) if (got[label] === true) expect(hit[label], `${row.id} rank ${hit.rank} ${label}`).toBe(true);
          if (got.headerOnly === false) expect(hit.headerOnly).toBe(false);
          if (hit.headerOnly === true) expect(got.headerOnly).toBe(true);
        }
      });
    }
    expect(exact).toBeGreaterThan(0);
    expect(summarizeRows(baseline.rows, 3)).toEqual(baseline.summaryAtProductionTopK);
    expect(summarizeRows(baseline.rows, 5)).toEqual(baseline.summaryAtK5);

    // The parity comparator accepts the baseline itself and pinpoints a changed row.
    expect(compareRuns(baseline, baseline)).toMatchObject({ pass: true, diffs: [] });
    const drifted = structuredClone(baseline);
    drifted.rows[1].hits[2].distance += 0.01;
    const report = compareRuns(baseline, drifted);
    expect(report.pass).toBe(false);
    expect(report.diffs).toEqual([expect.objectContaining({ id: baseline.rows[1].id, rank: 3, field: "distance" })]);
  });

  const history = gitHistoryAvailable("6dbe6b8");

  it.skipIf(!history.available)("RS-3: the pins match the blocks in git history at 6dbe6b8 (skipped on a shallow clone)", () => {
    const report = verifyRagSpec({ useGit: true });
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ ok: true, git: { available: true, checked: true } });
    for (const block of report.blocks) expect(block).toMatchObject({ ok: true, spec: block.pinned, git: block.pinned });
  });
});
