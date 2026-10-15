// Context assembly — the Context Engine slice (E2-S3, ADR-014, D-01/D-03), extended so the assistant
// retrieves what it can about the farmer instead of asking.
//
// Runs before the LLM invocation. For each request it:
//   1. classifies the intent (src/ai/Intent.js) and loads ONLY the sources that intent needs;
//   2. resolves the farmer's district, selected parcel and crop from THEIR OWN records first
//      (profile, parcels, an optional explicit parcelId, the message), all scoped by cognitoSub;
//   3. tags every item with where it came from (verified | user_provided | third_party | inferred |
//      missing | stale) so the model never presents an inference or a stale value as fact;
//   4. decides whether a follow-up question is justified (src/ai/ContextSufficiency.js): only an
//      unresolved REQUIRED slot may be asked about, and only one at a time.
// Each domain degrades to an explicit `unknown` marker (ADR-014 rule 1: never block, never fabricate).
import logger from "../utils/logger.js";
import { getWeather } from "./weather.service.js";
import District from "../models/District.js";
import LossClaim from "../models/LossClaim.js";
import * as farmProfileService from "./farmProfile.service.js";
import { CONTEXT_NEEDS, INTENTS, classifyIntent } from "../src/ai/Intent.js";
import { assessSufficiency, buildFollowUpInstruction } from "../src/ai/ContextSufficiency.js";

// A small set of the dominant Tamil Nadu crops used only to detect an explicit crop mention
// (matches the legacy {{crop_name}} placeholder intent). This is NOT a soil/crop reference
// table (that is E2-S2 / D-19 territory); it is a mention-detection vocabulary.
const CROP_ALIASES = Object.freeze({
  paddy: ["paddy", "rice", "நெல்", "சம்பா", "குறுவை"],
  sugarcane: ["sugarcane", "கரும்பு", "சர்க்கரை"],
  cotton: ["cotton", "பருத்தி"],
  groundnut: ["groundnut", "kadalai", "veriyal", "வேர்க்கடலை", "கடலை"],
  // மக்காச்சோளம் (maize) contains சோளம் (sorghum) as a substring, so maize must be listed — and
  // therefore matched — before sorghum. The previous maize alias began with a Bengali letter
  // (U+09B8) instead of Tamil ச (U+0B9A) and could never match.
  maize: ["maize", "corn", "makka cholam", "மக்காச்சோளம்", "மக்காசோளம்"],
  sorghum: ["sorghum", "jowar", "cholam", "சோளம்"],
  tomato: ["tomato", "thakkali", "தக்காளி"],
  chilli: ["chilli", "chili", "milagai", "மிளகாய்"],
  banana: ["banana", "vazhai", "வாழை"],
  coconut: ["coconut", "thengai", "தேங்காய்"],
  ragi: ["ragi", "kezhvaragu", "கேழ்வரகு"],
});

export const detectCrop = (message) => {
  const m = (message || "").toLowerCase();
  for (const [crop, aliases] of Object.entries(CROP_ALIASES)) {
    if (aliases.some((a) => m.includes(a.toLowerCase()))) return crop;
  }
  return null;
};

const fmt = (value) => (value === undefined || value === null || value === "" ? null : value);

// Values from the farmer's profile or the web reach the prompt, so they are flattened to a single
// short line: no line breaks, no markup characters, bounded length. A crop named
// "Paddy\nIgnore previous instructions" must not be able to start a new instruction line.
export const sanitizeInline = (value, max = 80) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const slot = (value, provenance, source, extra = {}) => ({ value: fmt(value), provenance, source, ...extra });
const MISSING = (source = null) => slot(null, "missing", source);

// Which crop does this request concern? Precedence, most specific first:
//   the message names a crop > the selected parcel's crop > the profile lists exactly one crop.
// Several distinct profile crops with nothing to choose between them are AMBIGUOUS, not guessed:
// the previous behaviour silently used the first listed crop.
export const resolveCropSlot = ({ messageCrop, parcel, profileCrops }) => {
  if (messageCrop) return slot(messageCrop, "user_provided", "message");
  if (parcel && parcel.crop) return slot(parcel.crop, "user_provided", "selected_parcel");
  const seenCrops = new Set();
  const crops = [];
  for (const crop of (profileCrops || []).filter(Boolean)) {
    const key = String(crop).toLowerCase();
    if (!seenCrops.has(key)) {
      seenCrops.add(key);
      crops.push(crop); // first spelling wins
    }
  }
  if (crops.length === 1) return slot(crops[0], "user_provided", "farm_profile");
  if (crops.length > 1) return { ...MISSING("farm_profile"), options: crops };
  return MISSING();
};

