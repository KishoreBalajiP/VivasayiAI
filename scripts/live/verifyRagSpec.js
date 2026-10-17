import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonOnce } from "./lib/writeOnce.js";

// Checks that the frozen RAG evaluation rule (scripts/live/lib/ragEvalSpec.js) is still the rule that
// produced the 2026-10-16 baseline. Three comparisons:
//   1. every `// <frozen:NAME>` block in the spec file hashes to the pin in ragEvalSpec.provenance.json;
//   2. the whole spec file hashes to the pinned specSha256 (any edit outside the blocks shows up too);
//   3. when git history is available, the pinned line ranges of
//      `git show 6dbe6b8:scripts/live/ragRetrieval.live.js` hash to the same pins and equal the blocks.
// Read-only: it never writes, except `--write-provenance`, which creates the pin file once (wx).
// Usage: node scripts/live/verifyRagSpec.js [--no-git] [--write-provenance]

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SPEC_PATH = "scripts/live/lib/ragEvalSpec.js";
export const PROVENANCE_PATH = "scripts/live/lib/ragEvalSpec.provenance.json";
export const BASELINE_PATH = "docs/research/evaluation/live/rag_retrieval_2026-10-16.json";

// Line ranges in 6dbe6b8:scripts/live/ragRetrieval.live.js (1-based, inclusive).
export const FROZEN_BLOCKS = Object.freeze([
  { name: "T", lines: [32, 44] },
  { name: "QUERIES", lines: [46, 71] },
  { name: "helpers", lines: [73, 74] },
  { name: "kind", lines: [87, 87] },
  { name: "labelHits", lines: [102, 120] },
  { name: "partition", lines: [127, 129] },
  { name: "summarize", lines: [130, 147] },
]);

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// A block is the lines strictly between its markers, joined with "\n", with no trailing newline.
export const extractFrozenBlocks = (text) => {
  const blocks = new Map();
  let open = null;
  let buffer = [];
  for (const line of String(text).split("\n")) {
    const start = line.match(/^\/\/ <frozen:(\w+)>$/);
    const end = line.match(/^\/\/ <\/frozen:(\w+)>$/);
    if (start) {
      if (open) throw new Error(`Frozen block ${start[1]} opens inside ${open}`);
      if (blocks.has(start[1])) throw new Error(`Frozen block ${start[1]} appears twice`);
      open = start[1];
      buffer = [];
    } else if (end) {
      if (end[1] !== open) throw new Error(`Frozen block ${end[1]} closes but ${open || "none"} is open`);
      blocks.set(open, buffer.join("\n"));
      open = null;
    } else if (open) buffer.push(line);
  }
  if (open) throw new Error(`Frozen block ${open} is never closed`);
  return blocks;
};

export const readSpec = (base = root) => readFileSync(join(base, SPEC_PATH), "utf8");
export const specSha256 = (base = root) => sha256(readFileSync(join(base, SPEC_PATH)));
export const readProvenance = (base = root) => JSON.parse(readFileSync(join(base, PROVENANCE_PATH), "utf8"));

const git = (args, base) => execFileSync("git", args, { cwd: base, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }).toString();

// Whether the source commit can be read. A shallow clone or an exported tree has no history.
export const gitHistoryAvailable = (commit, base = root) => {
  try {
    git(["cat-file", "-e", `${commit}^{commit}`], base);
    return { available: true, reason: null };
  } catch {
    let shallow = null;
    try { shallow = git(["rev-parse", "--is-shallow-repository"], base).trim() === "true"; } catch { /* not a git checkout */ }
    return { available: false, reason: shallow ? "shallow clone" : `commit ${commit} not available` };
  }
};

export const gitSourceBlocks = ({ commit, path, blocks = FROZEN_BLOCKS }, base = root) => {
  const source = git(["show", `${commit}:${path}`], base);
  const lines = source.split("\n");
  return {
    fileSha256: sha256(source),
    blocks: Object.fromEntries(blocks.map(({ name, lines: [a, b] }) => [name, lines.slice(a - 1, b).join("\n")])),
  };
};

