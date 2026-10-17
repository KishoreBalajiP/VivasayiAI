import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bibStats } from "./bibStats.js";
import { computeNumbers, crossCheckStudyDefaults, NUMBERS_JSON_PATH, NUMBERS_TEX_PATH, STUDY_COMMIT, TABLES_PATH } from "./manuscriptTables.js";

// Checks that every number in the manuscript prose is traceable (npm run manuscript:numbers):
//   1. main.tex has no number literal outside comments, \cite, \label, \ref, \input and similar
//      commands, unless docs/research/manuscript/number_allowlist.json lists the phrase with a
//      justification (mission names such as "Sentinel-2", event dates, ...);
//   2. every number macro main.tex uses is defined in generated_numbers.tex, and that file agrees with
//      generated_numbers.json;
//   3. the generated numbers are not stale: recomputing them from the result files, the source ledger
//      and the code defaults gives the same values (the study-time defaults come from the pinned
//      study_code_defaults_2026-10-16.json; they are re-read at the study commit only when git has it);
//   4. the source ledger covers every bibliography entry and agrees with the counts stated in
//      research_gap.md and literature_review.md (rows the author has not yet confirmed are a warning);
//   5. the frozen 16 October 2026 result files still match FROZEN_HASHES.json;
//   6. main.pdf is not older than main.tex or the files it includes (a stale PDF).
// Exit code 1 when any check fails. Nothing is written.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANUSCRIPT_DIR = join(root, "docs", "research", "manuscript");
export const PATHS = {
  main: join(MANUSCRIPT_DIR, "main.tex"),
  pdf: join(MANUSCRIPT_DIR, "main.pdf"),
  allowlist: join(MANUSCRIPT_DIR, "number_allowlist.json"),
  numbersTex: NUMBERS_TEX_PATH,
  numbersJson: NUMBERS_JSON_PATH,
  tables: TABLES_PATH,
  bib: join(root, "docs", "research", "references.bib"),
  ledger: join(root, "docs", "research", "source_ledger.json"),
  researchGap: join(root, "docs", "research", "research_gap.md"),
  literatureReview: join(root, "docs", "research", "literature_review.md"),
  frozenHashes: join(root, "docs", "research", "evaluation", "live", "FROZEN_HASHES.json"),
};

// Commands whose arguments are references or file names, never prose numbers.
const IGNORED_COMMANDS = ["cite", "citep", "citet", "label", "ref", "eqref", "pageref", "input", "include", "bibliography", "bibliographystyle", "documentclass", "usepackage", "url", "begin", "end"];

// Replace a span with spaces of the same length (newlines kept) so offsets still map to lines.
const blank = (text) => text.replace(/[^\n]/g, " ");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const stripComments = (tex) => tex.replace(/(^|[^\\])(%[^\n]*)/g, (_, before, comment) => `${before}${blank(comment)}`);

export const blankIgnoredCommands = (tex) =>
  tex.replace(new RegExp(`\\\\(?:${IGNORED_COMMANDS.join("|")})\\*?(?:\\[[^\\]]*\\])*\\{[^}]*\\}`, "g"), (match) => blank(match));

// Allow-listed phrases may wrap across lines; whitespace inside a phrase matches any whitespace.
export const blankAllowlisted = (tex, allowlist) => {
  let out = tex;
  for (const entry of allowlist) {
    const pattern = new RegExp(escapeRegex(entry.text).replace(/\s+/g, "\\s+"), "g");
    out = out.replace(pattern, (match) => blank(match));
  }
  return out;
};

// A number literal is a run of digits (with decimal points or thousands commas) that does not continue
// a word or a command name: "L2A", "utf8" and "IEEEtran" are not numbers; "Sentinel-2" and "0.15" are.
export const findNumberLiterals = (tex, allowlist = []) => {
  const scanned = blankAllowlisted(blankIgnoredCommands(stripComments(tex)), allowlist);
  const found = [];
  for (const match of scanned.matchAll(/(?<![A-Za-z0-9@\\])\d+(?:[.,]\d+)*/g)) {
    found.push({ literal: match[0], line: lineOf(scanned, match.index), context: tex.split("\n")[lineOf(scanned, match.index) - 1].trim().slice(0, 160) });
  }
  return found;
};

