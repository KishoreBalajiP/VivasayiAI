import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";

// Legacy chunker, EVALUATION ONLY (plan A10, condition ii "old chunker on the new corpus").
//
// The production collection "farming-documents" was built by `rag/ingest.js` at commit e9b779d
// (the format is unchanged back to 889c97a; b760596 replaced it). This file reproduces that script's
// chunk text exactly:
//   - the text format of loadCSVFromS3, copied verbatim from `git show e9b779d:rag/ingest.js`
//     lines 54-64 (between the `<verbatim>` markers below). The one change: the hard-coded
//     `index < 100` on line 61 reads `index < limit`, so the row cap is a parameter (maxRows, 0 = no
//     cap; e9b779d behaviour is maxRows = 100). The original comment "Limit to first 100 rows" is kept
//     as part of the copy;
//   - the splitter settings of lines 90-93 (RecursiveCharacterTextSplitter, chunkSize 1000,
//     chunkOverlap 200) and the splitDocuments call of line 133;
//   - the chunk metadata of lines 149-153 (source, chunk_index, filename).
// @langchain/textsplitters is 1.0.0 both at e9b779d and now (package-lock.json), so the split is the
// same. Not reproduced: the `${key}_chunk_${i}_${Date.now()}` ids (line 154) and `collection.add`;
// the local index uses deterministic ids, which do not affect retrieval.
//
// The input must be decoded as e9b779d did (`Body.transformToString()`, i.e. Buffer utf8 with any
// byte order mark kept), and the old script applied it to EVERY key, including .kml and .xls.

export const LEGACY_CHUNKER = "legacy-e9b779d";

export const legacyTextFromCsv = ({ key, csvContent, maxRows = 100 }) => {
  const limit = maxRows > 0 ? maxRows : Infinity;
// <verbatim:e9b779d:rag/ingest.js:54-64>
    // Simple CSV parsing - convert to text format
    const lines = csvContent.split('\n');
    const headers = lines[0];
    const rows = lines.slice(1).filter(row => row.trim());
    
    let content = `File: ${key}\nHeaders: ${headers}\n\nData:\n`;
    rows.forEach((row, index) => {
      if (row.trim() && index < limit) { // Limit to first 100 rows
        content += `Row ${index + 1}: ${row}\n`;
      }
    });
// </verbatim:e9b779d:rag/ingest.js:54-64>
  const used = Math.min(rows.length, limit);
  return { content, rowCount: rows.length, usedRows: used, truncated: rows.length > used };
};

export const legacyChunks = async ({ key, csvContent, maxRows = 100, bucket = "" }) => {
  const { content, rowCount, usedRows, truncated } = legacyTextFromCsv({ key, csvContent, maxRows });
  const doc = new Document({
    pageContent: content,
    metadata: { source: `s3://${bucket}/${key}`, type: "csv", rows: rowCount },
  });
  // e9b779d:rag/ingest.js:90-93 and :133
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const splitDocs = await textSplitter.splitDocuments([doc]);
  // e9b779d:rag/ingest.js:149-153
  const chunks = splitDocs.map((chunk, i) => ({
    text: chunk.pageContent,
    metadata: { source: `s3://${bucket}/${key}`, chunk_index: i, filename: key },
  }));
  return { chunks, rowCount, usedRows, truncated };
};

export default { LEGACY_CHUNKER, legacyTextFromCsv, legacyChunks };
