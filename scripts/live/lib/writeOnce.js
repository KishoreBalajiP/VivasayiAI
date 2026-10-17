// Write-once output for research and live-evaluation results.
//
// Dated result files are evidence: a later run must never silently replace an earlier one. Every live
// and evaluation script writes through this helper, which opens the file with the `wx` flag so an
// existing file makes the write fail instead of being overwritten. To produce a new result, run with a
// new date or tag.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class ResultExistsError extends Error {
  constructor(path) {
    super(`Refusing to overwrite existing result file: ${path}. Use a new --date or --tag.`);
    this.name = "ResultExistsError";
    this.path = path;
    this.exitCode = 2;
  }
}

export const writeResultOnce = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, text, { flag: "wx" });
  } catch (error) {
    if (error && error.code === "EEXIST") throw new ResultExistsError(path);
    throw error;
  }
  return path;
};

export const writeJsonOnce = (path, value) => writeResultOnce(path, `${JSON.stringify(value, null, 2)}\n`);

// The date and tag that name a dated result file: the same rules as scripts/live/ragRetrieval.live.js
// (YYYY-MM-DD; a tag of 1-100 characters of [A-Za-z0-9._-] starting with a letter or digit). Checked
// before anything is read or written, so a typo can never produce an oddly named or misplaced file.
export const RUN_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const RUN_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const runLabelProblem = ({ date, tag } = {}) => {
  if (typeof date !== "string" || !RUN_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    return `--date must be YYYY-MM-DD, got "${date ?? ""}"`;
  }
  if (tag !== undefined && (typeof tag !== "string" || !RUN_TAG.test(tag))) return `--tag must be 1-100 characters of [A-Za-z0-9._-], got "${tag}"`;
  return null;
};
