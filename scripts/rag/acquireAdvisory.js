import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonOnce } from "../live/lib/writeOnce.js";
import { ADVISORY_SEEDS, extractLinks, isCrawlableLink } from "../../rag/advisorySources.js";

// Downloads the public agronomic advisory pages named by rag/advisorySources.js, breadth first within
// each seed's scope, one request per second. Raw bytes go to the gitignored
// .rag-local/corpus/<tag>/raw/ because the source pages are marked "(c) TNAU, All Rights Reserved":
// the repository keeps only the manifest (URL, retrieval time, checksum, status). A page that fails is
// recorded as failed and never replaced by other text.
// Usage: node scripts/rag/acquireAdvisory.js --tag=<tag> [--delay-ms=1000]

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};
const tag = arg("tag");
const delayMs = Number(arg("delay-ms", "1000"));
if (!tag || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(tag)) {
  console.error("--tag=<tag> is required");
  process.exit(1);
}
const corpusDir = join(root, ".rag-local", "corpus", tag);
const rawDir = join(corpusDir, "raw");
if (existsSync(corpusDir)) {
  console.error(`Refusing to overwrite existing corpus: ${corpusDir}`);
  process.exit(2);
}
mkdirSync(rawDir, { recursive: true });
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const fetchOne = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { "user-agent": "VivasayiAI-research-corpus/1.0" } });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, finalUrl: response.url, contentType: response.headers.get("content-type") || "", lastModified: response.headers.get("last-modified"), bytes };
  } finally {
    clearTimeout(timer);
  }
};

const seen = new Set();
const documents = [];
for (const seed of ADVISORY_SEEDS) {
  const queue = [{ url: seed.url, depth: 0 }];
  let taken = 0;
  while (queue.length && taken < seed.maxPages) {
    const { url, depth } = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    taken += 1;
    const record = { url, seed: seed.id, issuer: seed.issuer, crop: seed.crop, depth, retrievedAt: new Date().toISOString() };
    try {
      const page = await fetchOne(url);
      Object.assign(record, { httpStatus: page.status, finalUrl: page.finalUrl, contentType: page.contentType, lastModified: page.lastModified, bytes: page.bytes.length });
      if (page.status !== 200) record.status = "failed_http";
      else {
        record.sha256 = sha256(page.bytes);
        const isPdf = /pdf/i.test(page.contentType) || /\.pdf$/i.test(url);
        record.format = isPdf ? "pdf" : "html";
        record.rawFile = `${record.sha256}.${record.format}`;
        writeFileSync(join(rawDir, record.rawFile), page.bytes);
        record.status = "fetched";
        if (isPdf) {
          // pdftotext gives the text layer only; a scanned PDF yields little text and is gated at extraction.
          try {
            const textFile = `${record.sha256}.txt`;
            execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", join(rawDir, record.rawFile), join(rawDir, textFile)], { stdio: "ignore" });
            record.textFile = textFile;
          } catch {
            record.status = "fetched_pdf_text_failed";
          }
        } else if (depth < seed.maxDepth) {
          for (const link of extractLinks(page.bytes.toString("latin1"), page.finalUrl)) {
            if (!seen.has(link) && isCrawlableLink(link, seed)) queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    } catch (error) {
      record.status = "failed_network";
      record.error = String((error && error.message) || error).slice(0, 200);
    }
    documents.push(record);
    await sleep(delayMs);
  }
}

const manifest = {
  name: "advisoryCorpusManifest",
  tag,
  createdAt: new Date().toISOString(),
  crawl: { delayMs, seeds: ADVISORY_SEEDS },
  usageNotes: "Source pages are marked '(c) TNAU 2008-2026 All Rights Reserved' and carry an information-only disclaimer; no open licence was found. Raw and extracted text stays in the gitignored .rag-local store for research evaluation. Written permission from the rights holder is required before ingestion into production or redistribution.",
  counts: documents.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] || 0) + 1 }), {}),
  documents,
};
writeFileSync(join(corpusDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
const copy = join(root, "docs", "research", "evaluation", "live", "rag", "corpus", `advisory_corpus_${tag}.manifest.json`);
writeJsonOnce(copy, manifest);
console.log(JSON.stringify({ tag, counts: manifest.counts, manifest: relative(root, copy) }));
process.exit(0);