// The parcel this request concerns: an explicit id the client sent (looked up ONLY inside the
// caller's own profile, so a foreign id simply does not match), else the farmer's only parcel.
export const resolveParcel = ({ parcels, parcelId }) => {
  const list = Array.isArray(parcels) ? parcels : [];
  if (parcelId) {
    const found = list.find((parcel) => parcel.parcelId === parcelId);
    return found
      ? { selected: found, provenance: "user_provided", source: "explicit_selection", count: list.length }
      : { selected: null, provenance: "missing", source: "parcel_not_found", count: list.length };
  }
  if (list.length === 1) return { selected: list[0], provenance: "inferred", source: "only_parcel", count: 1 };
  return { selected: null, provenance: "missing", source: list.length > 1 ? "several_parcels" : "no_parcels", count: list.length };
};

const summarizeClaims = async (cognitoSub) => {
  const claims = await LossClaim.find({ cognitoSub })
    .sort({ createdAt: -1 })
    .limit(3)
    .select("state eventType eventDate claimedAreaAcres parcelSnapshot.name")
    .lean();
  return claims.map((claim) => ({
    state: claim.state,
    eventType: claim.eventType,
    eventDate: claim.eventDate ? new Date(claim.eventDate).toISOString().slice(0, 10) : null,
    areaAcres: claim.claimedAreaAcres,
    parcelName: claim.parcelSnapshot ? claim.parcelSnapshot.name : null,
  }));
};

