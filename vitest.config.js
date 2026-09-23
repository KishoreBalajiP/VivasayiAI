import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.js"],
    testTimeout: 120000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SESSION_JWT_SECRET: "test-session-secret-0123456789abcdef",
      SESSION_MUTATION_RATE_LIMIT_MAX: "1000",
      // Import-time CHAT_REQUIRED validation runs when the full Express app is imported.
      // Parcel tests never call chat/AI endpoints; these are inert placeholders, not real keys.
      GOOGLE_API_KEY: "test-placeholder",
      COHERE_API_KEY: "test-placeholder",
      CHROMA_API_KEY: "test-placeholder",
      CHROMA_TENANT: "test-placeholder",
      CHROMA_DATABASE: "test-placeholder",
      // F-49 claim tests: in-memory S3 + image AI seams stay deterministic (no external AWS),
      // rate limits are raised so suites don't self-throttle, and cooldown is disabled so the
      // resubmission happy path is testable.
      CLAIM_WINDOW_DAYS: "30",
      CLAIM_RATE_LIMIT_WINDOW_MS: "3600000",
      CLAIM_RATE_LIMIT_MAX: "1000",
      EVIDENCE_RATE_LIMIT_WINDOW_MS: "3600000",
      // Evidence limiter kept low (6) so the Phase 3 rate-limit test can prove a real 429.
      // Per-user evidence calls inside any single suite stay well under 6 (max 3-4).
      EVIDENCE_RATE_LIMIT_MAX: "6",
      CLAIM_EVIDENCE_MAX_IMAGES: "10",
      CLAIM_MAX_RESUBMISSIONS: "2",
      CLAIM_RESUBMIT_COOLDOWN_MS: "0",
      IMAGE_STORAGE_MODE: "mock",
      IMAGE_AI_MODE: "mock",
    },
  },
});