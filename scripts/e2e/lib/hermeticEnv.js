// Environment handling for the hermetic e2e harness (ADR-024, design-testing §2.1 steps 1-2, HX-1/HX-2).
// Pure Node plus dotenv's parser (dotenv.parse reads a string; it never loads the developer's .env).
// Nothing here prints a value: refusals name variables only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const E2E_ENV_FILE = path.join(BACKEND_ROOT, "scripts", "e2e", "e2e.env");
export const PLACEHOLDER = "e2e-placeholder";

// Keys the AI, embedding and vector-store clients need at import. They must be the placeholder.
export const PLACEHOLDER_KEYS = Object.freeze(["GOOGLE_API_KEY", "COHERE_API_KEY", "CHROMA_API_KEY", "CHROMA_TENANT", "CHROMA_DATABASE"]);
// Live credentials (every one .env.example and vitest.config.js name). They must be empty.
export const LIVE_CREDENTIAL_KEYS = Object.freeze([
  "MY_AWS_ACCESS_KEY_ID",
  "MY_AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CDSE_CLIENT_ID",
  "CDSE_CLIENT_SECRET",
  "SENTINEL_HUB_CLIENT_ID",
  "SENTINEL_HUB_CLIENT_SECRET",
  "LAND_RECORD_PROVIDER_URL",
  "LAND_RECORD_API_KEY",
  "COGNITO_CLIENT_SECRET",
]);
// The seams the harness depends on; anything else means the e2e run is not hermetic.
export const REQUIRED_SEAMS = Object.freeze({
  VIVASAYI_SKIP_DOTENV: "1",
  IMAGE_STORAGE_MODE: "mock",
  IMAGE_AI_MODE: "live",
  LAND_RECORD_MODE: "mock",
  WEATHER_MODE: "mock",
  SATELLITE_MODE: "mock",
  DEV_STORAGE_RECEIVER: "true",
  CLAIM_VERIFICATION_DRAIN_ON_READ: "false",
  SATELLITE_PROCESSING_ENABLED: "false",
});
// Set from the shell, never overridden by e2e.env (they choose a database or binary, not a provider).
export const SHELL_KEYS = Object.freeze(["E2E_MONGO_URI", "MONGOMS_SYSTEM_BINARY", "E2E_CONTROL_TOKEN", "E2E_SESSION_JWT_SECRET"]);

export const readE2eEnvFile = (file = E2E_ENV_FILE) => dotenv.parse(fs.readFileSync(file, "utf8"));

// Every key of the file replaces the shell's value (so a credential exported in the shell is blanked).
export const applyE2eEnv = (parsed, target = process.env) => {
  for (const [key, value] of Object.entries(parsed)) {
    if (SHELL_KEYS.includes(key)) continue;
    target[key] = value;
  }
  return target;
};

// Refuse before anything is loaded (HX-1): a production or Lambda process never becomes a harness.
export const preflightRefusal = (source = process.env) => {
  if (source.NODE_ENV === "production") return "NODE_ENV is production";
  if (source.AWS_LAMBDA_FUNCTION_NAME) return "running on AWS Lambda (AWS_LAMBDA_FUNCTION_NAME is set)";
  return null;
};

const LOOPBACK_HOST = /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/i;
// A MongoDB URI on this machine: plain mongodb:// with only loopback hosts. `+srv` is never local.
export const isLoopbackMongoUri = (uri) => {
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(String(uri || "").trim());
  if (!match) return false;
  const hosts = match[1].split(",").map((entry) => entry.trim()).filter(Boolean);
  return hosts.length > 0 && hosts.every((entry) => LOOPBACK_HOST.test(entry.startsWith("[") ? entry.slice(0, entry.indexOf("]") + 1) : entry.replace(/:\d+$/, "")));
};

// --mongo=local: a loopback mongod and a database whose name says it is disposable.
export const checkLocalMongoUri = (uri) => {
  const value = String(uri || "").trim();
  if (!value) return "E2E_MONGO_URI is not set (required with --mongo=local)";
  if (/^mongodb\+srv:/i.test(value)) return "E2E_MONGO_URI is a mongodb+srv URI (never local)";
  if (!isLoopbackMongoUri(value)) return "E2E_MONGO_URI does not point at a mongod on this machine";
  const database = /^mongodb:\/\/[^/]+\/([^?]+)/i.exec(value);
  if (!database || !/^vivasayi_e2e[A-Za-z0-9_-]*$/.test(database[1])) return "E2E_MONGO_URI must name a database starting with vivasayi_e2e";
  return null;
};

// After config/env.js is loaded (HX-2): names of everything that would make the run non-hermetic.
export const checkHermeticEnv = ({ source = process.env, appEnv = null } = {}) => {
  const problems = [];
  const reason = preflightRefusal(source);
  if (reason) problems.push(reason);
  for (const key of LIVE_CREDENTIAL_KEYS) {
    if (String(source[key] ?? "").trim() !== "") problems.push(`${key} is set (live credentials must be empty)`);
  }
  for (const key of PLACEHOLDER_KEYS) {
    if (source[key] !== PLACEHOLDER) problems.push(`${key} is not the e2e placeholder`);
  }
  for (const [key, value] of Object.entries(REQUIRED_SEAMS)) {
    if (String(source[key] ?? "") !== value) problems.push(`${key} must be ${value}`);
  }
  if (!isLoopbackMongoUri(source.MONGO_URI)) problems.push("MONGO_URI is not a database on this machine");
  if (appEnv) {
    // What the application actually loaded (config/env.js), in case anything slipped past the above.
    if (appEnv.googleApiKey !== PLACEHOLDER) problems.push("config/env.js googleApiKey is not the e2e placeholder");
    if (appEnv.cohereApiKey !== PLACEHOLDER) problems.push("config/env.js cohereApiKey is not the e2e placeholder");
    for (const [field, label] of [["awsAccessKeyId", "awsAccessKeyId"], ["awsSecretAccessKey", "awsSecretAccessKey"], ["cognitoClientSecret", "cognitoClientSecret"]]) {
      if (String(appEnv[field] ?? "").trim() !== "") problems.push(`config/env.js ${label} is set`);
    }
    if (appEnv.imageStorageMode !== "mock") problems.push("config/env.js imageStorageMode is not mock");
    if (!isLoopbackMongoUri(appEnv.mongoUri)) problems.push("config/env.js mongoUri is not a database on this machine");
  }
  return problems;
};

export default {
  BACKEND_ROOT,
  E2E_ENV_FILE,
  PLACEHOLDER,
  PLACEHOLDER_KEYS,
  LIVE_CREDENTIAL_KEYS,
  REQUIRED_SEAMS,
  readE2eEnvFile,
  applyE2eEnv,
  preflightRefusal,
  isLoopbackMongoUri,
  checkLocalMongoUri,
  checkHermeticEnv,
};
