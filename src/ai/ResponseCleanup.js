// Post-generation response cleanup. Runs on the raw model text to improve
// readability/quality without changing meaning. Never logs or inspects content
// beyond formatting — no PII logging here.

const dedupeBlankLines = (text) => text.replace(/\n{3,}/g, "\n\n").trim();

// Remove a heading that duplicates the nearest preceding heading, ignoring any
// blank lines between them (models often emit "## X\n\n## X"). Only *consecutive*
// duplicates (separated solely by blanks) are collapsed; distinct sections that
// happen to share a heading name retain both headings.
const dedupeRepeatedHeadings = (text) => {
  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    const isHeading = /^#{1,6}\s/.test(line);
    if (isHeading) {
      // Find last non-blank kept line.
      let j = out.length - 1;
      while (j >= 0 && out[j].trim() === "") j--;
      if (j >= 0 && out[j] === line) {
        // Same heading repeated with only blanks in between -> drop duplicate.
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
};

// Normalize bullet lists: lines that look like bullets use "- ".
const normalizeBullets = (text) =>
  text.replace(/^\s*[*•]\s+/gm, "- ").replace(/^---\s*$/gm, "");

export const cleanupResponse = (text) => {
  if (!text || typeof text !== "string") return "";
  let cleaned = normalizeBullets(text);
  // Dedupe headings first (blank-transparent) so a dropped heading's surrounding
  // blanks are then collapsed by the final pass below.
  cleaned = dedupeRepeatedHeadings(cleaned);
  cleaned = dedupeBlankLines(cleaned);
  return cleaned;
};

export default { cleanupResponse };
