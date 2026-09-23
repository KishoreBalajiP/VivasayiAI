// Context assembly — first slice of the Context Engine (E2-S3, ADR-014, D-01/D-03).
// Runs before the LLM invocation: resolves each domain from its source of truth, degrades
// any missing domain to an explicit `unknown` marker (ADR-014 assembly rule 1 — never block,
// never fabricate), and renders a labelled plain-text "Context" block for the prompt builder.
//
// Domains in this slice:
//   1. Farm profile  — E2-S4 `profiles` collection, auto-loaded for a user (D-14). Its district
//                      and crops drive the other domains (zero-question continuity). Missing -> `unknown`.
//   2. Weather       — E2-S1 `getWeather` (cache-first, never throws)
//   3. Soil / region — E2-S2 `districts` collection (soilType reservation is empty -> `unknown`; regionType present)
//   4. Crop          — from the farm profile when present, else inferred from the user message when a
//                      known TN crop is named, else `unknown`
// RAG is assembled separately in chat.service and appended by the prompt builder.
import logger from "../utils/logger.js";
import { getWeather } from "./weather.service.js";
import District from "../models/District.js";
import * as farmProfileService from "./farmProfile.service.js";

// A small set of the dominant Tamil Nadu crops used only to detect an explicit crop mention
// (matches the legacy {{crop_name}} placeholder intent). This is NOT a soil/crop reference
// table (that is E2-S2 / D-19 territory); it is a mention-detection vocabulary.
const CROP_ALIASES = Object.freeze({
  paddy: ["paddy", "rice", "நெல்", "சம்பா", "குறுவை"],
  sugarcane: ["sugarcane", "கரும்பு", "சர்க்கரை"],
  cotton: ["cotton", "பருத்தி"],
  groundnut: ["groundnut", "kadalai", "veriyal", "வேர்க்கடலை", "கடலை"],
  maize: ["maize", "corn", "cholam", "সோளம்", "மக்காச்சோளம்"],
  tomato: ["tomato", "thakkali", "தக்காளி"],
  chilli: ["chilli", "chili", "milagai", "மிளகாய்"],
  banana: ["banana", "vazhai", "வாழை"],
  coconut: ["coconut", "thengai", "தேங்காய்"],
  ragi: ["ragi", "kezhvaragu", "கேழ்வரகு"],
});

const detectCrop = (message) => {
  const m = (message || "").toLowerCase();
  for (const [crop, aliases] of Object.entries(CROP_ALIASES)) {
    if (aliases.some((a) => m.includes(a.toLowerCase()))) return crop;
  }
  return null;
};

const fmt = (value) => (value === undefined || value === null || value === "" ? null : value);

