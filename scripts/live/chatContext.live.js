import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateSharedInfrastructure, instrumentModel, readUsage, redact, stats, tamilRatio, gitInfo, PRICING, isQuotaError } from "./lib/liveCommon.js";
import { ResultExistsError, writeJsonOnce, writeResultOnce } from "./lib/writeOnce.js";

// Live chat evaluation: the chat golden set (scripts/eval/chatContext.eval.js) run through the REAL
// pipeline with the live Gemini model, Cohere + production Chroma retrieval (read-only) and live
// Open-Meteo weather, in two modes:
//   baseline — no farmer context and no sufficiency gate: production RAG + buildPrompt/buildFallbackPrompt
//              with NO assembledContext (what the assistant did before the Context Engine);
//   full     — services/chat.service.js generateResponse (context resolution + sufficiency gate + RAG).
// Farmer profiles/parcels are SYNTHETIC and live in an in-memory MongoDB (mongodb-memory-server).
// MongoDB Atlas and S3 are never contacted (see lib/liveCommon.js isolateSharedInfrastructure).
//
// Usage: node scripts/live/chatContext.live.js --date=2026-10-16 [--limit=N] [--no-judge]
// Results are write-once (scripts/live/lib/writeOnce.js): the run refuses to start when its result or
// progress file for that date already exists, so an earlier run is never overwritten.

isolateSharedInfrastructure();
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const date = arg("date") || new Date().toISOString().slice(0, 10);
const limit = arg("limit") ? Number(arg("limit")) : null;
const useJudge = !process.argv.includes("--no-judge");
const outDir = join(root, "docs", "research", "evaluation", "live");
const suffix = limit ? `_limit${limit}` : "";
const resultPaths = [`chat_context_live_${date}${suffix}.json`, `chat_context_live_${date}${suffix}.md`, `chat_context_live_${date}${suffix}.rows.partial.json`].map((name) => join(outDir, name));
// Checked before any model call so a duplicate run spends no quota.
for (const path of resultPaths) {
  if (existsSync(path)) {
    const error = new ResultExistsError(path);
    console.error(error.message);
    process.exit(error.exitCode);
  }
}

const mongoose = (await import("mongoose")).default;
const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: "live-chat-eval" });

const { HumanMessage, SystemMessage } = await import("@langchain/core/messages");
const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
const District = (await import("../../models/District.js")).default;
const FarmProfile = (await import("../../models/FarmProfile.js")).default;
const { districtReference } = await import("../../config/districts.js");
const chat = await import("../../services/chat.service.js");
const { assembleContext, renderContextBlock } = await import("../../services/context.service.js");
const { buildPrompt, buildFallbackPrompt } = await import("../../src/ai/PromptBuilder.js");
const { selectTemplate } = await import("../../src/ai/PromptTemplates.js");
const { cleanupResponse } = await import("../../src/ai/ResponseCleanup.js");
const { classifyIntent } = await import("../../src/ai/Intent.js");
const AIConfig = (await import("../../src/ai/AIConfig.js")).default;
const { env } = await import("../../config/env.js");

const calls = instrumentModel(chat.model);

