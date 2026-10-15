import { describe, expect, it } from "vitest";
import { CONTEXT_NEEDS, INTENTS, REQUIRED_SLOTS, classifyIntent } from "../src/ai/Intent.js";
import { assessSufficiency, buildFollowUpInstruction } from "../src/ai/ContextSufficiency.js";

describe("classifyIntent", () => {
  const cases = [
    ["hello", INTENTS.GREETING],
    ["வணக்கம்", INTENTS.GREETING],
    ["Good morning, farmer here", INTENTS.GREETING],
    ["what is the status of my claim?", INTENTS.CLAIM_STATUS],
    ["என் இழப்பீடு கோரிக்கை என்ன ஆனது", INTENTS.CLAIM_STATUS],
    ["which crop should I grow this season?", INTENTS.CROP_RECOMMENDATION],
    ["எந்த பயிர் நல்லது", INTENTS.CROP_RECOMMENDATION],
    ["my paddy leaves are turning yellow with brown spots", INTENTS.DISEASE_DIAGNOSIS],
    ["நெல் இலை மஞ்சள் ஆகிறது", INTENTS.DISEASE_DIAGNOSIS],
    ["how much urea should I apply", INTENTS.FERTILIZER],
    ["when should I irrigate", INTENTS.IRRIGATION],
    ["will it rain this week", INTENTS.WEATHER_PLANNING],
    ["how to store harvested grain", INTENTS.GENERAL_AGRICULTURE],
    ["", INTENTS.UNCLEAR],
    ["help?", INTENTS.UNCLEAR],
  ];
  it.each(cases)("CI-1: %j -> %s", (message, expected) => {
    expect(classifyIntent(message)).toBe(expected);
  });

  it("CI-2: a question mark alone no longer makes a real question a clarification request", () => {
    // Previously ANY message ending in "?" containing 'what' or 'how' was routed to "ask a question".
    expect(classifyIntent("what is the best time to harvest sugarcane?")).toBe(INTENTS.GENERAL_AGRICULTURE);
    expect(classifyIntent("how do I control stem borer in rice?")).toBe(INTENTS.DISEASE_DIAGNOSIS);
  });

  it("CI-3: a crop-recommendation question wins over symptom words", () => {
    expect(classifyIntent("which crop is good after the flood damage")).toBe(INTENTS.CROP_RECOMMENDATION);
  });

  it("CI-4: every intent declares required slots and context needs", () => {
    for (const intent of Object.values(INTENTS)) {
      expect(Array.isArray(REQUIRED_SLOTS[intent])).toBe(true);
      expect(CONTEXT_NEEDS[intent]).toBeTruthy();
    }
  });

  it("CI-5: greetings and claim questions load no weather; only claim questions load claims", () => {
    expect(CONTEXT_NEEDS[INTENTS.GREETING]).toEqual({ profile: false, weather: false, soil: false, claims: false });
    expect(CONTEXT_NEEDS[INTENTS.CLAIM_STATUS].weather).toBe(false);
    for (const intent of Object.values(INTENTS)) {
      expect(CONTEXT_NEEDS[intent].claims).toBe(intent === INTENTS.CLAIM_STATUS);
    }
  });
});

describe("assessSufficiency", () => {
  it("CS-1: a resolved required slot means no follow-up", () => {
    const result = assessSufficiency({ intent: INTENTS.DISEASE_DIAGNOSIS, slots: { crop: { value: "Paddy", provenance: "user_provided" } } });
    expect(result.sufficient).toBe(true);
    expect(result.followUp).toBeNull();
  });

  it("CS-2: an unresolved required slot asks exactly one thing", () => {
    const result = assessSufficiency({ intent: INTENTS.CROP_RECOMMENDATION, slots: { district: { value: null } } });
    expect(result.sufficient).toBe(false);
    expect(result.followUp).toEqual({ slot: "district", reason: "missing" });
  });

  it("CS-3: several candidate crops make it a question about WHICH one, never a request to retype it", () => {
    const result = assessSufficiency({ intent: INTENTS.IRRIGATION, slots: { crop: { value: null, options: ["Paddy", "Sugarcane"] } } });
    expect(result.followUp).toMatchObject({ slot: "crop", reason: "ambiguous", options: ["Paddy", "Sugarcane"] });
  });

  it("CS-4: intents with no required slots never ask", () => {
    for (const intent of [INTENTS.GREETING, INTENTS.CLAIM_STATUS, INTENTS.GENERAL_AGRICULTURE, INTENTS.UNCLEAR]) {
      expect(assessSufficiency({ intent, slots: {} }).sufficient).toBe(true);
    }
  });

  it("CS-5: ambiguity is asked before a plain missing slot, and only one question results", () => {
    const result = assessSufficiency({ intent: INTENTS.CROP_RECOMMENDATION, slots: { district: { value: null } } });
    expect(result.missing).toEqual(["district"]);
    expect(buildFollowUpInstruction(result)).toContain("ONE short question");
  });
});

describe("buildFollowUpInstruction", () => {
  it("CS-6: when sufficient it forbids asking for details the Context lists as known", () => {
    const text = buildFollowUpInstruction({ intent: INTENTS.IRRIGATION, sufficient: true });
    expect(text).toContain("Answer directly");
    expect(text).toContain("Do NOT ask");
  });

  it("CS-7: a greeting gets no policy text", () => {
    expect(buildFollowUpInstruction({ intent: INTENTS.GREETING, sufficient: true })).toBe("");
  });

  it("CS-8: an ambiguous slot lists the options and asks only which", () => {
    const text = buildFollowUpInstruction(assessSufficiency({ intent: INTENTS.FERTILIZER, slots: { crop: { value: null, options: ["Paddy", "Cotton"] } } }));
    expect(text).toContain("Paddy, Cotton");
    expect(text).toContain("which they mean");
  });
});