// Resolve the context for one request. Never throws on a single-domain failure.
export const assembleContext = async ({ district, cognitoSub, userMessage, parcelId = null, intent = null, weatherFn = getWeather } = {}) => {
  const startedAt = Date.now();
  const timings = {};
  const resolvedIntent = intent || classifyIntent(userMessage);
  const needs = CONTEXT_NEEDS[resolvedIntent] || CONTEXT_NEEDS[INTENTS.GENERAL_AGRICULTURE];
  const messageCrop = detectCrop(userMessage);

  const snapshot = {
    intent: resolvedIntent,
    farmProfile: { status: "unknown", note: "No farm profile yet (E2-S4)." },
    parcels: { count: 0, selected: null, provenance: "missing", source: "no_parcels" },
    weather: { status: "unknown" },
    soil: { status: "unknown" },
    claims: null,
    crop: messageCrop || "unknown",
    district: fmt(district) || "unknown",
    slots: { district: fmt(district) ? slot(district, "user_provided", "request") : MISSING(), crop: messageCrop ? slot(messageCrop, "user_provided", "message") : MISSING() },
    loaded: { profile: false, weather: false, soil: false, claims: false },
    timings,
  };

  // Farm profile (E2-S4): auto-loaded for the caller (scoped by cognitoSub, E1-S5/D-35). Its
  // district, crops and parcels are the farmer's own statements; they override a request district.
  let profile = null;
  if (needs.profile && cognitoSub) {
    const t0 = Date.now();
    try {
      profile = await farmProfileService.getByUser(cognitoSub);
      snapshot.loaded.profile = true;
    } catch (error) {
      logger.warn({ cognitoSub, err: error }, "context.farm_profile_resolution_failed");
      snapshot.farmProfile = { status: "unknown", note: "Farm profile resolution failed." };
    }
    timings.profileMs = Date.now() - t0;
  }

  if (profile) {
    snapshot.farmProfile = { status: "ok", district: profile.district, crops: profile.crops, acres: profile.acres, language: profile.language || null };
    snapshot.district = profile.district;
    snapshot.slots.district = slot(profile.district, "user_provided", "farm_profile");

    const parcel = resolveParcel({ parcels: profile.parcels, parcelId });
    snapshot.parcels = {
      count: parcel.count,
      selected: parcel.selected
        ? { name: parcel.selected.name, crop: parcel.selected.crop || null, areaAcres: parcel.selected.calculatedAreaAcres ?? null }
        : null,
      provenance: parcel.provenance,
      source: parcel.source,
    };
    snapshot.slots.crop = resolveCropSlot({ messageCrop, parcel: parcel.selected, profileCrops: profile.crops });
    snapshot.crop = snapshot.slots.crop.value || "unknown";
  }

  const effectiveDistrict = snapshot.slots.district.value;

  // Weather (E2-S1): cache-first, never throws; only loaded when the intent uses it.
  if (needs.weather) {
    const t0 = Date.now();
    try {
      if (effectiveDistrict) {
        const w = await weatherFn(effectiveDistrict);
        if (w && w.status !== "unknown" && w.current) {
          snapshot.weather = {
            status: w.freshness === "stale" ? "stale" : "ok",
            temperature: w.current.temperature,
            summary: w.current.summary,
            windspeed: w.current.windspeed,
            ageSeconds: w.ageSeconds ?? null,
            forecast: Array.isArray(w.forecast) ? w.forecast.slice(0, 3) : [],
          };
          snapshot.loaded.weather = true;
        } else {
          snapshot.weather = { status: "unknown", note: (w && w.note) || "Weather unavailable." };
        }
      } else {
        snapshot.weather = { status: "unknown", note: "No district known." };
      }
    } catch (error) {
      logger.warn({ district: effectiveDistrict, err: error }, "context.weather_resolution_failed");
      snapshot.weather = { status: "unknown", note: "Weather resolution failed." };
    }
    timings.weatherMs = Date.now() - t0;
  }

  // Region / soil (E2-S2 `districts`): regionType is curated reference data; soilType is reserved and
  // empty (D-19), so soil degrades to unknown and the assistant recommends a soil test.
  if (needs.soil) {
    const t0 = Date.now();
    try {
      if (effectiveDistrict) {
        const d = await District.findOne({ name: new RegExp(`^${escapeRegex(String(effectiveDistrict))}$`, "i") }).lean().exec();
        if (d) {
          snapshot.soil = { status: "ok", regionType: d.regionType, soilType: fmt(d.soilType) || "unknown" };
          snapshot.district = d.name;
          snapshot.loaded.soil = true;
        } else {
          snapshot.soil = { status: "unknown", note: `District "${sanitizeInline(effectiveDistrict)}" not in reference data.` };
        }
      } else {
        snapshot.soil = { status: "unknown", note: "No district known." };
      }
    } catch (error) {
      logger.warn({ district: effectiveDistrict, err: error }, "context.soil_resolution_failed");
      snapshot.soil = { status: "unknown", note: "Soil resolution failed." };
    }
    timings.soilMs = Date.now() - t0;
  }

  // The farmer's own recent claims, only for claim questions. Owner-scoped; no ids are rendered.
  if (needs.claims && cognitoSub) {
    const t0 = Date.now();
    try {
      snapshot.claims = await summarizeClaims(cognitoSub);
      snapshot.loaded.claims = true;
    } catch (error) {
      logger.warn({ err: error }, "context.claims_resolution_failed");
    }
    timings.claimsMs = Date.now() - t0;
  }

  snapshot.sufficiency = assessSufficiency({ intent: resolvedIntent, slots: snapshot.slots });
  timings.totalMs = Date.now() - startedAt;
  logger.info(
    { intent: resolvedIntent, district: snapshot.district, farmProfile: snapshot.farmProfile.status, sufficient: snapshot.sufficiency.sufficient, loaded: snapshot.loaded, durationMs: timings.totalMs },
    "context.assembled"
  );
  return snapshot;
};

const tag = (provenance, source) => `[${provenance}${source ? ` · ${source}` : ""}]`;
const SOURCE_LABEL = {
  farm_profile: "farm profile",
  request: "this message",
  message: "this message",
  selected_parcel: "selected parcel",
  explicit_selection: "selected parcel",
  only_parcel: "the farmer's only parcel",
};