// --- golden set: copied verbatim from scripts/eval/chatContext.eval.js (ARCHETYPES, QUESTIONS, specification) ---
const SQUARE = (origin) => ({ type: "Polygon", coordinates: [[[origin, 10], [origin + 0.001, 10], [origin + 0.001, 10.001], [origin, 10.001], [origin, 10]]] });
const ARCHETYPES = {
  noProfile: { profile: null, requestDistrict: null },
  singleCrop: { profile: { crops: ["Paddy"], parcels: [] } },
  multiCrop: { profile: { crops: ["Paddy", "Sugarcane"], parcels: [] } },
  twoParcels: { profile: { crops: ["Paddy", "Sugarcane"], parcels: [{ parcelId: "par_a", name: "North", crop: "Sugarcane", geometry: SQUARE(79.1) }, { parcelId: "par_b", name: "South", crop: "Paddy", geometry: SQUARE(79.2) }] } },
  oneParcel: { profile: { crops: ["Paddy", "Banana"], parcels: [{ parcelId: "par_only", name: "Only", crop: "Banana", geometry: SQUARE(79.3) }] } },
};
const QUESTIONS = [
  { text: "my leaves are turning yellow with brown spots", intent: "disease_diagnosis", names: null },
  { text: "when should I irrigate?", intent: "irrigation", names: null },
  { text: "how much urea should I apply?", intent: "fertilizer", names: null },
  { text: "which crop should I grow this season?", intent: "crop_recommendation", names: null },
  { text: "will it rain this week?", intent: "weather_planning", names: null },
  { text: "what is the best time to harvest?", intent: "general_agriculture", names: null },
  { text: "what is the status of my claim?", intent: "claim_status", names: null },
  { text: "hello", intent: "greeting", names: null },
  { text: "when should I irrigate my sugarcane?", intent: "irrigation", names: "sugarcane" },
  { text: "how much urea for paddy?", intent: "fertilizer", names: "paddy" },
];
const specification = ({ archetype, question, parcelId, requestDistrict }) => {
  const profile = ARCHETYPES[archetype].profile;
  const districtKnown = Boolean(profile) || Boolean(requestDistrict);
  const needsDistrict = ["crop_recommendation", "weather_planning"].includes(question.intent);
  const needsCrop = ["disease_diagnosis", "irrigation", "fertilizer"].includes(question.intent);
  if (needsDistrict && !districtKnown) return { ask: "district", reason: "missing" };
  if (!needsCrop) return { ask: null };
  if (question.names) return { ask: null, crop: question.names };
  const parcel = parcelId && profile ? profile.parcels.find((p) => p.parcelId === parcelId) : null;
  if (parcel && parcel.crop) return { ask: null, crop: parcel.crop };
  if (!profile) return { ask: "crop", reason: "missing" };
  const crops = [...new Set(profile.crops.map((c) => c.toLowerCase()))];
  if (profile.parcels.length === 1 && profile.parcels[0].crop) return { ask: null, crop: profile.parcels[0].crop };
  if (crops.length === 1) return { ask: null, crop: profile.crops[0] };
  return { ask: "crop", reason: "ambiguous" };
};
// --- end of copied block ---

// Subset: the 7 golden questions whose answer depends on a context slot (greeting, claim-status and the
// generic harvest question are dropped to save model calls), x 5 archetypes, plus the golden set's 5
// extra cases (explicit parcel selection; request-supplied district), plus 6 Tamil items added here.
const SLOT_QUESTIONS = QUESTIONS.filter((q) => !["greeting", "claim_status", "general_agriculture"].includes(q.intent));
const TAMIL = [
  { archetype: "multiCrop", question: { text: "நெல் இலை மஞ்சள் ஆகிறது", intent: "disease_diagnosis", names: "paddy" } },
  { archetype: "singleCrop", question: { text: "உரம் எவ்வளவு போட வேண்டும்?", intent: "fertilizer", names: null } },
  { archetype: "twoParcels", question: { text: "தண்ணீர் எப்போது பாய்ச்ச வேண்டும்?", intent: "irrigation", names: null } },
  { archetype: "singleCrop", question: { text: "இந்த வாரம் மழை வருமா?", intent: "weather_planning", names: null } },
  { archetype: "noProfile", question: { text: "எந்த பயிர் நல்லது?", intent: "crop_recommendation", names: null } },
  { archetype: "oneParcel", question: { text: "பூச்சி தாக்குதல் உள்ளது, என்ன செய்வது?", intent: "disease_diagnosis", names: null } },
];
const buildItems = () => {
  const items = [];
  for (const archetype of Object.keys(ARCHETYPES)) for (const question of SLOT_QUESTIONS) items.push({ archetype, question, parcelId: null, requestDistrict: null, lang: "en", source: "golden" });
  for (const question of QUESTIONS.filter((q) => ["irrigation", "fertilizer", "disease_diagnosis"].includes(q.intent) && !q.names)) items.push({ archetype: "twoParcels", question, parcelId: "par_a", requestDistrict: null, lang: "en", source: "golden_extra" });
  for (const question of QUESTIONS.filter((q) => ["crop_recommendation", "weather_planning"].includes(q.intent))) items.push({ archetype: "noProfile", question, parcelId: null, requestDistrict: "Thanjavur", lang: "en", source: "golden_extra" });
  for (const t of TAMIL) items.push({ ...t, parcelId: null, requestDistrict: null, lang: "ta", source: "tamil_added" });
  return items.map((item, i) => ({ id: `C${String(i + 1).padStart(2, "0")}`, ...item }));
};

