// The advisory source list and the HTML-to-text extraction for it. Pure (no network, no filesystem).
//
// The seeds are whole crop sections of the TNAU Agritech Portal, not single pages chosen to answer a
// test question. They were still chosen knowing which crops the evaluation queries name, so results
// on the advisory queries are optimistic and must be reported as such.

const TNAU = "https://agritech.tnau.ac.in";
const ISSUER = "Tamil Nadu Agricultural University (TNAU Agritech Portal)";
const seed = (id, crop, path, scope, maxPages = 90, maxDepth = 2) => ({ id, crop, issuer: ISSUER, url: `${TNAU}/${path}`, scope: `${TNAU}/${scope}`, maxPages, maxDepth });

export const ADVISORY_SEEDS = Object.freeze([
  seed("tnau-paddy", "rice", "expert_system/paddy/Index.html", "expert_system/paddy/", 120),
  seed("tnau-sugarcane", "sugarcane", "expert_system/sugar/index.html", "expert_system/sugar/"),
  seed("tnau-banana", "banana", "expert_system/banana/index.html", "expert_system/banana/"),
  seed("tnau-ragi", "ragi", "expert_system/ragi/index.html", "expert_system/ragi/"),
  seed("tnau-coconut", "coconut", "expert_system/coconut/coconut/index.html", "expert_system/coconut/coconut/"),
  seed("tnau-groundnut", "groundnut", "agriculture/agri_cropproduction_oilseeds%20index%20ground%20nut.html", "agriculture/", 25, 1),
  seed("tnau-groundnut-pht", "groundnut", "postharvest/pht_groundnut.html", "postharvest/pht_groundnut", 3, 0),
  seed("tnau-oilseeds-pht", "groundnut", "postharvest/pht_oilseeds.html", "postharvest/pht_oilseeds", 3, 0),
  seed("tnau-tomato-protection", "tomato", "crop_protection/tomato/tomato_1.html", "crop_protection/tomato/", 25, 2),
  seed("tnau-pulses", "pulses", "agriculture/pulses_index.html", "agriculture/", 25, 1),
  seed("tnau-crop-insurance", "", "crop_insurance/crop_ins.html", "crop_insurance/", 15, 1),
  seed("tnau-pmfby-pdf", "", "pdf/pmfby.pdf", "pdf/pmfby", 1, 0),
]);

// Site chrome and non-agronomic pages of these sections.
const SKIP_LINK = /(aboutus|about_us|contact|index_ta|_ta\.html|\/ta\/|sitemap|relatedlinks|links\.html|agrllinks|marketing|institution|schemes|faq|video|\.swf|\.css|\.js$|\.jpe?g|\.png|\.gif|images\/)/i;

export const extractLinks = (html, baseUrl) => {
  const links = [];
  for (const match of String(html).matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&").trim(), baseUrl);
      url.protocol = "https:";
      if (url.hostname === "www.agritech.tnau.ac.in") url.hostname = "agritech.tnau.ac.in";
      url.search = "";
      links.push(url.href);
    } catch {
      /* an unusable href is not a page */
    }
  }
  return [...new Set(links)];
};

export const isCrawlableLink = (url, { scope }) => decodeURI(url).startsWith(decodeURI(scope)) && /\.html?$/i.test(url) && !SKIP_LINK.test(decodeURI(url));

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", deg: "°", micro: "µ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', frac12: "1/2", frac14: "1/4", times: "x" };
const decodeEntities = (text) =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z0-9]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);

const CHROME_LINE = /^(home|about us|contact( us)?|site ?map|disclaimer|faq'?s?|success stories|farmers?'? (association|innovation)s?|related links|print|top|back|next|previous|click here.*|.*all rights reserved.*|.*updated on.*|.*best viewed.*)$/i;
const SCRIPT_RESIDUE = /(_gat\.|pageTracker|document\.write|gaJsHost|function\s*\(|\bvar\s+\w+\s*=|\{\s*[a-z-]+\s*:)/i;

// Page text, one block per line. Table rows stay on one line as "a | b | c" so a dose stays next to
// its label. Headings are returned as "# heading" lines.
export const htmlToText = (html) => {
  const body = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(title|script|style|noscript|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/t[dh]>\s*<t[dh]\b/gi, "</td> | <td")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n# ")
    .replace(/<\/(h[1-6]|p|div|tr|li|table|ul|ol|center)>|<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  const lines = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[\s ]+/g, " ").replace(/^(\| )+|( \|)+$/g, "").trim())
    .filter((line) => line && !CHROME_LINE.test(line) && !SCRIPT_RESIDUE.test(line) && !/^[|\s-]+$/.test(line) && !/^home\b.*\|/i.test(line));
  return dropMenuRuns(lines).join("\n");
};

// Portal menus survive as runs of short lines with no numbers and no table cells. A run of four or
// more is dropped; real headings and table rows are not in such runs.
const isMenuLine = (line) => line.length < 45 && !line.startsWith("# ") && !/[|\d.:]/.test(line);
export const dropMenuRuns = (lines, minRun = 4) => {
  const kept = [];
  for (let i = 0; i < lines.length; ) {
    let end = i;
    while (end < lines.length && isMenuLine(lines[end])) end += 1;
    if (end - i >= minRun) i = end;
    else {
      kept.push(...lines.slice(i, Math.max(end, i + 1)));
      i = Math.max(end, i + 1);
    }
  }
  return kept;
};

export const htmlTitle = (html) => {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim().slice(0, 160) : "";
};

export default { ADVISORY_SEEDS, extractLinks, isCrawlableLink, htmlToText, htmlTitle };