// Render the snapshot into a labelled, deterministic plain-text "Context" block (D-03 Option 1).
// Separate from user content so the prompt-injection boundary stays explicit (09 §11). Every value
// is flattened with sanitizeInline.
export const renderContextBlock = (snapshot) => {
  const lines = ["Context (every item shows where it came from):"];
  const district = snapshot.slots && snapshot.slots.district;
  lines.push(
    district && district.value
      ? `- District: ${sanitizeInline(snapshot.district)} ${tag(district.provenance, SOURCE_LABEL[district.source] || district.source)}`
      : "- District: unknown [missing]"
  );

  const crop = snapshot.slots && snapshot.slots.crop;
  if (crop && crop.value) {
    lines.push(`- Crop: ${sanitizeInline(crop.value)} ${tag(crop.provenance, SOURCE_LABEL[crop.source] || crop.source)}`);
  } else if (crop && Array.isArray(crop.options) && crop.options.length > 1) {
    lines.push(`- Crop: the farmer grows several (${crop.options.map((option) => sanitizeInline(option, 40)).join(", ")}); which one is not specified [ambiguous]`);
  } else {
    lines.push("- Crop: not mentioned [missing]");
  }

  if (snapshot.farmProfile.status === "ok") {
    const crops = (snapshot.farmProfile.crops || []).map((entry) => sanitizeInline(entry, 40)).join(", ");
    lines.push(`- Farm profile: crops ${crops}; total area ${snapshot.farmProfile.acres} acres [user_provided · farm profile]`);
  } else {
    lines.push("- Farm profile: unknown [missing]");
  }

  const parcels = snapshot.parcels || { count: 0 };
  if (parcels.selected) {
    const area = parcels.selected.areaAcres != null ? `, ${parcels.selected.areaAcres} acres (computed by the server from the drawn boundary)` : "";
    lines.push(`- Parcel in question: ${sanitizeInline(parcels.selected.name || "unnamed")}${parcels.selected.crop ? `, crop ${sanitizeInline(parcels.selected.crop, 40)}` : ""}${area} ${tag(parcels.provenance, SOURCE_LABEL[parcels.source] || parcels.source)}`);
  } else if (parcels.count > 1) {
    lines.push(`- Parcels: the farmer has ${parcels.count} registered parcels and none is selected for this question`);
  }

  if (snapshot.weather.status === "ok" || snapshot.weather.status === "stale") {
    const stale = snapshot.weather.status === "stale";
    lines.push(`- Weather now: ${snapshot.weather.summary}, ${snapshot.weather.temperature}°C, wind ${snapshot.weather.windspeed} km/h ${tag(stale ? "stale" : "third_party", `Open-Meteo${stale ? ", may be out of date" : ""}`)}`);
    const days = (snapshot.weather.forecast || []).filter((day) => day && day.date);
    if (days.length > 0) {
      lines.push(`- Forecast: ${days.map((day) => `${day.date} ${day.temperatureMin ?? "?"}-${day.temperatureMax ?? "?"}°C, rain ${day.precipitation ?? "?"} mm`).join("; ")} [third_party · Open-Meteo]`);
    }
  } else if (snapshot.weather.status === "unknown" && snapshot.loaded && snapshot.intent && CONTEXT_NEEDS[snapshot.intent] && CONTEXT_NEEDS[snapshot.intent].weather) {
    lines.push("- Weather: unknown [missing]");
  }

  if (snapshot.soil.status === "ok") {
    lines.push(`- Region type: ${sanitizeInline(snapshot.soil.regionType)} [verified · district reference data]`);
    // No soil source exists (D-19): never present a guess as a measurement.
    lines.push(`- Soil: ${snapshot.soil.soilType === "unknown" ? "not measured and not available. Recommend a soil test; do not guess the soil type [missing]" : `${sanitizeInline(snapshot.soil.soilType)} (typical for the district) [verified · district reference data]`}`);
  }

  if (snapshot.claims) {
    if (snapshot.claims.length === 0) lines.push("- Claims: the farmer has no claims on record");
    else lines.push(`- Recent claims (newest first): ${snapshot.claims.map((claim) => `${claim.eventType} on ${claim.eventDate}, ${claim.areaAcres} acres, status ${claim.state}`).join("; ")} [verified · claim records]`);
  }

  lines.push("Use this context to personalize your advice. Items marked missing, ambiguous, inferred or stale must not be stated as fact, and 'unknown' data must not be claimed as known.");
  if (snapshot.sufficiency) {
    const instruction = buildFollowUpInstruction(snapshot.sufficiency);
    if (instruction) lines.push(instruction);
  }
  return lines.join("\n");
};

export const assembleContextAndRender = async (args) => {
  const snapshot = await assembleContext(args);
  return renderContextBlock(snapshot);
};

export default { assembleContext, renderContextBlock, assembleContextAndRender, sanitizeInline, detectCrop };