// --- deterministic checks ---
const CROP_TERMS = { paddy: ["paddy", "rice", "நெல்"], sugarcane: ["sugarcane", "கரும்பு"], banana: ["banana", "வாழை"] };
const DISTRICT_TERMS = ["thanjavur", "tanjore", "தஞ்சாவூர்", "தஞ்சை"];
const SLOT_QUESTION_TERMS = {
  crop: ["crop", "which", "paddy", "sugarcane", "banana", "rice", "plant", "field", "parcel", "பயிர்", "எந்த", "நெல்", "கரும்பு", "வாழை", "வயல்", "நிலம்"],
  district: ["district", "where", "location", "located", "village", "region", "area", "மாவட்ட", "எங்கு", "எங்கே", "ஊர்", "இடம்", "பகுதி"],
};
const has = (text, terms) => terms.some((t) => text.toLowerCase().includes(t.toLowerCase()));
const questionSentences = (text) => String(text).split(/(?<=[.!?\n])/).map((s) => s.trim()).filter((s) => s.endsWith("?") || s.endsWith("?)"));
// Soft requests without a question mark ("if you tell me which crop ...", "சொன்னால்").
const REQUEST_PATTERNS = [/\bif you (could )?(tell|let me know|share|mention|specify|confirm)/i, /\bplease (tell|share|let me know|specify|confirm|mention)/i, /\b(could|can|would) you (please )?(tell|share|let me know|specify|confirm)/i, /\blet me know\b/i, /சொன்னால்|சொல்லுங்கள்|சொல்ல முடியுமா|தெரிவித்தால்|தெரிவிக்கவும்|தெரிவியுங்கள்|குறிப்பிட்டால்|கூறினால்|கூறுங்கள்/];
const sentences = (text) => String(text).split(/(?<=[.!?\n])/).map((s) => s.trim()).filter(Boolean);
const checks = (item, spec, text) => {
  const qs = questionSentences(text);
  const slotQuestion = (slot) => qs.some((s) => has(s, SLOT_QUESTION_TERMS[slot]));
  const asksClarifying = slotQuestion("crop") || slotQuestion("district");
  const softRequest = sentences(text).some((s) => REQUEST_PATTERNS.some((p) => p.test(s)) && (has(s, SLOT_QUESTION_TERMS.crop) || has(s, SLOT_QUESTION_TERMS.district)));
  const profile = ARCHETYPES[item.archetype].profile;
  const districtKnown = Boolean(profile) || Boolean(item.requestDistrict);
  const cropKey = spec.crop ? String(spec.crop).toLowerCase() : null;
  const options = spec.reason === "ambiguous" ? [...new Set(profile.crops.map((c) => c.toLowerCase()))] : null;
  const mentionedOptions = options ? options.filter((o) => has(text, CROP_TERMS[o] || [o])) : null;
  return {
    chars: text.length,
    questionSentences: qs.length,
    asksClarifying,
    requestsSlotInfo: asksClarifying || softRequest,
    asksAboutSpecSlot: spec.ask ? slotQuestion(spec.ask) : null,
    mentionsRequiredCrop: cropKey ? has(text, CROP_TERMS[cropKey] || [cropKey]) : null,
    mentionsDistrict: districtKnown ? has(text, DISTRICT_TERMS) : null,
    ambiguousOptionsMentioned: mentionedOptions,
    silentSingleCropAssumption: options ? !(asksClarifying || softRequest) && mentionedOptions.length === 1 : null,
    tamilRatio: tamilRatio(text),
    languageMatches: item.lang === "ta" ? (tamilRatio(text) ?? 0) >= 0.8 : (tamilRatio(text) ?? 0) <= 0.2,
  };
};

// --- setup: reference districts + synthetic profiles in the in-memory DB ---
await District.insertMany(districtReference.map((d) => ({ ...d })));
const items = buildItems().slice(0, limit || undefined);
let seq = 0;
const makeUser = async (archetype) => {
  const sub = `live-eval-${archetype}-${++seq}`;
  const p = ARCHETYPES[archetype].profile;
  if (p) await FarmProfile.create({ cognitoSub: sub, district: "Thanjavur", acres: 3, crops: p.crops, parcels: p.parcels.map((x) => ({ ...x, calculatedAreaAcres: 1 })) });
  return sub;
};

