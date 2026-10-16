import { REQUIRED_SLOTS, INTENTS } from "./Intent.js";

// Context sufficiency: after the farmer's own records have been consulted, decide whether the
// assistant may answer or must ask. The rule is deliberately narrow:
//   - ask ONLY when a REQUIRED slot is still unresolved, and ask about exactly ONE thing;
//   - a slot that is ambiguous (several parcels with different crops) is a question about WHICH one,
//     not a request to retype something the system already knows;
//   - never ask for anything the Context already lists as known.
//
// A slot is { value, provenance, options? }: `value` null with `options` means ambiguous.

export const assessSufficiency = ({ intent, slots }) => {
  const required = REQUIRED_SLOTS[intent] || [];
  const missing = [];
  const ambiguous = [];
  for (const name of required) {
    const slot = slots && slots[name];
    if (slot && slot.value) continue;
    if (slot && Array.isArray(slot.options) && slot.options.length > 1) ambiguous.push({ slot: name, options: slot.options });
    else missing.push(name);
  }

  let followUp = null;
  if (ambiguous.length > 0) followUp = { slot: ambiguous[0].slot, reason: "ambiguous", options: ambiguous[0].options };
  else if (missing.length > 0) followUp = { slot: missing[0], reason: "missing" };

  return { intent, sufficient: !followUp, missing, ambiguous, followUp };
};

// The instruction injected into the prompt. Stated as a hard rule because the previous template only
// told the model to ask a clarifying question whenever the text ended with "?".
export const buildFollowUpInstruction = (sufficiency) => {
  if (sufficiency.intent === INTENTS.GREETING) return "";
  if (sufficiency.sufficient) {
    return "Follow-up policy: you have what you need. Answer directly. Do NOT ask the farmer for their district, crop, area or other details that the Context lists as known.";
  }
  const { slot, reason, options } = sufficiency.followUp;
  if (reason === "ambiguous") {
    return `Follow-up policy: the farmer has several options for "${slot}" (${options.join(", ")}) and the answer depends on which. Ask ONE short question asking which they mean, and nothing else.`;
  }
  return `Follow-up policy: the "${slot}" is not known and the answer depends on it. Ask ONE short question about the ${slot}, and nothing else. Do not ask about anything else.`;
};

export default { assessSufficiency, buildFollowUpInstruction };
