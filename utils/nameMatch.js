// Deterministic comparison of person and place names across Tamil and Latin scripts. It exists for
// ONE job: telling "the same name, spelled differently" apart from "a different name", so a land
// document is not flagged merely because it says "முருகன்" and the account says "Murugan". It is a
// review aid, not an identity check. The result is match | partial | mismatch and nothing more.
//
// Method: reduce each name token to a consonant skeleton (Tamil letters mapped to Latin consonants,
// vowels and the glides w/y dropped, voiced/unvoiced pairs merged, doubles collapsed) and compare skeletons by edit
// distance. This is deliberately lenient about vowels (Tamil romanisation varies widely) and strict
// about consonant order.

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "thiru", "thirumathi", "tmt", "selvi", "shri", "sri", "smt", "late", "thiru.", "tr", "mr."]);
const RELATION = /\b(s\s*\/\s*o|d\s*\/\s*o|w\s*\/\s*o|c\s*\/\s*o|son of|daughter of|wife of|care of|father|husband)\b/i;

// Tamil letter -> Latin consonant skeleton. Vowels and vowel signs map to "" (dropped).
const TAMIL = {
  க: "k", ங: "n", ச: "s", ஞ: "n", ட: "t", ண: "n", த: "t", ந: "n", ப: "p", ம: "m",
  ய: "", ர: "r", ல: "l", வ: "v", ழ: "l", ள: "l", ற: "r", ன: "n",
  ஜ: "s", ஷ: "s", ஸ: "s", ஹ: "h", க்ஷ: "ks",
};
const transliterateTamil = (text) => {
  let out = "";
  for (const char of text) out += TAMIL[char] !== undefined ? TAMIL[char] : /[஀-௿]/.test(char) ? "" : char;
  return out;
};

const stripDiacritics = (text) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "");

export const skeleton = (token) => {
  let t = stripDiacritics(transliterateTamil(String(token || "").toLowerCase()));
  t = t.replace(/[^a-z]/g, "");
  t = t.replace(/th|dh/g, "t").replace(/sh|ch|zh/g, (m) => (m === "zh" ? "l" : "s")).replace(/ph/g, "p").replace(/kh|gh/g, "k");
  t = t.replace(/[gc]/g, "k").replace(/d/g, "t").replace(/b/g, "p").replace(/[jz]/g, "s").replace(/[wy]/g, "").replace(/f/g, "p").replace(/q/g, "k").replace(/x/g, "ks");
  t = t.replace(/[aeiou]/g, "");
  return t.replace(/(.)\1+/g, "$1");
};

// Name -> list of comparable tokens, with relation suffixes ("s/o Kandasamy") and honorifics removed.
export const nameTokens = (name) => {
  let text = String(name || "").normalize("NFKC");
  const relation = text.search(RELATION);
  if (relation > 0) text = text.slice(0, relation);
  return text
    .toLowerCase()
    .replace(/[.,;:()[\]{}"'`]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !HONORIFICS.has(token));
};

const editDistance = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
};

// Two tokens are "the same" when their skeletons are close, or one is an initial of the other.
export const tokensMatch = (a, b) => {
  const sa = skeleton(a);
  const sb = skeleton(b);
  const rawA = stripDiacritics(transliterateTamil(a)).replace(/[^a-z]/g, "");
  const rawB = stripDiacritics(transliterateTamil(b)).replace(/[^a-z]/g, "");
  if (rawA && rawA === rawB) return true;
  if (rawA.length === 1 || rawB.length === 1) {
    // An initial ("S" for "Subramanian", "A" for "Arumugam") matches a token that starts with the
    // same letter, or with the same consonant sound.
    const [initial, other] = rawA.length === 1 ? [rawA, rawB] : [rawB, rawA];
    if (!other) return false;
    return other.startsWith(initial) || (skeleton(initial) !== "" && skeleton(initial) === skeleton(other).slice(0, 1));
  }
  if (!sa || !sb) return rawA === rawB && rawA !== "";
  if (sa === sb) return true;
  const longest = Math.max(sa.length, sb.length);
  return longest >= 3 && 1 - editDistance(sa, sb) / longest >= 0.75;
};

// match   : every token of the shorter name is matched in the other and the token counts are equal;
// partial : at least half of the tokens match (extra or missing tokens, one different token);
// mismatch: otherwise. null when either side has no usable tokens.
export const compareNames = (a, b) => {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return null;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set();
  let matched = 0;
  for (const token of short) {
    const index = long.findIndex((candidate, i) => !used.has(i) && tokensMatch(token, candidate));
    if (index !== -1) { used.add(index); matched += 1; }
  }
  if (matched === short.length && ta.length === tb.length) return "match";
  if (matched === short.length) return "partial"; // every token of the shorter name appears in the longer one
  return matched / long.length >= 0.5 ? "partial" : "mismatch";
};

// Best result across several recorded holders: one matching holder is enough.
export const compareToHolders = (holders, name) => {
  const order = { match: 3, partial: 2, mismatch: 1 };
  let best = null;
  for (const holder of holders || []) {
    const result = compareNames(holder, name);
    if (result && (!best || order[result] > order[best])) best = result;
  }
  return best;
};

// Place names (district, village): equal when their whole-name skeletons are close.
export const placesMatch = (a, b) => {
  const sa = skeleton(a);
  const sb = skeleton(b);
  if (!sa || !sb) return null;
  if (sa === sb) return true;
  const longest = Math.max(sa.length, sb.length);
  return longest >= 3 && 1 - editDistance(sa, sb) / longest >= 0.8;
};

export default { nameTokens, skeleton, tokensMatch, compareNames, compareToHolders, placesMatch };