const lastCall = (before) => (calls.length > before ? calls[calls.length - 1] : null);

const runBaseline = async (item) => {
  const before = calls.length;
  const t0 = performance.now();
  const rag = await chat.performRAG(item.question.text);
  const ragMs = Math.round(performance.now() - t0);
  const language = chat.resolveReplyLanguage({ requested: undefined, profileLanguage: undefined, message: item.question.text });
  const messages = rag.context
    ? buildPrompt({ userMessage: item.question.text, history: [], context: rag.context, template: selectTemplate(item.question.text), language })
    : buildFallbackPrompt({ userMessage: item.question.text, history: [], language });
  const lm = messages.map((m) => (m.role === "system" ? new SystemMessage(m.content) : new HumanMessage(m.content)));
  const result = await chat.model.generate([lm]);
  const text = cleanupResponse(result.generations?.[0]?.[0]?.text || "");
  const call = lastCall(before);
  return { text, ragMs, modelMs: call ? call.ms : null, totalMs: Math.round(performance.now() - t0), usage: readUsage(result), sources: rag.sources.map((s) => s.filename), language: language || null, followUpSlot: null };
};

const runFull = async (item, sub) => {
  const before = calls.length;
  const t0 = performance.now();
  const out = await chat.generateResponse({ message: item.question.text, chatId: null, cognitoSub: sub, email: null, district: item.requestDistrict || undefined, parcelId: item.parcelId });
  const call = lastCall(before);
  return {
    text: out.response, ragMs: out.meta.latencyMs.rag, contextMs: out.meta.latencyMs.context, modelMs: call ? call.ms : out.meta.latencyMs.model,
    totalMs: Math.round(performance.now() - t0), usage: call && call.ok ? readUsage(call.result) : null, sources: out.sources.map((s) => s.filename),
    language: out.meta.language, intent: out.meta.intent, followUpSlot: out.meta.followUpSlot, loaded: out.meta.loaded,
  };
};

const rows = [];
let quotaStop = null;
const partialPath = resultPaths[2];
for (const [index, item] of items.entries()) {
  const sub = await makeUser(item.archetype);
  const spec = specification({ archetype: item.archetype, question: item.question, parcelId: item.parcelId, requestDistrict: item.requestDistrict });
  // Context block for the judge (what the system knows about this synthetic farmer). Weather is cached after first fetch.
  const snapshot = await assembleContext({ cognitoSub: sub, district: item.requestDistrict || undefined, userMessage: item.question.text, parcelId: item.parcelId });
  const row = { id: item.id, source: item.source, lang: item.lang, archetype: item.archetype, question: item.question.text, expectedIntent: item.question.intent, classifiedIntent: classifyIntent(item.question.text), parcelId: item.parcelId, requestDistrict: item.requestDistrict, spec: { ask: spec.ask, reason: spec.reason || null, crop: spec.crop || null }, gateFollowUpSlot: snapshot.sufficiency.followUp ? snapshot.sufficiency.followUp.slot : null, contextBlock: renderContextBlock(snapshot) };
  const order = index % 2 === 0 ? ["baseline", "full"] : ["full", "baseline"];
  for (const mode of order) {
    try {
      const r = mode === "baseline" ? await runBaseline(item) : await runFull(item, sub);
      row[mode] = { ...r, checks: checks(item, spec, r.text) };
    } catch (error) {
      row[mode] = { error: redact(error && error.message) };
    }
  }
  rows.push(row);
  // Persist after every item so an interrupted run (quota, crash) keeps what it measured. The progress
  // file is created write-once on the first item and then rewritten only by this run.
  const progress = `${JSON.stringify({ date, status: "in_progress", rows }, null, 2)}\n`;
  if (rows.length === 1) writeResultOnce(partialPath, progress);
  else writeFileSync(partialPath, progress);
  process.stderr.write(`${item.id} ${item.archetype} ${item.lang} done (model calls so far: ${calls.length})\n`);
  const quotaFailure = calls.find((c) => !c.ok && isQuotaError(c.error));
  if (quotaFailure) { quotaStop = { afterItem: item.id, error: quotaFailure.error }; process.stderr.write("Gemini quota/rate-limit error: stopping (no further retries)\n"); break; }
}

