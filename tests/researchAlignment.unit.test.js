import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_PATH,
  computeSafeAiRow,
  PUBLISHED_FLIP_LABELS,
  PUBLISHED_LABELS,
  publishedRowDifferences,
  runFusionEvaluation,
  SAFE_AI_LABEL,
} from "../scripts/eval/fusion.eval.js";
import { checkPdfFreshness, findNumberLiterals, findUsedMacros, parseNumbersTex, stripComments } from "../scripts/eval/checkManuscriptNumbers.js";
import { POLICY_IDS } from "../config/verificationPolicy.js";

// Research alignment with ADR-022 (owner decisions D1, D2, D5) and the IEEE Access port.
//   EV-16  the published fusion rows reproduce byte for byte; the v1.1-safe-ai row is computed, not assumed.
//   RA-*   the manuscript describes the three policies, and main-access.tex (IEEE Access) is the same
//          text as main.tex with every macro defined and no untraceable number.
// Nothing here calls a provider or the network, and nothing is written.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const MANUSCRIPT = "docs/research/manuscript";
const SAFE_AI_PATH = "docs/research/evaluation/results/fusion_v1.1_2026-10-16.json";

// The committed baseline: the blob at HEAD when git has it, else the working-tree file (a copy without
// .git). EV-16 is about the PUBLISHED rows, so a later local `npm run eval` cannot move the reference.
const committedBaseline = () => {
  try {
    return { source: "HEAD", text: execSync(`git show HEAD:${BASELINE_PATH}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString() };
  } catch {
    return { source: "working tree", text: read(BASELINE_PATH) };
  }
};

const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
};

const mainTex = read(`${MANUSCRIPT}/main.tex`);
const accessTex = read(`${MANUSCRIPT}/main-access.tex`);
const defined = parseNumbersTex(read(`${MANUSCRIPT}/generated_numbers.tex`));
const allowlist = JSON.parse(read(`${MANUSCRIPT}/number_allowlist.json`)).entries;

describe("fusion benchmark: v1.1-safe-ai row", () => {
  it("EV-16: the published v1-legacy, v2 and ablation rows (and their satellite/weather comparisons) are byte-identical to the committed results", () => {
    const baseline = committedBaseline();
    const committed = JSON.parse(baseline.text);
    const current = runFusionEvaluation();
    expect(Object.keys(committed.policies)).toEqual([...PUBLISHED_LABELS]);
    // The published rows keep their order; v1.1 is appended after them.
    expect(Object.keys(current.policies)).toEqual([...PUBLISHED_LABELS, SAFE_AI_LABEL]);
    for (const label of PUBLISHED_LABELS) {
      expect(JSON.stringify(current.policies[label], null, 2), `${label} (vs ${baseline.source})`).toBe(JSON.stringify(committed.policies[label], null, 2));
    }
    for (const label of PUBLISHED_FLIP_LABELS) {
      expect(JSON.stringify(current.supportingEvidenceChangedOutcome[label], null, 2), label).toBe(JSON.stringify(committed.supportingEvidenceChangedOutcome[label], null, 2));
    }
    expect(current.scenarioFactors).toEqual(committed.scenarioFactors);
    expect(publishedRowDifferences(committed, current)).toEqual([]);
  });

  it("EV-16: the dated v1.1-safe-ai file is what the code computes, and its findings are the ones the manuscript states", () => {
    const file = JSON.parse(read(SAFE_AI_PATH));
    const baseline = JSON.parse(committedBaseline().text);
    const recomputed = computeSafeAiRow({ baseline });
    const { environment, ...content } = file;
    expect(environment.date).toBe("2026-10-16");
    // The baseline hash names the file the row was computed against: the committed fusion.json.
    expect(content.baseline.sha256).toBe(createHash("sha256").update(committedBaseline().text).digest("hex"));
    expect({ ...content, baseline: { ...content.baseline, sha256: null } }).toEqual({ ...recomputed, baseline: { ...recomputed.baseline, sha256: null } });

    const legacy = baseline.policies["photo-only (v1-legacy)"];
    expect(file.policy.id).toBe("v1.1-safe-ai");
    expect(file.baseline.publishedRowsReproduced).toBe(true);
    // Computed, not assumed: v1.1 keeps v1-legacy's invalid approvals and rejects nothing on the AI alone.
    expect(file.row.invalidApprovalRate.k).toBe(legacy.invalidApprovalRate.k);
    expect(file.row.invalidApprovalRate.n).toBe(legacy.invalidApprovalRate.n);
    expect(file.comparedWithLegacy.invalidApprovals.reduced).toBe(false);
    expect(file.row.adverseOnAiAlone.k).toBe(0);
    expect(legacy.adverseOnAiAlone.k).toBe(legacy.adverseOnAiAlone.n);
    expect(Object.keys(file.comparedWithLegacy.decisionsChanged)).toEqual(["rejected/decide -> null/hold"]);
    expect(file.comparedWithLegacy.decisionsChanged["rejected/decide -> null/hold"]).toBe(file.row.heldForReview);
    expect(file.comparedWithLegacy.decisionsUnchanged + file.row.heldForReview).toBe(file.scenarioFactors.total);
    // Satellite and weather change no outcome and no hold under v1.1 (D1).
    expect(file.supportingEvidenceChangedOutcome.k).toBe(0);
    expect(file.supportingEvidenceChangedOutcomeOrDisposition.k).toBe(0);
    expect(file.supportingEvidenceChangedOutcome.n).toBe(baseline.supportingEvidenceChangedOutcome["photo-only (v1-legacy)"].n);
  });

  it("EV-16: the manuscript table lists the v1.1-safe-ai row from the dated file", () => {
    const { row, label } = JSON.parse(read(SAFE_AI_PATH));
    const tables = read(`${MANUSCRIPT}/generated_tables.tex`);
    const texLabel = label.replace(/_/g, "\\_");
    expect(tables).toContain(`${texLabel} & ${row.invalidApprovalRate.k}/${row.invalidApprovalRate.n} & ${row.adverseOnAiAlone.k}/${row.adverseOnAiAlone.n} & ${row.heldForReview} \\\\`);
    expect(tables.split(texLabel).length - 1).toBe(1);
  });
});

describe("manuscript alignment with ADR-022", () => {
  it("RA-1: main.tex describes all three policies by their identifiers, with v1.1-safe-ai as the default as of the change", () => {
    const prose = stripComments(mainTex);
    expect(POLICY_IDS).toEqual(expect.arrayContaining(["v1-legacy", "v1.1-safe-ai", "v2-components"]));
    for (const id of POLICY_IDS) expect(prose, id).toContain(`\\texttt{${id}}`);
    expect(prose).toMatch(/\\texttt\{v1\.1-safe-ai\}, the default as of the change of \\PolicySafeAiDate\{\}/);
    expect(prose).toMatch(/\\texttt\{v2-components\}[^]*?evaluated but is not the default/);
    expect(prose).toMatch(/\\texttt\{v1-legacy\}, the historical behaviour/);
    expect(defined.PolicyCountWord).toBe("three");
    expect(defined.PolicySafeAiDate).toBe("16 October 2026");
  });

  it("RA-2: provider-failure statements are policy-specific, timing is described, and v1.1 is not credited with fewer invalid approvals", () => {
    const prose = stripComments(mainTex);
    expect(prose).not.toMatch(/never reads a provider failure as a negative finding/);
    expect(prose).toMatch(/Under \\texttt\{v1-legacy\} and \\texttt\{v2-components\} an unreadable model answer returns the claim to the farmer for more evidence/);
    expect(prose).toMatch(/\\textbf\{Timing\.\}/);
    expect(prose).toMatch(/never blocks or changes a decision under any policy/);
    expect(prose).toMatch(/first submission/);
    expect(prose).toMatch(/does not reduce invalid approvals relative to \\texttt\{v1-legacy\}/);
    // The write budget keeps the study-time value and adds today's default (D5).
    expect(prose).toMatch(/\\ClaimWritesPerHourAtStudyWord\{\} claim writes per hour in force during the study/);
    expect(prose).toMatch(/\\ClaimWritesPerHourWord\{\} claim writes and \\EvidenceRequestsPerHour\{\} evidence requests/);
    expect([defined.ClaimWritesPerHourAtStudyWord, defined.ClaimWritesPerHourWord, defined.EvidenceRequestsPerHour]).toEqual(["five", "fifteen", "60"]);
    // Queue, worker and tracker are described as implemented and tested, and not deployed.
    expect(prose).toMatch(/implemented and covered by unit and integration tests\. None is deployed/);
  });
});

describe("IEEE Access port (main-access.tex)", () => {
  const usedIn = (tex) => findUsedMacros(tex).filter((macro) => macro !== "DeclareFontShape");

  it("RA-3: every macro main-access.tex uses is defined in generated_numbers.tex, and it uses the same macros as main.tex", () => {
    expect(accessTex).toMatch(/\\input\{generated_numbers\}/);
    expect(accessTex).toMatch(/\\input\{generated_tables\}/);
    expect(accessTex).toMatch(/\\bibliography\{\.\.\/references\}/);
    const used = usedIn(accessTex);
    expect(used.length).toBeGreaterThan(40);
    expect(used.filter((macro) => !(macro in defined))).toEqual([]);
    expect([...used].sort()).toEqual([...usedIn(mainTex)].sort());
  });

  it("RA-4: the abstract and body are main.tex's, apart from the template's drop cap, and contain no untraceable number", () => {
    const shared = (tex) => {
      const abstract = between(tex, "\\begin{abstract}", "\\end{abstract}");
      const body = between(tex, "\\section{Introduction}", "\\bibliographystyle{IEEEtran}").replace(/\\PARstart\{(\w)\}\{(\w+)\}/, "$1$2");
      return { abstract, body };
    };
    expect(shared(accessTex)).toEqual(shared(mainTex));
    // Everything except the template's own front-matter fields (\authorrefmark{1}, \address[1],
    // \titlepgskip=-21pt), which are layout, not prose.
    const prose = [
      between(accessTex, "\\begin{abstract}", "\\end{abstract}"),
      between(accessTex, "\\begin{keywords}", "\\end{keywords}"),
      accessTex.slice(accessTex.indexOf("\\maketitle")),
    ].join("\n");
    expect(findNumberLiterals(prose, allowlist)).toEqual([]);
    // The front matter itself has only those layout numbers.
    const front = accessTex.slice(accessTex.indexOf("\\begin{document}"), accessTex.indexOf("\\begin{abstract}"));
    expect(findNumberLiterals(front, allowlist).map((found) => found.literal)).toEqual(["1", "1"]);
  });

  it("RA-5: the abstract fits the template's 150-250 words once the macros are expanded", () => {
    const abstract = between(accessTex, "\\begin{abstract}", "\\end{abstract}").replace("\\begin{abstract}", "");
    const expanded = abstract
      .replace(/\\([A-Za-z]+)\{\}/g, (match, name) => (name in defined ? defined[name] : match))
      .replace(/\\emph\{/g, "")
      .replace(/[{}]/g, " ");
    const words = expanded.split(/\s+/).filter(Boolean);
    expect(expanded).not.toMatch(/\\[A-Z][a-z]+[A-Z]/);
    expect(words.length).toBeGreaterThanOrEqual(150);
    expect(words.length).toBeLessThanOrEqual(250);
  });

  it("RA-6: the port is marked NOT SUBMISSION-READY in its header and in the README, with every blocker", () => {
    const header = accessTex.slice(0, accessTex.indexOf("\\documentclass"));
    expect(header).toMatch(/NOT SUBMISSION-READY/);
    expect(accessTex).toMatch(/\\documentclass\{ieeeaccess\}/);
    expect(accessTex).toMatch(/\\begin\{IEEEbiographynophoto\}/);
    expect(accessTex).toMatch(/\\EOD/);
    const readme = read(`${MANUSCRIPT}/README.md`);
    const section = between(readme, "## NOT SUBMISSION-READY", "\n## ");
    for (const blocker of [/biograph/i, /BLOCKED/, /billed Gemini key/, /Expert-rated chat answers/i, /No real-claim data/i, /RAG before\/after table/, /Tamil copy unreviewed/i]) {
      expect(section, String(blocker)).toMatch(blocker);
      expect(header, String(blocker)).toMatch(new RegExp(blocker.source.replace("No real-claim data", "no real-claim data").replace("Tamil copy unreviewed", "Tamil copy"), "i"));
    }
  });

  it("RA-7: the vendored template zip matches the SHA-256 and source URL recorded in vendor/SOURCE.md", () => {
    const source = read(`${MANUSCRIPT}/vendor/SOURCE.md`);
    const recorded = source.match(/SHA-256 \| `([0-9a-f]{64})`/);
    expect(recorded).not.toBeNull();
    expect(source).toContain("https://ieeeaccess.ieee.org/wp-content/uploads/2026/05/ACCESS_latex_template_20260513-1-1.zip");
    const zip = join(root, MANUSCRIPT, "vendor/ieee-access-20260513/ACCESS_latex_template_20260513-1-1.zip");
    // The zip may be kept out of git (its licence is unclear; see SOURCE.md). When present it must match.
    if (existsSync(zip)) expect(createHash("sha256").update(readFileSync(zip)).digest("hex")).toBe(recorded[1]);
  });

  it("RA-8: main-access.pdf is not older than its sources", () => {
    const at = (rel) => join(root, MANUSCRIPT, rel);
    expect(checkPdfFreshness({
      pdfPath: at("main-access.pdf"),
      sourcePaths: [at("main-access.tex"), at("generated_numbers.tex"), at("generated_tables.tex"), join(root, "docs/research/references.bib")],
    })).toEqual([]);
  });
});
