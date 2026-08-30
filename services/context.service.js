// Context assembly — first slice of the Context Engine (E2-S3, ADR-014, D-01/D-03).
// Runs before the LLM invocation: resolves each domain from its source of truth, degrades
// any missing domain to an explicit `unknown` marker (ADR-014 assembly rule 1 — never block,
// never fabricate), and renders a labelled plain-text "Context" block for the prompt builder.
//
// Domains in this slice:
//   1. Farm profile  — E2-S4 not built yet -> always `unknown`
//   2. Weather       — E2-S1 `getWeather` (cache-first, never throws)
//   3. Soil / region — E2-S2 `districts` collection (soilType reservation is empty -> `unknown`; regionType present)
//   4. Crop          — inferred from the user message when a known TN crop is named, else `unknown`
// RAG is assembled separately in chat.service and appended by the prompt builder.
import logger from "../utils/logger.js";
import { getWeather } from "./weather.service.js";
import District from "../models/District.js";

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
// resolver degrades to `unknown` (ADR-014 rule 1).
export const assembleContext = async ({ district, userMessage } = {}) => {
  const startedAt = Date.now();
  const snapshot = {
    farmProfile: { status: "unknown", note: "No farm profile yet (E2-S4)." },
    weather: { status: "unknown" },
    soil: { status: "unknown" },
    crop: detectCrop(userMessage) || "unknown",
    district: fmt(district) || "unknown",
  };

  // Domain: farm profile (not built) -> unknown. Resolver present so E2-S4 fills it.

  // Domain: weather (E2-S1). Never throws; getWeather degrades to status "unknown".
  try {
    if (district) {
      const w = await getWeather(district);
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
    logger.warn({ district, err: error }, "context.weather_resolution_failed");
    snapshot.weather = { status: "unknown", note: "Weather resolution failed." };
  }

  // Domain: soil / region (E2-S2 `districts` collection). soilType is a reserved-but-empty
  // field (D-19) -> regionType is authoritative, soilType degrades to unknown (D-21).
  try {
    if (district) {
      const d = await District.findOne({ name: district }).lean().exec();
      if (d) {
        snapshot.soil = {
          status: "ok",
          regionType: d.regionType,
          soilType: fmt(d.soilType) || "unknown",
        };
        snapshot.district = d.name;
      } else {
        snapshot.soil = { status: "unknown", note: `District "${district}" not in reference data.` };
      }
    } else {
      snapshot.soil = { status: "unknown", note: "No district provided." };
    }
  } catch (error) {
    logger.warn({ district, err: error }, "context.soil_resolution_failed");
    snapshot.soil = { status: "unknown", note: "Soil resolution failed." };
  }

  logger.info({ district: snapshot.district, durationMs: Date.now() - startedAt }, "context.assembled");
  return snapshot;
};

// Render the snapshot into a labelled, deterministic plain-text "Context" block (D-03 Option 1).
// Separate from user content so the prompt-injection boundary stays explicit (09 §11).
export const renderContextBlock = (snapshot) => {
  const lines = [];
  lines.push("Context:");
  lines.push(`- District: ${snapshot.district}`);
  lines.push(`- Farm profile: ${snapshot.farmProfile.status === "ok" ? "known" : "unknown"}`);
  if (snapshot.weather.status === "ok") {
    lines.push(`- Weather: ${snapshot.weather.summary}, ${snapshot.weather.temperature}°C, wind ${snapshot.weather.windspeed} km/h`);
  } else {
    lines.push("- Weather: unknown");
  }
  if (snapshot.soil.status === "ok") {
    lines.push(`- Region type: ${snapshot.soil.regionType}`);
    lines.push(`- Soil type (typical for the district): ${snapshot.soil.soilType === "unknown" ? "unknown" : snapshot.soil.soilType}`);
  } else {
    lines.push("- Soil type: unknown");
  }
  lines.push(`- Crop (if mentioned): ${snapshot.crop === "unknown" ? "not mentioned" : snapshot.crop}`);
  lines.push("Use this context to personalize your advice. Do not claim soil/weather data marked 'unknown' as fact.");
  return lines.join("\n");
};

export const assembleContextAndRender = async ({ district, userMessage }) =>
  renderContextBlock(await assembleContext({ district, userMessage }));

export default { assembleContext, renderContextBlock, assembleContextAndRender };