// --- LLM judge (Gemini) — LLM-judged, NOT expert-validated ---
const JUDGE_PROMPT = `You are evaluating answers from a farming assistant for Tamil Nadu farmers. For each item you get:
the FARMER CONTEXT the system holds (synthetic test farmer), the QUESTION, and two answers labelled X and Y (order is random).
Score each answer independently:
- relevance (1-5): does it address the question asked?
- contextUse (1-5): does it correctly use what the context says is known (district, crop, parcel), and ask ONLY when a needed detail is genuinely unknown or ambiguous? Penalise asking for known details, and penalise silently assuming a crop when the context says it is ambiguous.
- unsupportedClaims (integer): count of specific factual claims (numbers, doses, dates, weather facts) that are neither in the context nor standard agronomic knowledge.
- unsafe (boolean): would following it plausibly harm the farmer, crop or health?
Then give preference: "X", "Y" or "tie".
Return ONLY a JSON array, one object per item, in order: [{"item":"<id>","X":{"relevance":n,"contextUse":n,"unsupportedClaims":n,"unsafe":b},"Y":{...},"preference":"X|Y|tie"}]`;
const judgeModel = new ChatGoogleGenerativeAI({ apiKey: env.googleApiKey, model: AIConfig.model, maxOutputTokens: 4096, temperature: 0 });
const judgeCalls = [];
let seed = 20261016;
const coin = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 < 0.5; };
if (useJudge && !quotaStop) {
  const judgeable = rows.filter((r) => r.baseline && r.full && !r.baseline.error && !r.full.error);
  for (let i = 0; i < judgeable.length; i += 2) {
    const batch = judgeable.slice(i, i + 2).map((r) => ({ r, baselineIsX: coin() }));
    const body = batch.map(({ r, baselineIsX }) => {
      const X = baselineIsX ? r.baseline.text : r.full.text;
      const Y = baselineIsX ? r.full.text : r.baseline.text;
      return `### ITEM ${r.id}\nFARMER CONTEXT:\n${r.contextBlock}\n\nQUESTION: ${r.question}\n\nANSWER X:\n${X.slice(0, 3000)}\n\nANSWER Y:\n${Y.slice(0, 3000)}`;
    }).join("\n\n");
    const t0 = performance.now();
    try {
      const res = await judgeModel.generate([[new SystemMessage(JUDGE_PROMPT), new HumanMessage(body)]]);
      const text = res.generations?.[0]?.[0]?.text || "";
      const parsed = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
      judgeCalls.push({ ms: Math.round(performance.now() - t0), usage: readUsage(res), ok: true });
      for (const { r, baselineIsX } of batch) {
        const j = parsed.find((p) => p.item === r.id);
        if (!j) continue;
        const base = baselineIsX ? j.X : j.Y; const full = baselineIsX ? j.Y : j.X;
        const pref = j.preference === "tie" ? "tie" : (j.preference === "X") === baselineIsX ? "baseline" : "full";
        r.judge = { baselineWasX: baselineIsX, baseline: base, full, preference: pref };
      }
    } catch (error) {
      judgeCalls.push({ ms: Math.round(performance.now() - t0), ok: false, error: redact(error && error.message) });
    }
  }
}

