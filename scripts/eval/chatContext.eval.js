import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import District from "../../models/District.js";
import FarmProfile from "../../models/FarmProfile.js";
import LossClaim from "../../models/LossClaim.js";
import { assembleContext } from "../../services/context.service.js";
import { classifyIntent } from "../../src/ai/Intent.js";
import { confusionMatrix, rate, summary } from "./lib/metrics.js";

// Chat context evaluation.
//
// Question: does resolving context from the farmer's own records reduce UNNECESSARY follow-up
// questions without missing the NECESSARY ones, compared with the previous rule?
//
// Ground truth is a written specification, not model judgement: a follow-up is necessary exactly
// when a slot the question depends on cannot be derived from the farmer's records or the message.
// The "previous rule" baseline is the old template selector: it asked whenever a message ended with
// "?" and contained what/how/explain/tell me about/"?" or had three words or fewer, and it silently
// used the first listed crop. This evaluation is DETERMINISTIC and needs no language model. It
// measures the decision to ask, not the quality of the answer, which needs expert-rated answers.

const TARGET_LATENCY_NOTE = "Context assembly only; weather is a stub, so network latency is excluded";

// --- the previous rule, reimplemented as the baseline ----------------------------------------------------
const OLD_SIGNALS = ["what", "how", "tell me about", "explain", "?"];
const oldRuleAsks = (message) => {
  const m = String(message || "").toLowerCase().trim();
  if (!m || !m.endsWith("?")) return false;
  const tokens = m.replace(/[?.!]+/, "").split(/\s+/).filter(Boolean);
  return tokens.length <= 3 || OLD_SIGNALS.some((signal) => m.includes(signal));
};

// --- labelled intent set (English and Tamil) --------------------------------------------------------------------------
const INTENT_SET = [
  ["hello", "greeting"], ["வணக்கம்", "greeting"], ["good morning", "greeting"], ["vanakkam", "greeting"],
  ["what is the status of my claim", "claim_status"], ["has my compensation been approved", "claim_status"], ["என் காப்பீடு கோரிக்கை என்ன ஆனது", "claim_status"],
  ["which crop should I grow this season", "crop_recommendation"], ["what can I plant after paddy", "crop_recommendation"], ["எந்த பயிர் நல்லது", "crop_recommendation"],
  ["my paddy leaves are turning yellow", "disease_diagnosis"], ["there are brown spots on the leaves", "disease_diagnosis"], ["stem borer in rice how to control", "disease_diagnosis"], ["நெல் இலை மஞ்சள் ஆகிறது", "disease_diagnosis"], ["பூச்சி தாக்குதல் உள்ளது", "disease_diagnosis"],
  ["how much urea should I apply", "fertilizer"], ["which fertilizer for sugarcane", "fertilizer"], ["உரம் எவ்வளவு போட வேண்டும்", "fertilizer"],
  ["when should I irrigate", "irrigation"], ["how often should I water groundnut", "irrigation"], ["தண்ணீர் எப்போது பாய்ச்ச வேண்டும்", "irrigation"],
  ["will it rain this week", "weather_planning"], ["what is the forecast for tomorrow", "weather_planning"], ["மழை வருமா", "weather_planning"],
  ["how to store harvested grain", "general_agriculture"], ["what is the best time to harvest sugarcane", "general_agriculture"], ["tell me about crop rotation", "general_agriculture"],
  ["help?", "unclear"], ["and now?", "unclear"],
];

// --- farmer archetypes ------------------------------------------------------------------------------------------------------------
const SQUARE = (origin) => ({ type: "Polygon", coordinates: [[[origin, 10], [origin + 0.001, 10], [origin + 0.001, 10.001], [origin, 10.001], [origin, 10]]] });
const ARCHETYPES = {
  noProfile: { profile: null, requestDistrict: null },
  singleCrop: { profile: { crops: ["Paddy"], parcels: [] } },
  multiCrop: { profile: { crops: ["Paddy", "Sugarcane"], parcels: [] } },
  twoParcels: { profile: { crops: ["Paddy", "Sugarcane"], parcels: [{ parcelId: "par_a", name: "North", crop: "Sugarcane", geometry: SQUARE(79.1) }, { parcelId: "par_b", name: "South", crop: "Paddy", geometry: SQUARE(79.2) }] } },
  oneParcel: { profile: { crops: ["Paddy", "Banana"], parcels: [{ parcelId: "par_only", name: "Only", crop: "Banana", geometry: SQUARE(79.3) }] } },
};

