// RAG knowledge-base settings (plan A10).
//
// Read from process.env at call time, never at import: the live evaluation scripts import this after
// isolateSharedInfrastructure() and config/env.js, and tests change the variables between cases. This
// module does not import config/env.js, so importing it can never load .env early.
//
// RAG_COLLECTION       Chroma collection that chat queries and the cloud ingest target writes.
//                      Default "farming-documents", the production collection, so production
//                      behaviour is unchanged unless the variable is set.
// RAG_MAX_ROWS_PER_FILE Row cap per CSV for ingestion. Default 0 = no cap (the previous default of 100
//                      left most of the yield-data file unindexed). Truncation is still logged.

export const DEFAULT_RAG_COLLECTION = "farming-documents";

// Chroma collection names: 3-512 characters of [A-Za-z0-9._-], starting and ending alphanumeric.
const COLLECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,510}[A-Za-z0-9]$/;

export const ragCollectionName = (value = process.env.RAG_COLLECTION) => {
  const name = String(value ?? "").trim();
  if (!name) return DEFAULT_RAG_COLLECTION;
  if (!COLLECTION_NAME.test(name)) throw new Error(`RAG_COLLECTION "${name}" is not a valid Chroma collection name`);
  return name;
};

export const ragMaxRowsPerFile = (value = process.env.RAG_MAX_ROWS_PER_FILE) => {
  const rows = Number(value);
  return Number.isInteger(rows) && rows > 0 ? rows : 0;
};

export default { DEFAULT_RAG_COLLECTION, ragCollectionName, ragMaxRowsPerFile };