// --- aggregate ---
const ok = (mode) => rows.filter((r) => r[mode] && !r[mode].error);
const frac = (k, n) => ({ k, n, value: n ? Math.round((k / n) * 10000) / 10000 : null });
const count = (list, pred) => list.filter(pred).length;
const agg = (mode) => {
  const list = ok(mode);
  const nec = list.filter((r) => r.spec.ask);
  const unnec = list.filter((r) => !r.spec.ask);
  const cropReq = list.filter((r) => r.spec.crop);
  const distKnown = list.filter((r) => r[mode].checks.mentionsDistrict !== null && ["crop_recommendation", "weather_planning"].includes(r.expectedIntent));
  const amb = list.filter((r) => r.spec.reason === "ambiguous");
  const ta = list.filter((r) => r.lang === "ta");
  const judged = list.filter((r) => r.judge && r.judge[mode]);
  const u = list.map((r) => r[mode].usage).filter(Boolean);
  return {
    n: list.length,
    errors: rows.length - list.length,
    clarifyingQuestionWhenNecessary: frac(count(nec, (r) => r[mode].checks.asksClarifying), nec.length),
    clarifyingQuestionWhenUnnecessary: frac(count(unnec, (r) => r[mode].checks.asksClarifying), unnec.length),
    requestsSlotInfoWhenNecessary: frac(count(nec, (r) => r[mode].checks.requestsSlotInfo), nec.length),
    requestsSlotInfoWhenUnnecessary: frac(count(unnec, (r) => r[mode].checks.requestsSlotInfo), unnec.length),
    necessaryAskedWithShortAnswer: frac(count(nec, (r) => r[mode].checks.requestsSlotInfo && r[mode].checks.chars <= 600), nec.length),
    silentSingleCropAssumptionWhenAmbiguous: frac(count(amb, (r) => r[mode].checks.silentSingleCropAssumption), amb.length),
    mentionsRequiredCrop: frac(count(cropReq, (r) => r[mode].checks.mentionsRequiredCrop), cropReq.length),
    mentionsDistrictForDistrictQuestions: frac(count(distKnown, (r) => r[mode].checks.mentionsDistrict), distKnown.length),
    tamilItemsAnsweredInTamil: frac(count(ta, (r) => r[mode].checks.languageMatches), ta.length),
    englishItemsAnsweredInEnglish: frac(count(list.filter((r) => r.lang === "en"), (r) => r[mode].checks.languageMatches), list.filter((r) => r.lang === "en").length),
    truncatedMaxTokens: count(u, (x) => x.finishReason === "MAX_TOKENS"),
    latencyMs: { endToEnd: stats(list.map((r) => r[mode].totalMs)), model: stats(list.map((r) => r[mode].modelMs)), rag: stats(list.map((r) => r[mode].ragMs)), context: mode === "full" ? stats(list.map((r) => r.full.contextMs)) : null },
    tokens: { prompt: stats(u.map((x) => x.prompt)), candidates: stats(u.map((x) => x.candidates)), thinking: stats(u.map((x) => x.thinking)), total: stats(u.map((x) => x.total)) },
    estCostUsd: { perItem: stats(u.map((x) => x.estCostUsd), 6), sum: Math.round(u.reduce((s, x) => s + x.estCostUsd, 0) * 1e6) / 1e6 },
    answerChars: stats(list.map((r) => r[mode].checks.chars)),
    llmJudged: judged.length ? {
      label: "LLM-judged (Gemini), not expert-validated",
      n: judged.length,
      relevanceMean: stats(judged.map((r) => r.judge[mode].relevance)).mean,
      contextUseMean: stats(judged.map((r) => r.judge[mode].contextUse)).mean,
      unsupportedClaimsMean: stats(judged.map((r) => r.judge[mode].unsupportedClaims)).mean,
      unsafeCount: count(judged, (r) => r.judge[mode].unsafe === true),
    } : null,
  };
};
const judgedRows = rows.filter((r) => r.judge);
const ju = judgeCalls.filter((c) => c.ok).map((c) => c.usage);
const result = {
  name: "chatContextLive",
  date,
  ...(await gitInfo()),
  description: "Chat golden-set subset through the live pipeline: baseline (no farmer context, no sufficiency gate) vs full (context resolution + gate). Synthetic farmers in an in-memory MongoDB.",
  model: AIConfig.model, maxOutputTokens: AIConfig.maxOutputTokens, ragTopK: AIConfig.ragTopK,
  pricing: PRICING,
  items: { total: rows.length, golden: count(rows, (r) => r.source === "golden"), goldenExtra: count(rows, (r) => r.source === "golden_extra"), tamilAdded: count(rows, (r) => r.source === "tamil_added"), necessaryFollowUp: count(rows, (r) => r.spec.ask), unnecessaryFollowUp: count(rows, (r) => !r.spec.ask) },
  intentClassifierAccuracy: frac(count(rows, (r) => r.classifiedIntent === r.expectedIntent), rows.length),
  gateAgreesWithSpec: frac(count(rows, (r) => (r.gateFollowUpSlot || null) === (r.spec.ask || null)), rows.length),
  baseline: agg("baseline"),
  full: agg("full"),
  llmJudgePreference: judgedRows.length ? { label: "LLM-judged (Gemini, same model family as the system under test; blinded, order randomised), not expert-validated", n: judgedRows.length, full: count(judgedRows, (r) => r.judge.preference === "full"), baseline: count(judgedRows, (r) => r.judge.preference === "baseline"), tie: count(judgedRows, (r) => r.judge.preference === "tie") } : null,
  judgeCalls: { n: judgeCalls.length, failed: count(judgeCalls, (c) => !c.ok), estCostUsd: Math.round(ju.reduce((s, x) => s + x.estCostUsd, 0) * 1e6) / 1e6 },
  stoppedForQuota: quotaStop,
  plannedItems: buildItems().slice(0, limit || undefined).length,
  latencyCaveat: "LangChain retries an HTTP 429 several times with backoff, so a quota or rate-limit problem can appear as a slow call or a timeout. Calls longer than 20 s are counted in slowModelCalls; treat their latency with caution.",
  slowModelCalls: calls.filter((c) => c.ms > 20000).length,
  geminiCalls: { generation: calls.length, judge: judgeCalls.length, failedGeneration: count(calls, (c) => !c.ok) },
  deterministicRules: {
    asksClarifying: "STRICT: some sentence ending in '?' contains a crop- or district-slot keyword (English or Tamil list in the script).",
    requestsSlotInfo: "BROAD: asksClarifying, OR a sentence matching a soft-request pattern ('if you tell me', 'please share', Tamil 'சொன்னால்' etc.) that contains a slot keyword. Requests may come alongside a full generic answer.",
    necessaryAskedWithShortAnswer: "Necessary item where requestsSlotInfo is true and the answer is <= 600 characters (asked instead of producing a long generic answer).",
    silentSingleCropAssumption: "Ambiguous-crop item (farmer grows several crops, none selected): no clarifying question AND exactly one of the farmer's crops is mentioned.",
    mentionsRequiredCrop: "Spec derives a crop: the answer contains that crop's English or Tamil name.",
    mentionsDistrict: "District is known (profile or request) and the intent is crop recommendation or weather: answer contains Thanjavur (English/Tamil).",
    languageMatches: "Tamil item: Tamil letters >= 80% of Tamil+Latin letters; English item: <= 20%.",
  },
  rows,
  limitations: [
    "Synthetic farmers (all in Thanjavur) and templated questions from an author-written golden set; not real farmer traffic.",
    "Deterministic checks are keyword heuristics: mentioning a crop is not the same as correct advice for it.",
    "The LLM judge is the same model family (Gemini 2.5 Flash) as the system under test, so self-preference bias is possible; it is not expert validation.",
    "Each item was run once per mode (no repeated sampling); LLM output is stochastic.",
    "Baseline shares RAG and the system prompt with full mode; it differs only by the absence of the Context block and follow-up policy.",
    "Weather comes from live Open-Meteo at run time; the Context block changes with the forecast.",
  ],
};

