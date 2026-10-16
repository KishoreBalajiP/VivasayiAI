// Rule-based intent classification for the chat assistant (no ML, no network). It decides WHICH
// sources the context resolver loads and WHICH details are required before an answer is safe, so
// the assistant retrieves what it can and asks only about what it genuinely cannot know.
//
// Intent vocabulary is detection only (English + Tamil). It is not agronomic reference data and
// never asserts crop suitability.

export const INTENTS = Object.freeze({
  GREETING: "greeting",
  CLAIM_STATUS: "claim_status",
  CROP_RECOMMENDATION: "crop_recommendation",
  DISEASE_DIAGNOSIS: "disease_diagnosis",
  IRRIGATION: "irrigation",
  FERTILIZER: "fertilizer",
  WEATHER_PLANNING: "weather_planning",
  GENERAL_AGRICULTURE: "general_agriculture",
  UNCLEAR: "unclear",
});

const GREETING_WORDS = ["hello", "hi", "hey", "namaste", "vanakkam", "good morning", "good evening", "good afternoon"];
const GREETING_TAMIL = ["வணக்கம்", "வணக்கம", "ஹல்லோ", "ஹாய்"];

const CLAIM = [/\bclaim(s)?\b/, /\bcompensation\b/, /\binsurance\b/, /\bloss(es)?\b.*\b(verif|status|claim)/, /இழப்பீடு/, /காப்பீடு/, /கோரிக்கை/];
const CROP_RECOMMENDATION = [
  /\bwhat crop\b/, /\bwhich crop\b/, /\bwhat .* (to )?(grow|plant|sow|raise)\b/, /\bwhich .* (to )?(grow|plant|sow|raise)\b/,
  /\bcrop[s]? .*\b(good|suitable|best|recommend|suggested|workable)\b/, /\b(good|suitable|best|recommend|suggest) .*crop[s]?\b/,
  /\bwhat can i (grow|plant|sow)\b/, /\bwhat should i (grow|plant|sow)\b/,
  /எந்த பயிர்/, /என்ன பயிர்/, /பயிர்.*(நல்ல|சிறந்த|ஏற்ற|பரிந்துரை|வளர்க்க)/,
];
const DISEASE = [
  /\b(disease|pest|insect|worm|fung(us|al)|blight|rust|wilt(ing)?|rot(ting)?|mite|aphid|borer|blast|spots?|lesions?)\b/,
  /\b(yellow(ing)?|brown(ing)?|curl(ing)?|drying|dying|withering)\b/,
  /நோய்/, /பூச்சி/, /புழு/, /மஞ்சள்/, /வாடு/, /கருகு/, /புள்ளி/,
];
const IRRIGATION = [/\birrigat/, /\bwater(ing)?\b/, /\bdrip\b/, /\bdrought\b/, /\bflood(ed|ing)?\b/, /நீர்ப்பாசன/, /தண்ணீர்/, /பாசனம்/];
const FERTILIZER = [/\bfertili[sz]er/, /\bmanure\b/, /\bnutrient/, /\burea\b/, /\bdap\b/, /\bnpk\b/, /\bcompost\b/, /உரம்/, /யூரியா/];
const WEATHER = [/\bweather\b/, /\brain(fall|s)?\b/, /\bforecast\b/, /\btemperature\b/, /\bmonsoon\b/, /வானிலை/, /மழை/, /வெப்பநிலை/];

const matches = (patterns, text) => patterns.some((pattern) => pattern.test(text));

const isGreeting = (text) => {
  const m = text.trim();
  if (GREETING_TAMIL.some((word) => word.toLowerCase() === m)) return true;
  return GREETING_WORDS.some((word) => m === word || m.startsWith(`${word} `) || m.startsWith(`${word}!`) || m.startsWith(`${word},`));
};

// Ordered: the first matching rule wins. Claim and crop-recommendation are checked before the
// symptom words because "which crop is good after the flood" is a recommendation question.
export const classifyIntent = (message) => {
  const text = String(message || "").toLowerCase().trim();
  if (!text) return INTENTS.UNCLEAR;
  if (isGreeting(text)) return INTENTS.GREETING;
  if (matches(CLAIM, text)) return INTENTS.CLAIM_STATUS;
  if (matches(CROP_RECOMMENDATION, text)) return INTENTS.CROP_RECOMMENDATION;
  if (matches(DISEASE, text)) return INTENTS.DISEASE_DIAGNOSIS;
  if (matches(FERTILIZER, text)) return INTENTS.FERTILIZER;
  if (matches(IRRIGATION, text)) return INTENTS.IRRIGATION;
  if (matches(WEATHER, text)) return INTENTS.WEATHER_PLANNING;
  // A one- or two-word question ("help?", "and now?") carries no usable intent.
  const tokens = text.replace(/[?.!,]+/g, " ").split(/\s+/).filter(Boolean);
  if (text.endsWith("?") && tokens.length <= 2) return INTENTS.UNCLEAR;
  return INTENTS.GENERAL_AGRICULTURE;
};

// What each intent needs to be answered safely. `crop` and `district` are resolved from the farmer's
// own records first; only an unresolved REQUIRED slot may justify a follow-up question.
export const REQUIRED_SLOTS = Object.freeze({
  [INTENTS.GREETING]: [],
  [INTENTS.CLAIM_STATUS]: [],
  [INTENTS.CROP_RECOMMENDATION]: ["district"],
  [INTENTS.DISEASE_DIAGNOSIS]: ["crop"],
  [INTENTS.IRRIGATION]: ["crop"],
  [INTENTS.FERTILIZER]: ["crop"],
  [INTENTS.WEATHER_PLANNING]: ["district"],
  [INTENTS.GENERAL_AGRICULTURE]: [],
  [INTENTS.UNCLEAR]: [],
});

// Which context sources an intent needs, so a request never loads more than its answer uses.
export const CONTEXT_NEEDS = Object.freeze({
  [INTENTS.GREETING]: { profile: false, weather: false, soil: false, claims: false },
  [INTENTS.CLAIM_STATUS]: { profile: true, weather: false, soil: false, claims: true },
  [INTENTS.CROP_RECOMMENDATION]: { profile: true, weather: true, soil: true, claims: false },
  [INTENTS.DISEASE_DIAGNOSIS]: { profile: true, weather: true, soil: false, claims: false },
  [INTENTS.IRRIGATION]: { profile: true, weather: true, soil: true, claims: false },
  [INTENTS.FERTILIZER]: { profile: true, weather: false, soil: true, claims: false },
  [INTENTS.WEATHER_PLANNING]: { profile: true, weather: true, soil: false, claims: false },
  [INTENTS.GENERAL_AGRICULTURE]: { profile: true, weather: true, soil: false, claims: false },
  [INTENTS.UNCLEAR]: { profile: true, weather: false, soil: false, claims: false },
});

export default { INTENTS, classifyIntent, REQUIRED_SLOTS, CONTEXT_NEEDS };