export const buildProvenance = (base = root) => {
  const commit = "6dbe6b8";
  const path = "scripts/live/ragRetrieval.live.js";
  const fromGit = gitSourceBlocks({ commit, path }, base);
  const specBlocks = extractFrozenBlocks(readSpec(base));
  for (const { name } of FROZEN_BLOCKS) {
    if (specBlocks.get(name) !== fromGit.blocks[name]) throw new Error(`Spec block ${name} is not a verbatim copy of ${commit}:${path}`);
  }
  return {
    name: "ragEvalSpecProvenance",
    description: "Pins the frozen RAG relevance rule. Each block is a verbatim copy of the listed lines of the source file at the source commit; sha256 is over the block's lines joined with \\n, without a trailing newline. specSha256 is the sha256 of the whole spec file and is recorded in every RAG result.",
    source: { commit, commitFull: git(["rev-parse", `${commit}^{commit}`], base).trim(), path, fileSha256: fromGit.fileSha256 },
    blocks: FROZEN_BLOCKS.map(({ name, lines }) => ({ name, lines, sha256: sha256(fromGit.blocks[name]) })),
    spec: { path: SPEC_PATH, specSha256: specSha256(base) },
    baseline: { path: BASELINE_PATH, sha256: sha256(readFileSync(join(base, BASELINE_PATH))) },
  };
};

export const verifyRagSpec = ({ useGit = true, base = root } = {}) => {
  const errors = [];
  const provenance = readProvenance(base);
  const specBlocks = extractFrozenBlocks(readSpec(base));
  const currentSpecSha = specSha256(base);
  if (currentSpecSha !== provenance.spec.specSha256) errors.push(`specSha256 ${currentSpecSha} differs from the pin ${provenance.spec.specSha256}`);
  const pinnedNames = provenance.blocks.map((b) => b.name);
  for (const name of specBlocks.keys()) if (!pinnedNames.includes(name)) errors.push(`spec block ${name} is not pinned`);

  const gitState = useGit ? gitHistoryAvailable(provenance.source.commit, base) : { available: false, reason: "disabled (--no-git)" };
  let fromGit = null;
  if (gitState.available) {
    fromGit = gitSourceBlocks({ commit: provenance.source.commit, path: provenance.source.path, blocks: provenance.blocks }, base);
    if (fromGit.fileSha256 !== provenance.source.fileSha256) errors.push(`source file hash at ${provenance.source.commit} differs from the pin`);
  }

  const blocks = provenance.blocks.map(({ name, lines, sha256: pinned }) => {
    const spec = specBlocks.has(name) ? sha256(specBlocks.get(name)) : null;
    const gitSha = fromGit ? sha256(fromGit.blocks[name]) : null;
    const ok = spec === pinned && (fromGit ? gitSha === pinned && fromGit.blocks[name] === specBlocks.get(name) : true);
    if (spec === null) errors.push(`spec block ${name} is missing`);
    else if (!ok) errors.push(`block ${name} does not match its pin`);
    return { name, lines, pinned, spec, git: gitSha, ok };
  });

  return {
    ok: errors.length === 0,
    specSha256: currentSpecSha,
    pinnedSpecSha256: provenance.spec.specSha256,
    source: provenance.source,
    git: { ...gitState, checked: Boolean(fromGit) },
    blocks,
    errors,
  };
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  if (process.argv.includes("--write-provenance")) {
    const target = join(root, PROVENANCE_PATH);
    try {
      writeJsonOnce(target, buildProvenance());
      console.log(`Wrote ${PROVENANCE_PATH}`);
    } catch (error) {
      console.error(error.message);
      process.exit(error.exitCode || 1);
    }
    process.exit(0);
  }
  const report = verifyRagSpec({ useGit: !process.argv.includes("--no-git") });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