writeJsonOnce(resultPaths[0], result);

const b = result.baseline; const f = result.full;
const pct = (x) => (x.value === null ? "n/a" : `${(x.value * 100).toFixed(1)}% (${x.k}/${x.n})`);
const md = `# Live chat evaluation — ${date}

Model \`${result.model}\`, ${rows.length} items (golden ${result.items.golden} + golden extras ${result.items.goldenExtra} + Tamil ${result.items.tamilAdded}), each run once in baseline and full mode. Synthetic farmers in an in-memory MongoDB; live Gemini, Cohere/Chroma (read-only), Open-Meteo. Commit ${result.commit}${result.dirtyWorkingTree ? " (dirty tree)" : ""}.

Deterministic checks (keyword rules, see JSON \`deterministicRules\`):

| Metric | Baseline | Full |
|---|---|---|
| Clarifying '?' question when necessary (spec) | ${pct(b.clarifyingQuestionWhenNecessary)} | ${pct(f.clarifyingQuestionWhenNecessary)} |
| Clarifying '?' question when unnecessary (spec) | ${pct(b.clarifyingQuestionWhenUnnecessary)} | ${pct(f.clarifyingQuestionWhenUnnecessary)} |
| Requests the slot (incl. soft requests without '?') when necessary | ${pct(b.requestsSlotInfoWhenNecessary)} | ${pct(f.requestsSlotInfoWhenNecessary)} |
| Requests the slot when unnecessary | ${pct(b.requestsSlotInfoWhenUnnecessary)} | ${pct(f.requestsSlotInfoWhenUnnecessary)} |
| Necessary: asked with a short (<=600 chars) answer | ${pct(b.necessaryAskedWithShortAnswer)} | ${pct(f.necessaryAskedWithShortAnswer)} |
| Silent single-crop assumption when crop ambiguous | ${pct(b.silentSingleCropAssumptionWhenAmbiguous)} | ${pct(f.silentSingleCropAssumptionWhenAmbiguous)} |
| Mentions the crop the spec derives | ${pct(b.mentionsRequiredCrop)} | ${pct(f.mentionsRequiredCrop)} |
| Mentions district (crop-recommendation/weather, district known) | ${pct(b.mentionsDistrictForDistrictQuestions)} | ${pct(f.mentionsDistrictForDistrictQuestions)} |
| English items answered in English |  ${pct(b.englishItemsAnsweredInEnglish)} | ${pct(f.englishItemsAnsweredInEnglish)} |
| Tamil items answered in Tamil | ${pct(b.tamilItemsAnsweredInTamil)} | ${pct(f.tamilItemsAnsweredInTamil)} |
| Responses truncated at MAX_TOKENS | ${b.truncatedMaxTokens} | ${f.truncatedMaxTokens} |
| End-to-end latency median / p95 (ms) | ${b.latencyMs.endToEnd.median} / ${b.latencyMs.endToEnd.p95} | ${f.latencyMs.endToEnd.median} / ${f.latencyMs.endToEnd.p95} |
| Model latency median (ms) | ${b.latencyMs.model.median} | ${f.latencyMs.model.median} |
| Prompt tokens mean | ${b.tokens.prompt.mean} | ${f.tokens.prompt.mean} |
| Candidate tokens mean | ${b.tokens.candidates.mean} | ${f.tokens.candidates.mean} |
| Thinking tokens mean | ${b.tokens.thinking.mean} | ${f.tokens.thinking.mean} |
| Total tokens mean | ${b.tokens.total.mean} | ${f.tokens.total.mean} |
| Est. cost per answer, mean (USD) | ${b.estCostUsd.perItem.mean} | ${f.estCostUsd.perItem.mean} |

Gate (sufficiency) agrees with the written spec: ${pct(result.gateAgreesWithSpec)}; intent classifier accuracy on these items: ${pct(result.intentClassifierAccuracy)}.

${result.llmJudgePreference ? `**LLM-judged (Gemini), not expert-validated** (n=${result.llmJudgePreference.n}, blinded, random order, same model family as the system):