// Number macros are CamelCase commands with at least two capitals (\SatLiveSquares); LaTeX's own
// commands used in the manuscript (\Delta, \IEEEkeywords, \textbf ...) do not match.
export const findUsedMacros = (tex) => [...new Set([...stripComments(tex).matchAll(/\\([A-Z][a-z]+(?:[A-Z][a-z]*)+)(?![A-Za-z])/g)].map((m) => m[1]))];

export const parseNumbersTex = (text) => Object.fromEntries([...text.matchAll(/^\\newcommand\{\\([A-Za-z]+)\}\{([^\n]*)\}$/gm)].map((m) => [m[1], m[2]]));

export const checkPdfFreshness = ({ pdfPath, sourcePaths, toleranceMs = 2000 }) => {
  if (!existsSync(pdfPath)) return [`${relative(root, pdfPath)} does not exist`];
  const pdfTime = statSync(pdfPath).mtimeMs;
  return sourcePaths
    .filter((path) => existsSync(path) && statSync(path).mtimeMs > pdfTime + toleranceMs)
    .map((path) => `${relative(root, pdfPath)} is older than ${relative(root, path)}: rebuild the PDF (stale PDF)`);
};

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export const checkLedger = ({ ledger, stats, researchGapText, literatureReviewText }) => {
  const errors = [];
  const levels = new Set(Object.keys(ledger.levels || {}));
  const keys = ledger.entries.map((e) => e.key);
  for (const key of stats.keys) if (!keys.includes(key)) errors.push(`source_ledger.json has no entry for bib key ${key}`);
  for (const key of keys) if (!stats.keys.includes(key)) errors.push(`source_ledger.json entry ${key} is not in references.bib`);
  for (const entry of ledger.entries) {
    if (!levels.has(entry.verification)) errors.push(`source_ledger.json ${entry.key}: unknown verification level "${entry.verification}"`);
    if (!entry.verification.startsWith("unknown") && !(entry.evidence || []).length) errors.push(`source_ledger.json ${entry.key}: a verification level needs evidence`);
    // The author confirms each row; either state is valid, but it must be stated.
    if (typeof entry.confirmedByAuthor !== "boolean") errors.push(`source_ledger.json ${entry.key}: confirmedByAuthor must be true or false`);
  }
  const gap = researchGapText.match(/of (\d+) verified sources plus (\w+) web documents/);
  const firstPassPapers = ledger.entries.filter((e) => e.pass === 1 && e.verification !== "web_page").length;
  const firstPassWeb = ledger.entries.filter((e) => e.pass === 1 && e.verification === "web_page").length;
  if (!gap) errors.push("research_gap.md no longer states '<n> verified sources plus <n> web documents'");
  else {
    if (Number(gap[1]) !== firstPassPapers) errors.push(`research_gap.md states ${gap[1]} verified sources; the ledger has ${firstPassPapers} first-pass papers`);
    const web = WORD_NUMBERS[gap[2].toLowerCase()] ?? Number(gap[2]);
    if (web !== firstPassWeb) errors.push(`research_gap.md states ${gap[2]} web documents; the ledger has ${firstPassWeb} first-pass web documents`);
  }
  const added = literatureReviewText.match(/added (\d+) sources/);
  const secondPass = ledger.entries.filter((e) => e.pass === 2).length;
  if (!added || Number(added[1]) !== secondPass) errors.push(`literature_review.md states ${added ? added[1] : "?"} second-pass sources; the ledger has ${secondPass}`);
  if (stats.secondPassEntries !== secondPass) errors.push(`references.bib marks ${stats.secondPassEntries} second-pass entries; the ledger has ${secondPass}`);
  return errors;
};

// Rows still awaiting the author's confirmation: reported, never an error.
export const unconfirmedLedgerRows = (ledger) => ledger.entries.filter((entry) => entry.confirmedByAuthor !== true).map((entry) => entry.key);

export const checkFrozenHashes = (frozen) =>
  Object.entries(frozen.files || {}).flatMap(([path, expected]) => {
    const full = join(root, path);
    if (!existsSync(full)) return [`frozen result ${path} is missing`];
    const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
    return actual === expected ? [] : [`frozen result ${path} changed (sha256 ${actual.slice(0, 12)}..., expected ${expected.slice(0, 12)}...)`];
  });

