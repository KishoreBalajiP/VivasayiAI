import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ResultExistsError, writeJsonOnce, writeResultOnce } from "../scripts/live/lib/writeOnce.js";
import { bibStats } from "../scripts/eval/bibStats.js";
import { computeNumbers, crossCheckStudyDefaults, loadStudyDefaults, renderNumbersTex, renderTables } from "../scripts/eval/manuscriptTables.js";
import {
  checkFrozenHashes,
  checkLedger,
  checkPdfFreshness,
  findNumberLiterals,
  findUsedMacros,
  parseNumbersTex,
  runChecks,
  unconfirmedLedgerRows,
} from "../scripts/eval/checkManuscriptNumbers.js";
import {
  buildProvenance,
  CONFIG_SNAPSHOT_KEYS,
  outputPath,
  summarizeRun,
} from "../scripts/live/satelliteCaseStudies.js";
import { resolveSatelliteConfig, SATELLITE_ADAPTER_VERSION } from "../services/satellite/config.js";
import { EVALSCRIPT_HASH } from "../services/satellite/ndviStatistics.js";
import { POLICY_IDS, resolvePolicy } from "../config/verificationPolicy.js";

// Research integrity: dated results are write-once and pinned by hash, every prose number in the
// manuscript is generated and traceable, and the satellite case-study script records its provenance
// without secrets. Nothing here calls a live provider; the satellite tests use a stubbed run.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "vivasayi-research-integrity-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const LIVE_SCRIPTS = [
  "scripts/live/satelliteCaseStudies.js",
  "scripts/live/localAcceptance.js",
  "scripts/live/checkProviders.js",
  "scripts/live/chatContext.live.js",
  "scripts/live/landDocExtraction.live.js",
  "scripts/live/liveSummary.js",
];