// Resolve all domains into a plain snapshot. Never throws on a single-domain failure — each
// resolver degrades to `unknown` (ADR-014 rule 1). `cognitoSub` auto-loads the caller's farm profile
// (D-14); when present, the profile's district and crops drive weather/soil/crop resolution.
export const assembleContext = async ({ district, cognitoSub, userMessage } = {}) => {
  const startedAt = Date.now();
  const snapshot = {
    farmProfile: { status: "unknown", note: "No farm profile yet (E2-S4)." },
    weather: { status: "unknown" },
    soil: { status: "unknown" },
    crop: detectCrop(userMessage) || "unknown",
    district: fmt(district) || "unknown",
  };

  // Domain: farm profile (E2-S4). Auto-load for the caller (scoped by cognitoSub, E1-S5/D-35);
  // its district/crops become the authoritative context (D-14), overriding any request-supplied district.
  let profileDistrict = district;
  try {
    if (cognitoSub) {
      const p = await farmProfileService.getByUser(cognitoSub);
      if (p) {
        snapshot.farmProfile = {
          status: "ok",
          district: p.district,
          crops: p.crops,
          acres: p.acres,
        };
        profileDistrict = p.district;
        // Crops from the profile drive the crop domain (first listed crop).
        if (Array.isArray(p.crops) && p.crops.length > 0) snapshot.crop = p.crops[0];
        snapshot.district = p.district;
      }
    }
  } catch (error) {
    logger.warn({ cognitoSub, err: error }, "context.farm_profile_resolution_failed");
    snapshot.farmProfile = { status: "unknown", note: "Farm profile resolution failed." };
  }
  const effectiveDistrict = profileDistrict || fmt(district);

  // Domain: weather (E2-S1). Never throws; getWeather degrades to status "unknown".
  try {
    if (effectiveDistrict) {
      const w = await getWeather(effectiveDistrict);
      if (w && w.status !== "unknown" && w.current) {
        snapshot.weather = {
          status: "ok",
          temperature: w.current.temperature,
          summary: w.current.summary,
          windspeed: w.current.windspeed,
        };
      } else {
        snapshot.weather = { status: "unknown", note: w?.note || "Weather unavailable." };
      }
    } else {
      snapshot.weather = { status: "unknown", note: "No district provided." };
    }
  } catch (error) {
    logger.warn({ district: effectiveDistrict, err: error }, "context.weather_resolution_failed");
    snapshot.weather = { status: "unknown", note: "Weather resolution failed." };
  }

  // Domain: soil / region (E2-S2 `districts` collection). soilType is a reserved-but-empty
  // field (D-19) -> regionType is authoritative, soilType degrades to unknown (D-21).
  try {
    if (effectiveDistrict) {
      const d = await District.findOne({ name: effectiveDistrict }).lean().exec();
      if (d) {
        snapshot.soil = {
          status: "ok",
          regionType: d.regionType,
          soilType: fmt(d.soilType) || "unknown",
        };
        snapshot.district = d.name;
      } else {
        snapshot.soil = { status: "unknown", note: `District "${effectiveDistrict}" not in reference data.` };
      }
    } else {
      snapshot.soil = { status: "unknown", note: "No district provided." };
    }
  } catch (error) {
    logger.warn({ district: effectiveDistrict, err: error }, "context.soil_resolution_failed");
    snapshot.soil = { status: "unknown", note: "Soil resolution failed." };
  }

  logger.info({ district: snapshot.district, farmProfile: snapshot.farmProfile.status, durationMs: Date.now() - startedAt }, "context.assembled");
  return snapshot;
};

// Render the snapshot into a labelled, deterministic plain-text "Context" block (D-03 Option 1).
// Separate from user content so the prompt-injection boundary stays explicit (09 §11).
export const renderContextBlock = (snapshot) => {
  const lines = [];
  lines.push("Context:");
  lines.push(`- District: ${snapshot.district}`);
  if (snapshot.farmProfile.status === "ok") {
    const cropList = snapshot.farmProfile.crops || [];
    lines.push(`- Farm profile: known (district ${snapshot.farmProfile.district}, crops: ${cropList.join(", ")}, area: ${snapshot.farmProfile.acres} acres)`);
  } else {
    lines.push("- Farm profile: unknown");
  }
  if (snapshot.weather.status === "ok") {
    lines.push(`- Weather: ${snapshot.weather.summary}, ${snapshot.weather.temperature}°C, wind ${snapshot.weather.windspeed} km/h`);
  } else {
    lines.push("- Weather: unknown");
  }
  if (snapshot.soil.status === "ok") {
    lines.push(`- Region type: ${snapshot.soil.regionType}`);
    // District-level soil is empty for every seeded district today (D-19 backfilles later
    // from the TNAU soil table). It must not read as a prerequisite: it is rendered as an
    // optional refinement. (The system prompt reinforces that general crop recommendations
    // never block on soil, per the crop-question fix.)
    lines.push(`- Soil type (typical for the district): ${snapshot.soil.soilType === "unknown" ? "not available (optional refinement only)" : snapshot.soil.soilType}`);
  } else {
    lines.push("- Soil type: unknown");
  }
  lines.push(`- Crop (if mentioned): ${snapshot.crop === "unknown" ? "not mentioned" : snapshot.crop}`);
  lines.push("Use this context to personalize your advice. Do not claim soil/weather data marked 'unknown' as fact.");
  return lines.join("\n");
};

export const assembleContextAndRender = async ({ district, cognitoSub, userMessage }) =>
  renderContextBlock(await assembleContext({ district, cognitoSub, userMessage }));

export default { assembleContext, renderContextBlock, assembleContextAndRender };