export const runChecks = async ({ checkPdf = true } = {}) => {
  const errors = [];
  const warnings = [];
  const read = (path) => readFileSync(path, "utf8");
  const main = read(PATHS.main);
  const allowlist = JSON.parse(read(PATHS.allowlist)).entries || [];

  // 1. Literals.
  for (const entry of allowlist) {
    if (!entry.text || !String(entry.justification || "").trim()) errors.push(`number_allowlist.json entry "${entry.text}" needs a justification`);
    else if (!new RegExp(escapeRegex(entry.text).replace(/\s+/g, "\\s+")).test(stripComments(main))) warnings.push(`number_allowlist.json entry "${entry.text}" is not used in main.tex`);
  }
  for (const found of findNumberLiterals(main, allowlist)) errors.push(`main.tex:${found.line}: number literal "${found.literal}" is neither a macro nor allow-listed: ${found.context}`);

  // 2. Macros.
  if (!/\\input\{generated_numbers\}/.test(stripComments(main))) errors.push("main.tex does not \\input{generated_numbers}");
  const defined = parseNumbersTex(read(PATHS.numbersTex));
  for (const macro of findUsedMacros(main)) if (!(macro in defined)) errors.push(`main.tex uses \\${macro}, which generated_numbers.tex does not define`);
  const json = JSON.parse(read(PATHS.numbersJson));
  for (const [macro, value] of Object.entries(defined)) {
    if (!(macro in json)) errors.push(`generated_numbers.json has no entry for \\${macro}`);
    else if (json[macro].value !== value) errors.push(`\\${macro} is "${value}" in generated_numbers.tex but "${json[macro].value}" in generated_numbers.json`);
  }
  for (const [macro, entry] of Object.entries(json)) {
    if (!(macro in defined)) errors.push(`generated_numbers.json entry ${macro} is not defined in generated_numbers.tex`);
    for (const field of ["value", "source", "pointer", "formatter"]) if (!entry[field] && entry[field] !== 0) errors.push(`generated_numbers.json ${macro} has no ${field}`);
  }

  // 3. Staleness of the generated numbers.
  const fresh = await computeNumbers();
  if (!crossCheckStudyDefaults().checked) warnings.push(`commit ${STUDY_COMMIT} is not in this checkout (shallow clone or no .git): the study-time defaults were taken from the pinned study_code_defaults_2026-10-16.json without re-reading the code at that commit`);
  for (const entry of fresh) {
    if (!(entry.macro in json)) errors.push(`\\${entry.macro} is computed but missing from generated_numbers.json: run node scripts/eval/manuscriptTables.js`);
    else if (json[entry.macro].value !== entry.value) errors.push(`\\${entry.macro} is stale: generated "${json[entry.macro].value}", recomputed "${entry.value}" from ${entry.source}: run node scripts/eval/manuscriptTables.js`);
  }
  for (const macro of Object.keys(json)) if (!fresh.some((e) => e.macro === macro)) errors.push(`generated_numbers.json entry ${macro} is no longer computed: run node scripts/eval/manuscriptTables.js`);

  // 4. Source ledger.
  const ledger = JSON.parse(read(PATHS.ledger));
  errors.push(...checkLedger({ ledger, stats: bibStats(), researchGapText: read(PATHS.researchGap), literatureReviewText: read(PATHS.literatureReview) }));
  const unconfirmed = unconfirmedLedgerRows(ledger);
  if (unconfirmed.length) warnings.push(`source_ledger.json: ${unconfirmed.length} of ${ledger.entries.length} rows are not yet confirmed by the author`);

  // 5. Frozen results.
  errors.push(...checkFrozenHashes(JSON.parse(read(PATHS.frozenHashes))));

  // 6. Stale PDF.
  if (checkPdf) errors.push(...checkPdfFreshness({ pdfPath: PATHS.pdf, sourcePaths: [PATHS.main, PATHS.numbersTex, PATHS.tables, PATHS.bib] }));

  return { errors, warnings, macros: Object.keys(defined).length };
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runChecks().then(
    ({ errors, warnings, macros }) => {
      for (const warning of warnings) console.warn(`warning: ${warning}`);
      for (const error of errors) console.error(`error: ${error}`);
      console.log(errors.length ? `manuscript numbers: ${errors.length} error(s)` : `manuscript numbers: OK (${macros} macros, ${warnings.length} warning(s))`);
      process.exit(errors.length ? 1 : 0);
    },
    (error) => {
      console.error(error && error.message ? error.message : error);
      process.exit(1);
    }
  );
}