describe("write-once results", () => {
  it("LW-1: writeResultOnce creates the file once and refuses to overwrite it", () => {
    const path = join(scratch, "nested", "dir", "result_2026-10-16.json");
    writeJsonOnce(path, { run: 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ run: 1 });

    let thrown = null;
    try {
      writeJsonOnce(path, { run: 2 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResultExistsError);
    expect(thrown.exitCode).toBe(2);
    expect(thrown.path).toBe(path);
    expect(() => writeResultOnce(path, "replacement")).toThrow(ResultExistsError);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ run: 1 });
  });

  it("LW-2: every owned live script writes its results write-once and no longer hard-codes a date", () => {
    for (const rel of LIVE_SCRIPTS) {
      const source = read(rel);
      expect(source, rel).toMatch(/from "\.\/lib\/writeOnce\.js"/);
      expect(source, rel).toMatch(/write(Result|Json)Once\(/);
      // Plain writes remain only for a run's own progress file and for rendered input images.
      const plainWrites = [...source.matchAll(/writeFileSync\(([^,]+),/g)].map((m) => m[1].trim());
      for (const target of plainWrites) expect(["partialPath", "join(saveImages"], `${rel}: writeFileSync(${target}, ...)`).toContain(target.startsWith("join(saveImages") ? "join(saveImages" : target);
    }
    // Scripts that call providers check for an existing result before the first call.
    for (const rel of LIVE_SCRIPTS.filter((r) => !r.endsWith("liveSummary.js"))) {
      expect(read(rel), rel).toMatch(/existsSync\([^)]*\)[\s\S]{0,40}ResultExistsError|if \(existsSync\(outFile\)\)/);
    }
    const acceptance = read("scripts/live/localAcceptance.js");
    expect(acceptance).not.toMatch(/2026-10-16/);
    expect(acceptance).toMatch(/arg\("date"\)/);
    expect(acceptance).toMatch(/arg\("tag"\)/);
    expect(outputPath({ date: "2026-10-16" })).toMatch(/satellite_case_studies_2026-10-16\.json$/);
    expect(outputPath({ date: "2026-11-01", tag: "provenance" })).toMatch(/satellite_case_studies_2026-11-01_provenance\.json$/);

    // liveSummary.js makes no provider calls, so it can run: an existing summary is refused, unchanged.
    const summary = join(root, "docs", "research", "evaluation", "live", "SUMMARY_2026-10-16.md");
    const before = sha256(summary);
    const run = spawnSync(process.execPath, ["scripts/live/liveSummary.js", "--date=2026-10-16"], { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/Refusing to overwrite/);
    expect(sha256(summary)).toBe(before);
  });
});

describe("frozen 16 October 2026 results", () => {
  it("FH-1: every pinned result file still has its recorded SHA-256", () => {
    const frozen = JSON.parse(read("docs/research/evaluation/live/FROZEN_HASHES.json"));
    expect(frozen.algorithm).toBe("sha256");
    const required = [
      "rag_retrieval_2026-10-16.json",
      "rag_retrieval_2026-10-16.md",
      "satellite_case_studies_2026-10-16.json",
      "acceptance_v1-legacy_2026-10-16.json",
      "acceptance_v2-components_2026-10-16.json",
      "live_eval_status_2026-10-16.json",
      "study_code_defaults_2026-10-16.json",
    ].map((name) => `docs/research/evaluation/live/${name}`);
    for (const path of required) expect(Object.keys(frozen.files)).toContain(path);
    for (const [path, expected] of Object.entries(frozen.files)) {
      expect(existsSync(join(root, path)), path).toBe(true);
      expect(sha256(join(root, path)), path).toBe(expected);
    }
    expect(checkFrozenHashes(frozen)).toEqual([]);
    const tampered = { files: { [required[0]]: "0".repeat(64) } };
    expect(checkFrozenHashes(tampered)[0]).toMatch(/changed/);
  });
});

describe("manuscript numbers", () => {
  const allowlist = JSON.parse(read("docs/research/manuscript/number_allowlist.json")).entries;

  it("MN-1: the checker finds stray number literals and ignores comments, references and allow-listed names", () => {
    const fixture = [
      "\\documentclass[journal]{IEEEtran}",
      "\\usepackage[utf8]{inputenc}",
      "\\input{generated_numbers}",
      "% a comment with 99 is ignored",
      "Sentinel-2 L2A as in \\cite{ursu2025,okeyo2020} and Section~\\ref{sec:a1}\\label{tab:x2}.",
      "We ran \\SatLiveSquares{} squares; one paragraph still says 12 squares, 0.15 and 1,536.",
      "Escaped percent 5\\% is a number too.",
    ].join("\n");
    const found = findNumberLiterals(fixture, allowlist);
    expect(found.map((f) => f.literal)).toEqual(["12", "0.15", "1,536", "5"]);
    expect(found[0].line).toBe(6);
    expect(found[3].line).toBe(7);
    expect(findNumberLiterals("floods of 17--18\nDecember 2023 near", allowlist)).toEqual([]);

    // The real manuscript has no literal outside macros and the justified allowlist.
    const main = read("docs/research/manuscript/main.tex");
    expect(findNumberLiterals(main, allowlist)).toEqual([]);
    for (const entry of allowlist) expect(String(entry.justification || "").trim().length, entry.text).toBeGreaterThan(20);
  });

  it("MN-2: every macro main.tex uses is defined, sourced and identical in the .tex and .json outputs", () => {
    const main = read("docs/research/manuscript/main.tex");
    expect(main).toMatch(/\\input\{generated_numbers\}/);
    const defined = parseNumbersTex(read("docs/research/manuscript/generated_numbers.tex"));
    const json = JSON.parse(read("docs/research/manuscript/generated_numbers.json"));
    const used = findUsedMacros(main);
    expect(used.length).toBeGreaterThan(40);
    for (const macro of used) expect(defined, `\\${macro}`).toHaveProperty(macro);
    expect(Object.keys(json).sort()).toEqual(Object.keys(defined).sort());
    for (const [macro, entry] of Object.entries(json)) {
      expect(macro).toMatch(/^[A-Za-z]+$/);
      expect(entry.value).toBe(defined[macro]);
      for (const field of ["source", "pointer", "formatter"]) expect(String(entry[field] || ""), `${macro}.${field}`).not.toBe("");
      const file = entry.source.replace(/ at commit \w+$/, "");
      expect(existsSync(join(root, file)), `${macro} source ${file}`).toBe(true);
    }
  });

  it("MN-3: the generated numbers and tables are not stale and trace to their sources", async () => {
    const fresh = await computeNumbers();
    const json = JSON.parse(read("docs/research/manuscript/generated_numbers.json"));
    expect(Object.fromEntries(fresh.map((e) => [e.macro, e.value]))).toEqual(Object.fromEntries(Object.entries(json).map(([m, e]) => [m, e.value])));
    expect(renderNumbersTex(fresh)).toBe(read("docs/research/manuscript/generated_numbers.tex"));
    expect(renderTables()).toBe(read("docs/research/manuscript/generated_tables.tex"));
    expect(read("docs/research/manuscript/generated_tables.tex").split("\n")[0]).toMatch(/results\/\*\.json.*live\/\*\.json/);

    const value = (macro) => fresh.find((e) => e.macro === macro).value;
    const fusion = JSON.parse(read("docs/research/evaluation/results/fusion.json"));
    expect(value("FusionLegacyInvalidApprovals")).toBe(String(fusion.policies["photo-only (v1-legacy)"].invalidApprovalRate.k));
    const rag = JSON.parse(read("docs/research/evaluation/live/rag_retrieval_2026-10-16.json"));
    expect(value("RagAnswerableRelevantHits")).toBe(String(rag.summaryAtProductionTopK.answerable.hitRateAnyRelevant.k));
    const satellite = resolvePolicy("v1-legacy").satellite;
    expect(value("SatNdviDropSupport")).toBe(satellite.ndviDropSupport.toFixed(2));
    expect(value("SatPreWindowFarDays")).toBe(String(satellite.preWindowDays[0]));
    expect(value("SatSceneCloudMaxPercent")).toBe(String(Math.round(resolveSatelliteConfig({}).cloudMaxFraction * 100)));
    // The disclosure quotes the limit in force during the study (config/env.js at 6dbe6b8), not a later default.
    expect(value("ClaimWritesPerHourAtStudyWord")).toBe("five");
    expect(value("BibEntries")).toBe(String(bibStats().entries));
    expect([value("GapFirstPassVerified"), value("GapFirstPassWeb"), value("GapSecondPassAdded")]).toEqual(["45", "3", "26"]);

    const { errors } = await runChecks({ checkPdf: false });
    expect(errors).toEqual([]);
  });

  it("MN-3: study-time values come from the pinned record, so the check works without the git history", async () => {
    const record = JSON.parse(read("docs/research/evaluation/live/study_code_defaults_2026-10-16.json"));
    expect(record.studyCommit).toMatch(/^6dbe6b8[0-9a-f]{33}$/);
    expect(loadStudyDefaults(record)).toEqual({ CLAIM_RATE_LIMIT_MAX: 5, GEMINI_TIMEOUT_MS: 25000, SATELLITE_CLOUD_MAX: 0.3, SATELLITE_PROCESSING_SCENE_CLOUD_MAX: 0.9 });
    const json = JSON.parse(read("docs/research/manuscript/generated_numbers.json"));
    expect(json.ClaimWritesPerHourAtStudyWord.source).toBe("docs/research/evaluation/live/study_code_defaults_2026-10-16.json");

    // A shallow clone or a copy without .git: `git show` finds nothing. Not an error, same numbers.
    const noGit = () => null;
    expect(crossCheckStudyDefaults({ record, show: noGit })).toEqual({ checked: false, mismatches: [] });
    const withoutGit = await computeNumbers({ show: noGit });
    expect(Object.fromEntries(withoutGit.map((e) => [e.macro, e.value]))).toEqual(Object.fromEntries(Object.entries(json).map(([m, e]) => [m, e.value])));

    // When the commit is reachable, the record must agree with the code there (whichever applies here).
    expect(crossCheckStudyDefaults().mismatches).toEqual([]);
    const sources = {
      "config/env.js": "  claimRateLimitMax: Number(process.env.CLAIM_RATE_LIMIT_MAX) || 5,",
      "utils/aiTimeout.js": "  Number(process.env.GEMINI_TIMEOUT_MS) || 25000;",
      "services/satellite/config.js": 'pickFloat(env, ["SATELLITE_CLOUD_MAX", "SATELLITE_POC_CLOUD_MAX"], 0.3),\npickFloat(env, ["SATELLITE_PROCESSING_SCENE_CLOUD_MAX"], 0.9),',
    };
    const show = (spec) => sources[spec.slice(spec.indexOf(":") + 1)] ?? null;
    expect(crossCheckStudyDefaults({ record, show })).toEqual({ checked: true, mismatches: [] });
    const edited = (spec) => show(spec)?.replace("|| 5,", "|| 15,") ?? null;
    expect(crossCheckStudyDefaults({ record, show: edited }).mismatches).toEqual([
      "CLAIM_RATE_LIMIT_MAX: 5 in docs/research/evaluation/live/study_code_defaults_2026-10-16.json, 15 in config/env.js at 6dbe6b8",
    ]);
    await expect(computeNumbers({ show: edited })).rejects.toThrow(/disagrees with the code at 6dbe6b8/);
  });

  it("MN-4: a stale PDF, an incomplete source ledger and a broken allowlist entry are reported", () => {
    const pdf = join(scratch, "main.pdf");
    const tex = join(scratch, "main.tex");
    writeFileSync(pdf, "pdf");
    writeFileSync(tex, "tex");
    utimesSync(pdf, new Date("2026-10-16T10:00:00Z"), new Date("2026-10-16T10:00:00Z"));
    utimesSync(tex, new Date("2026-10-16T11:00:00Z"), new Date("2026-10-16T11:00:00Z"));
    expect(checkPdfFreshness({ pdfPath: pdf, sourcePaths: [tex] })[0]).toMatch(/stale PDF/);
    utimesSync(pdf, new Date("2026-10-16T12:00:00Z"), new Date("2026-10-16T12:00:00Z"));
    expect(checkPdfFreshness({ pdfPath: pdf, sourcePaths: [tex] })).toEqual([]);
    expect(checkPdfFreshness({ pdfPath: join(scratch, "missing.pdf"), sourcePaths: [tex] })[0]).toMatch(/does not exist/);

    const ledger = JSON.parse(read("docs/research/source_ledger.json"));
    const inputs = { stats: bibStats(), researchGapText: read("docs/research/research_gap.md"), literatureReviewText: read("docs/research/literature_review.md") };
    expect(checkLedger({ ledger, ...inputs })).toEqual([]);
    const allowed = new Set(Object.keys(ledger.levels));
    for (const entry of ledger.entries) {
      expect(allowed.has(entry.verification), entry.key).toBe(true);
      expect(typeof entry.confirmedByAuthor, entry.key).toBe("boolean");
    }
    // The author confirming a row is progress, not an error; an unstated confirmation is an error.
    const confirmed = { ...ledger, entries: ledger.entries.map((e, i) => (i === 0 ? { ...e, confirmedByAuthor: true } : e)) };
    expect(checkLedger({ ledger: confirmed, ...inputs })).toEqual([]);
    expect(unconfirmedLedgerRows(confirmed)).toHaveLength(unconfirmedLedgerRows(ledger).length - (ledger.entries[0].confirmedByAuthor ? 0 : 1));
    const unstated = { ...ledger, entries: ledger.entries.map((e, i) => (i === 0 ? { ...e, confirmedByAuthor: "yes" } : e)) };
    expect(checkLedger({ ledger: unstated, ...inputs }).join("\n")).toMatch(/confirmedByAuthor must be true or false/);
    const missing = { ...ledger, entries: ledger.entries.slice(1) };
    expect(checkLedger({ ledger: missing, ...inputs }).join("\n")).toMatch(/no entry for bib key/);
    const moved = { ...ledger, entries: ledger.entries.map((e, i) => (i === 0 ? { ...e, pass: 2 } : e)) };
    expect(checkLedger({ ledger: moved, ...inputs }).join("\n")).toMatch(/verified sources|second-pass/);

    // An allow-listed phrase only hides exactly that phrase.
    expect(findNumberLiterals("Sentinel-3 and Sentinel-2", [{ text: "Sentinel-2", justification: "mission name" }]).map((f) => f.literal)).toEqual(["3"]);
  });
});

describe("satellite case-study provenance (stubbed run, no provider call)", () => {
  const preWindow = { start: "2023-11-08T00:00:00.000Z", end: "2023-12-13T00:00:00.000Z" };
  const postWindow = { start: "2023-12-19T00:00:00.000Z", end: "2024-01-07T00:00:00.000Z" };
  const scene = (id, window, cloud) => ({ sceneId: id, acquisitionTime: `${window.start.slice(0, 10)}T05:00:00Z`, cloudCoverFraction: cloud, queryWindow: window });
  const stubRun = (discovery) => ({
    outcome: "ANALYSIS_COMPLETE",
    evidenceStatus: "AVAILABLE",
    processingStatus: "COMPLETED",
    requestCount: 5,
    discovery,
    analysis: {
      method: "per-pixel-mean-scl-masked",
      evalscriptHash: EVALSCRIPT_HASH,
      before: { ndvi: 0.61, validPixelFraction: 1 },
      after: { ndvi: 0.59, validPixelFraction: 1 },
      deltaNdvi: -0.02,
      analysisOutcome: "NO_CHANGE",
      interpretationReasons: ["no_ndvi_drop_beyond_threshold"],
      thresholds: { minValidPixelFraction: 0.6, ndviDropSupport: 0.15 },
    },
    notes: ["n1", "n2", "n3", "n4", "n5"],
  });
  const secretEnv = {
    CDSE_CLIENT_ID: "client-id-do-not-record-123",
    CDSE_CLIENT_SECRET: "client-secret-do-not-record-456",
    SATELLITE_PROCESSING_ENABLED: "true",
  };

  it("SC-1: the record carries a full provenance block and per-case thresholds, notes and scenes per window", () => {
    // Adapter 13.3.0 shape: discovery.scenes holds only the pre-event search, sceneCount counts both.
    const legacy = summarizeRun(stubRun({ sceneCount: 3, scenes: [scene("A", preWindow, 0.8), scene("B", preWindow, 0.53)] }), { windows: { preWindow, postWindow }, maxScenes: 2 });
    expect(legacy).toMatchObject({ outcome: "ANALYSIS_COMPLETE", scenes: 3, sceneCloudFractions: [0.8, 0.53], requestCount: 5 });
    expect(legacy.notes).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(legacy.analysis.thresholds).toEqual({ minValidPixelFraction: 0.6, ndviDropSupport: 0.15 });
    expect(legacy.analysis.evalscriptHash).toBe(EVALSCRIPT_HASH);
    expect(legacy.scenesByWindowSource).toBe("derived_from_discovery_scenes_incomplete");
    expect(legacy.scenesByWindow.pre).toEqual([
      { id: "A", datetime: "2023-11-08T05:00:00Z", cloudCoverFraction: 0.8 },
      { id: "B", datetime: "2023-11-08T05:00:00Z", cloudCoverFraction: 0.53 },
    ]);
    expect(legacy.scenesByWindow.post).toBeNull();
    expect(legacy.sceneCapReached).toEqual({ maxScenes: 2, pre: true, post: null });

    // Adapter with discovery.scenesByWindow = { pre: [...], post: [...] } (plan Part D, PC-7).
    const byWindow = { pre: [scene("A", preWindow, 0.8)], post: [scene("C", postWindow, 0.2), scene("D", postWindow, null)] };
    const current = summarizeRun(stubRun({ sceneCount: 3, scenes: byWindow.pre, scenesByWindow: byWindow }), { windows: { preWindow, postWindow }, maxScenes: 2 });
    expect(current.scenesByWindowSource).toBe("adapter");
    expect(current.scenesByWindow.pre).toEqual([{ id: "A", datetime: "2023-11-08T05:00:00Z", cloudCoverFraction: 0.8 }]);
    expect(current.scenesByWindow.post).toEqual([
      { id: "C", datetime: "2023-12-19T05:00:00Z", cloudCoverFraction: 0.2 },
      { id: "D", datetime: "2023-12-19T05:00:00Z", cloudCoverFraction: null },
    ]);
    expect(current.sceneCapReached).toEqual({ maxScenes: 2, pre: false, post: true });
    // Any other shape is not guessed at: the post-event window stays "not recorded".
    for (const odd of [[byWindow.pre, byWindow.post], { before: byWindow.pre, after: byWindow.post }]) {
      const ignored = summarizeRun(stubRun({ sceneCount: 3, scenes: byWindow.pre, scenesByWindow: odd }), { windows: { preWindow, postWindow }, maxScenes: 2 });
      expect(ignored.scenesByWindowSource).toBe("derived_from_discovery_scenes_incomplete");
      expect(ignored.scenesByWindow.post).toBeNull();
    }

    const policy = resolvePolicy("v1-legacy");
    const provenance = buildProvenance({
      runStartedAt: "2026-10-16T10:00:00.000Z",
      runFinishedAt: "2026-10-16T10:02:00.000Z",
      git: { commit: "6dbe6b8497cedef558fb912072787935d5565d19", dirty: true, diffSha256: "a".repeat(64) },
      policy,
      config: resolveSatelliteConfig({}),
    });
    expect(provenance).toMatchObject({
      schema: "satellite-case-studies-provenance/v1",
      recordedAtRunTime: true,
      runStartedAt: "2026-10-16T10:00:00.000Z",
      runFinishedAt: "2026-10-16T10:02:00.000Z",
      commit: "6dbe6b8497cedef558fb912072787935d5565d19",
      dirty: true,
      node: process.version,
      adapterVersion: SATELLITE_ADAPTER_VERSION,
      evalscriptHash: EVALSCRIPT_HASH,
      policy: { id: "v1-legacy", hash: policy.hash },
    });
    expect(Object.keys(provenance.config)).toEqual([...CONFIG_SNAPSHOT_KEYS]);
    expect(provenance.config).toMatchObject({ maxScenes: 10, cloudMaxFraction: 0.3, processingSceneCloudMax: 0.9 });
  });

  it("SC-2: neither the provenance block nor a case records a credential or token", () => {
    const config = resolveSatelliteConfig(secretEnv);
    expect(config.clientSecret).toBe(secretEnv.CDSE_CLIENT_SECRET);
    const provenance = buildProvenance({ runStartedAt: "t0", runFinishedAt: "t1", policy: resolvePolicy("v2-components"), config: { ...config, accessToken: "token-do-not-record-789" } });
    const record = { provenance, cases: [summarizeRun(stubRun({ sceneCount: 1, scenes: [scene("A", preWindow, 0.4)] }), { windows: { preWindow, postWindow }, maxScenes: config.maxScenes })] };
    const text = JSON.stringify(record);
    for (const secret of [secretEnv.CDSE_CLIENT_ID, secretEnv.CDSE_CLIENT_SECRET, "token-do-not-record-789"]) expect(text).not.toContain(secret);
    const keys = [];
    const walk = (value) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner); }
    };
    walk(record);
    expect(keys.filter((key) => /secret|token|clientid|password|apikey/i.test(key))).toEqual([]);
    expect(provenance.config.hasCredentials).toBe(true);
  });

  it("SC-3: the recorded thresholds and windows are the policy's own values, read and never overridden", () => {
    for (const id of POLICY_IDS) {
      const policy = resolvePolicy(id);
      const provenance = buildProvenance({ runStartedAt: "t0", runFinishedAt: "t1", policy, config: resolveSatelliteConfig({}) });
      expect(provenance.thresholds).toEqual({
        minValidPixelFraction: policy.satellite.minValidPixelFraction,
        ndviDropSupport: policy.satellite.ndviDropSupport,
        maxCloudFraction: policy.satellite.maxCloudFraction,
      });
      expect(provenance.windows).toEqual({ preWindowDays: policy.satellite.preWindowDays, postWindowDays: policy.satellite.postWindowDays });
      // The provisional values the 16 October 2026 study used (see the provenance sidecar).
      expect(provenance.thresholds).toMatchObject({ minValidPixelFraction: 0.6, ndviDropSupport: 0.15 });
      expect(provenance.windows).toEqual({ preWindowDays: [40, 5], postWindowDays: [1, 20] });
    }
    // A case keeps the thresholds the adapter actually applied, unchanged.
    const applied = { minValidPixelFraction: 0.6, ndviDropSupport: 0.15 };
    const run = stubRun({ sceneCount: 1, scenes: [] });
    expect(summarizeRun(run).analysis.thresholds).toEqual(applied);
    expect(run.analysis.thresholds).toEqual(applied);
  });
});
