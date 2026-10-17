import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bibliography statistics for the manuscript: entries in docs/research/references.bib (by type and by
// search pass) and the \cite keys used in docs/research/manuscript/main.tex. Read-only; it computes
// counts so the manuscript can quote them through generated macros instead of typing them.
//   node scripts/eval/bibStats.js        prints the statistics as JSON

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIB_PATH = join(root, "docs", "research", "references.bib");
export const MANUSCRIPT_PATH = join(root, "docs", "research", "manuscript", "main.tex");

// The bibliography marks where the second literature pass starts with a comment line
// ("% ---- Added 2026-10-16 (second pass) ...").
const SECOND_PASS_MARKER = /^%.*second pass/i;

export const parseBib = (text) => {
  const entries = [];
  let secondPass = false;
  text.split("\n").forEach((line, index) => {
    if (SECOND_PASS_MARKER.test(line)) secondPass = true;
    const match = line.match(/^@(\w+)\s*\{\s*([^,\s]+)\s*,/);
    if (match) entries.push({ key: match[2], type: match[1].toLowerCase(), line: index + 1, pass: secondPass ? 2 : 1 });
  });
  return entries;
};

// \cite{a,b} / \cite[p.~3]{a} keys, ignoring commented-out text.
export const parseCitations = (tex) => {
  const uncommented = tex
    .split("\n")
    .map((line) => line.replace(/(^|[^\\])%.*$/, "$1"))
    .join("\n");
  const occurrences = [];
  for (const match of uncommented.matchAll(/\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g)) {
    for (const key of match[1].split(",")) if (key.trim()) occurrences.push(key.trim());
  }
  return occurrences;
};

export const bibStats = ({ bibText = readFileSync(BIB_PATH, "utf8"), texText = readFileSync(MANUSCRIPT_PATH, "utf8") } = {}) => {
  const entries = parseBib(bibText);
  const keys = entries.map((entry) => entry.key);
  const byType = {};
  for (const entry of entries) byType[entry.type] = (byType[entry.type] || 0) + 1;
  const lower = keys.map((key) => key.toLowerCase());
  const duplicates = keys.filter((key, index) => lower.indexOf(key.toLowerCase()) !== index);
  const occurrences = parseCitations(texText);
  const cited = [...new Set(occurrences)];
  return {
    entries: entries.length,
    byType,
    firstPassEntries: entries.filter((entry) => entry.pass === 1).length,
    secondPassEntries: entries.filter((entry) => entry.pass === 2).length,
    keys,
    duplicates,
    citationOccurrences: occurrences.length,
    citedKeys: cited.length,
    citedNotInBib: cited.filter((key) => !keys.includes(key)),
    uncitedKeys: keys.filter((key) => !cited.includes(key)),
  };
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) console.log(JSON.stringify(bibStats(), null, 2));
