import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "..", ".env");

const result = dotenv.config({ path: envPath });
if (result.error) {
  console.warn("dotenv: no .env loaded from", envPath, "— continuing (maybe using real env vars)");
}

function cleanSecret(raw) {
  if (raw === undefined || raw === null) return undefined;
  let s = typeof raw === "string" ? raw : String(raw);
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  return s;
}

export const SERVER_REQUIRED = [
  "MONGO_URI",
  "GOOGLE_API_KEY",
  "CHROMA_API_KEY",
  "CHROMA_TENANT",
  "CHROMA_DATABASE",
];

export const CHAT_REQUIRED = [
  "GOOGLE_API_KEY",
  "CHROMA_API_KEY",
  "CHROMA_TENANT",
  "CHROMA_DATABASE",
];

export const INGEST_REQUIRED = [
  "MY_AWS_ACCESS_KEY_ID",
  "MY_AWS_SECRET_ACCESS_KEY",
  "S3_BUCKET",
  "COHERE_API_KEY",
  "CHROMA_API_KEY",
  "CHROMA_TENANT",
  "CHROMA_DATABASE",
];

export const env = Object.freeze({
  port: Number(process.env.PORT) || 8000,
  mongoUri: process.env.MONGO_URI,
  cognitoClientId: process.env.COGNITO_CLIENT_ID,
  cognitoClientSecret: process.env.COGNITO_CLIENT_SECRET,
  cognitoDomain: process.env.COGNITO_DOMAIN,
  cognitoRedirectUri: process.env.COGNITO_REDIRECT_URI,
  googleApiKey: cleanSecret(process.env.GOOGLE_API_KEY),
  modelProvider: process.env.MODEL_PROVIDER,
  modelName: process.env.MODEL_NAME,
  awsRegion: process.env.MY_AWS_REGION,
  awsAccessKeyId: process.env.MY_AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY,
  s3Bucket: process.env.S3_BUCKET,
  cohereApiKey: process.env.COHERE_API_KEY,
  chromaApiKey: process.env.CHROMA_API_KEY,
  chromaTenant: process.env.CHROMA_TENANT,
  chromaDatabase: process.env.CHROMA_DATABASE,
});

export function validateEnv(required = SERVER_REQUIRED) {
  const missing = required.filter((key) => {
    const value = process.env[key];
    return value === undefined || value === null || String(value).trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "See .env.example and docs/engineering/14_Deployment.md §4."
    );
  }
}