| | Baseline | Full |
|---|---|---|
| Relevance mean (1-5) | ${b.llmJudged && b.llmJudged.relevanceMean} | ${f.llmJudged && f.llmJudged.relevanceMean} |
| Context use mean (1-5) | ${b.llmJudged && b.llmJudged.contextUseMean} | ${f.llmJudged && f.llmJudged.contextUseMean} |
| Unsupported claims per answer, mean | ${b.llmJudged && b.llmJudged.unsupportedClaimsMean} | ${f.llmJudged && f.llmJudged.unsupportedClaimsMean} |
| Flagged unsafe | ${b.llmJudged && b.llmJudged.unsafeCount} | ${f.llmJudged && f.llmJudged.unsafeCount} |

Preference: full ${result.llmJudgePreference.full}, baseline ${result.llmJudgePreference.baseline}, tie ${result.llmJudgePreference.tie}.` : "No LLM judge run."}

Cost: ${PRICING.source}; input $${PRICING.inputUsdPerMTok}/1M, output incl. thinking $${PRICING.outputIncludingThinkingUsdPerMTok}/1M. Generation total est. $${Math.round((b.estCostUsd.sum + f.estCostUsd.sum) * 1e4) / 1e4}; judge est. $${result.judgeCalls.estCostUsd}. Gemini calls: ${result.geminiCalls.generation} generation + ${result.geminiCalls.judge} judge.

Limitations: ${result.limitations.join(" ")}
`;
writeResultOnce(resultPaths[1], md);
console.log(md);
await mongoose.disconnect();
await mongo.stop();
process.exit(0);
