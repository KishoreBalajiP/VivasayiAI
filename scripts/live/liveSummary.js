import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeResultOnce } from "./lib/writeOnce.js";

// Combines the live-evaluation result files of one date into a single key-metrics table. Reads only the
// JSON the live scripts wrote; computes nothing new except formatting. The summary is write-once
// (scripts/live/lib/writeOnce.js): an existing SUMMARY_<date>.md is never replaced.
// Usage: node scripts/live/liveSummary.js --date=2026-10-16

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dateArg = process.argv.find((a) => a.startsWith("--date="));
const date = dateArg ? dateArg.slice(7) : new Date().toISOString().slice(0, 10);
const dir = join(root, "docs", "research", "evaluation", "live");
const load = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null);
const chat = load(`chat_context_live_${date}.json`);
const rag = load(`rag_retrieval_${date}.json`);
const doc = load(`landdoc_extraction_synthetic_${date}.json`);
const status = load(`live_eval_status_${date}.json`);
const pct = (f) => (!f || f.value === null || f.value === undefined ? "n/a" : `${(f.value * 100).toFixed(1)}% (${f.k}/${f.n})`);
const pr = (k, n) => (n ? `${((k / n) * 100).toFixed(1)}% (${k}/${n})` : "n/a");

const lines = [`# Live evaluation summary — ${date}`, "", "Every number below is copied from the JSON files in this folder. Labels: synthetic farmers, synthetic documents, author-defined rules; LLM-judged items are marked.", ""];
lines.push("| Experiment | Metric | Value |", "|---|---|---|");
if (chat) {
  const b = chat.baseline; const f = chat.full;
  lines.push(
    `| Chat (n=${chat.items.total} items x 2 modes) | Clarifying '?' question when necessary: baseline / full | ${pct(b.clarifyingQuestionWhenNecessary)} / ${pct(f.clarifyingQuestionWhenNecessary)} |`,
    `| | Requests slot incl. soft requests, when necessary: baseline / full | ${pct(b.requestsSlotInfoWhenNecessary)} / ${pct(f.requestsSlotInfoWhenNecessary)} |`,
    `| | Clarifying '?' question when unnecessary: baseline / full | ${pct(b.clarifyingQuestionWhenUnnecessary)} / ${pct(f.clarifyingQuestionWhenUnnecessary)} |`,
    `| | Silent single-crop assumption when ambiguous: baseline / full | ${pct(b.silentSingleCropAssumptionWhenAmbiguous)} / ${pct(f.silentSingleCropAssumptionWhenAmbiguous)} |`,
    `| | Mentions spec-derived crop: baseline / full | ${pct(b.mentionsRequiredCrop)} / ${pct(f.mentionsRequiredCrop)} |`,
    `| | English items answered in English: baseline / full | ${pct(b.englishItemsAnsweredInEnglish)} / ${pct(f.englishItemsAnsweredInEnglish)} |`,
    `| | Tamil items answered in Tamil: baseline / full | ${pct(b.tamilItemsAnsweredInTamil)} / ${pct(f.tamilItemsAnsweredInTamil)} |`,
    `| | Errors (incl. production 25 s AI timeout): baseline / full | ${b.errors} / ${f.errors} |`,
    `| | End-to-end latency median ms: baseline / full | ${b.latencyMs.endToEnd.median} / ${f.latencyMs.endToEnd.median} |`,
    `| | Total tokens mean (incl. thinking): baseline / full | ${b.tokens.total.mean} / ${f.tokens.total.mean} |`,
    `| | Thinking tokens mean: baseline / full | ${b.tokens.thinking.mean} / ${f.tokens.thinking.mean} |`,
    `| | Est. cost per answer mean USD: baseline / full | ${b.estCostUsd.perItem.mean} / ${f.estCostUsd.perItem.mean} |`,
  );
  if (chat.llmJudgePreference) lines.push(`| | LLM-judged (Gemini), not expert-validated: preference full / baseline / tie (n=${chat.llmJudgePreference.n}) | ${chat.llmJudgePreference.full} / ${chat.llmJudgePreference.baseline} / ${chat.llmJudgePreference.tie} |`, `| | LLM-judged context-use mean (1-5): baseline / full | ${b.llmJudged && b.llmJudged.contextUseMean} / ${f.llmJudged && f.llmJudged.contextUseMean} |`);
}
if (rag) {
  const s = rag.summaryAtProductionTopK;
  lines.push(
    `| RAG (n=${rag.queries.total} queries; ${rag.corpus.chunks} chunks) | Answerable (n=${rag.queries.answerable}): any relevant chunk in top-${rag.config.productionTopK} | ${pct(s.answerable.hitRateAnyRelevant)} |`,
    `| | Answerable: expected file retrieved in top-${rag.config.productionTopK} | ${pct(s.answerable.anyExpectedFile)} |`,
    `| | Answerable: chunk precision top-${rag.config.productionTopK} | ${pct(s.answerable.precisionOfChunks)} |`,
    `| | Expected-file hits that are header-only chunks | ${pct(s.answerableExpectedFileHitsThatAreHeaderOnly)} |`,
    `| | Advisory (n=${rag.queries.advisory}): answer-bearing chunks | ${pct(s.advisory.answerBearingChunks)} |`,
    `| | Corpus composition (chunks) | ${Object.entries(rag.corpus.chunksByFileKind).map(([k, v]) => `${k} ${v}`).join(", ")} |`,
  );
}
if (doc) {
  const fc = doc.fieldsClean;
  const keyFields = ["holderNames", "surveyNumber", "subdivisionNumber", "parcelExtent", "district", "village"];
  lines.push(`| Synthetic land docs (n=${doc.documents.ok}: ${doc.documents.clean} clean + ${doc.documents.adversarial} adversarial) | Strict macro-F1, clean | ${doc.strictScorerClean.macroF1} |`);
  for (const f of keyFields) lines.push(`| | ${f}: exact / lenient, clean | ${pr(fc[f].exactMatch, fc[f].n)} / ${pr(fc[f].lenientMatch, fc[f].n)} |`);
  lines.push(
    `| | All fields correct (lenient), clean | ${pr(doc.documentLevelClean.allFieldsLenient, doc.documentLevelClean.n)} |`,
    `| | Injection obeyed (any target field) | ${pr(doc.injection.filter((r) => r.obeyed).length, doc.injection.length)} |`,
    `| | Injection flagged (suspiciousText) | ${pr(doc.injection.filter((r) => r.suspiciousTextFlag).length, doc.injection.length)} |`,
    `| | Model call > production 25 s timeout | ${pr(doc.timeout.documentsThatWouldTimeOutInProduction, doc.timeout.n)} |`,
    `| | Latency median / max ms; est. cost per doc mean USD | ${doc.latencyMs.median} / ${doc.latencyMs.max}; ${doc.estCostUsd.perDocument.mean} |`,
  );
}
if (!chat && status && status.chatContextLive) lines.push(`| Chat (baseline vs full) | — | ${status.chatContextLive.status}; no results |`);
if (!doc && status && status.landDocExtractionSynthetic) lines.push(`| Synthetic land docs | — | ${status.landDocExtractionSynthetic.status}; no results |`);
const geminiCalls = (chat ? chat.geminiCalls.generation + chat.geminiCalls.judge : 0) + (doc ? doc.geminiCalls.total : 0);
lines.push("", `Gemini calls recorded in these result files: ${geminiCalls}.${status ? " Calls made during development and in interrupted runs are listed in live_eval_status_" + date + ".json." : ""}`);
lines.push("", "Price source: " + ((chat && chat.pricing.source) || (doc && doc.pricing.source) || "n/a"));
console.log(lines.join("\n"));
try {
  writeResultOnce(join(dir, `SUMMARY_${date}.md`), `${lines.join("\n")}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode || 1);
}