// message, intent, the crop it names (if any)
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

// The specification: is a follow-up genuinely necessary, and about what?
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

const buildCases = () => {
  const cases = [];
  for (const archetype of Object.keys(ARCHETYPES)) {
    for (const question of QUESTIONS) {
      cases.push({ archetype, question, parcelId: null, requestDistrict: archetype === "noProfile" ? null : undefined });
    }
  }
  // The same ambiguous farmer, but the client states which parcel the question is about.
  for (const question of QUESTIONS.filter((q) => ["irrigation", "fertilizer", "disease_diagnosis"].includes(q.intent) && !q.names)) {
    cases.push({ archetype: "twoParcels", question, parcelId: "par_a", requestDistrict: undefined });
  }
  // A farmer with no profile who supplies a district with the request.
  for (const question of QUESTIONS.filter((q) => ["crop_recommendation", "weather_planning"].includes(q.intent))) {
    cases.push({ archetype: "noProfile", question, parcelId: null, requestDistrict: "Thanjavur" });
  }
  return cases;
};

export const runChatContextEvaluation = async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "eval-chat-context" });
  try {
    await District.create({ name: "Thanjavur", lat: 10.78, lon: 79.14, regionType: "Delta" });
    const weatherFn = async () => ({ status: "ok", freshness: "fresh", ageSeconds: 5, current: { temperature: 31, summary: "Clear", windspeed: 8 }, forecast: [] });

    // 1. intent accuracy
    const intentRows = INTENT_SET.map(([text, expected]) => ({ text, expected, actual: classifyIntent(text) }));
    const intentLabels = [...new Set(INTENT_SET.map(([, e]) => e))];

    // 2. follow-up decisions
    const cases = buildCases();
    const rows = [];
    const latencies = [];
    let n = 0;
    for (const c of cases) {
      n += 1;
      const sub = `eval-user-${n}`;
      const archetype = ARCHETYPES[c.archetype];
      if (archetype.profile) {
        await FarmProfile.create({ cognitoSub: sub, district: "Thanjavur", acres: 3, crops: archetype.profile.crops, parcels: archetype.profile.parcels.map((p) => ({ ...p, calculatedAreaAcres: 1 })) });
      }
      const started = performance.now();
      const snapshot = await assembleContext({ cognitoSub: sub, district: c.requestDistrict ?? undefined, userMessage: c.question.text, parcelId: c.parcelId, weatherFn });
      latencies.push(performance.now() - started);

      const spec = specification({ archetype: c.archetype, question: c.question, parcelId: c.parcelId, requestDistrict: c.requestDistrict });
      const newAsk = snapshot.sufficiency.followUp ? snapshot.sufficiency.followUp.slot : null;
      const oldAsk = oldRuleAsks(c.question.text);
      // Baseline crop handling: it silently used the first profile crop whenever there was one.
      const baselineCropAssumed = archetype.profile && archetype.profile.crops.length > 0 ? archetype.profile.crops[0] : null;
      rows.push({
        archetype: c.archetype, question: c.question.text, intent: c.question.intent,
        specAsk: spec.ask, specReason: spec.reason || null, newAsk, newSlot: snapshot.slots.crop.value,
        oldAsks: oldAsk, specCrop: spec.crop || null, baselineCropAssumed,
        intentCorrect: snapshot.intent === c.question.intent,
      });
    }

    const necessary = rows.filter((r) => r.specAsk !== null);
    const unnecessary = rows.filter((r) => r.specAsk === null);
    const newUnnecessary = unnecessary.filter((r) => r.newAsk !== null);
    const oldUnnecessary = unnecessary.filter((r) => r.oldAsks);
    const newMissed = necessary.filter((r) => r.newAsk === null);
    const oldMissed = necessary.filter((r) => !r.oldAsks);
    const newWrongSlot = necessary.filter((r) => r.newAsk !== null && r.newAsk !== r.specAsk);

    // Silent wrong assumptions: the spec says the crop is ambiguous, and the system acted as if it knew.
    const ambiguousCrop = rows.filter((r) => r.specAsk === "crop" && r.specReason === "ambiguous");
    const baselineSilentAssumption = ambiguousCrop.filter((r) => r.baselineCropAssumed);
    const newSilentAssumption = ambiguousCrop.filter((r) => r.newAsk === null);

    // Crop value correctness where the spec says a crop is derivable.
    const derivable = rows.filter((r) => r.specCrop);
    const cropCorrect = derivable.filter((r) => String(r.newSlot || "").toLowerCase() === String(r.specCrop).toLowerCase());

    return {
      name: "chatContext",
      description: "Intent classification and the decision to ask a follow-up question, new context-sufficiency logic versus the previous 'ends with ?' rule, scored against a written specification.",
      groundTruth: "a written specification of when a question is necessary (a slot the question depends on cannot be derived from the farmer's records or the message); AUTHOR-DEFINED, no human rater and no language model involved",
      intent: {
        n: intentRows.length,
        accuracy: rate(intentRows.filter((r) => r.expected === r.actual).length, intentRows.length),
        confusionMatrix: confusionMatrix(intentRows, intentLabels),
        errors: intentRows.filter((r) => r.expected !== r.actual),
      },
      followUp: {
        cases: rows.length,
        necessaryCases: necessary.length,
        unnecessaryCases: unnecessary.length,
        newLogic: {
          unnecessaryFollowUpRate: rate(newUnnecessary.length, unnecessary.length),
          missedNecessaryFollowUpRate: rate(newMissed.length, necessary.length),
          askedAboutWrongSlot: newWrongSlot.length,
          silentAssumptionWhenAmbiguous: rate(newSilentAssumption.length, ambiguousCrop.length),
        },
        previousRule: {
          unnecessaryFollowUpRate: rate(oldUnnecessary.length, unnecessary.length),
          missedNecessaryFollowUpRate: rate(oldMissed.length, necessary.length),
          silentAssumptionWhenAmbiguous: rate(baselineSilentAssumption.length, ambiguousCrop.length),
        },
        cropResolvedCorrectlyWhenDerivable: rate(cropCorrect.length, derivable.length),
        byArchetype: Object.fromEntries(Object.keys(ARCHETYPES).map((a) => {
          const subset = rows.filter((r) => r.archetype === a);
          return [a, { cases: subset.length, newUnnecessary: subset.filter((r) => r.specAsk === null && r.newAsk !== null).length, oldUnnecessary: subset.filter((r) => r.specAsk === null && r.oldAsks).length }];
        })),
        mismatches: rows.filter((r) => (r.specAsk === null) !== (r.newAsk === null)).map((r) => ({ archetype: r.archetype, question: r.question, spec: r.specAsk, got: r.newAsk })),
      },
      latencyMs: { ...summary(latencies.map((v) => Math.round(v * 100) / 100)), note: TARGET_LATENCY_NOTE },
      pending: [
        "Answer relevance, correctness and groundedness need expert-rated answers from the live model (Gemini API key required).",
        "Whether farmers experience fewer annoying questions needs a user study.",
      ],
      limitations: [
        "The specification and the new logic were written by the same author, so agreement with the specification shows the logic implements the intended rule, not that the rule matches what farmers need.",
        "The previous-rule baseline is a faithful reimplementation of the old heuristic, not a run of the old deployment.",
        "Synthetic profiles and ten question templates; real questions are far more varied.",
      ],
    };
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
};

export default runChatContextEvaluation;
