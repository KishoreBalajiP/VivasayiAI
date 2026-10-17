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
      GOOGLE_API_KEY: "test-placeholder",
      COHERE_API_KEY: "test-placeholder",
      CHROMA_API_KEY: "test-placeholder",
      CHROMA_TENANT: "test-placeholder",
      CHROMA_DATABASE: "test-placeholder",
      CLAIM_WINDOW_DAYS: "30",
      CLAIM_RATE_LIMIT_WINDOW_MS: "3600000",
      CLAIM_RATE_LIMIT_MAX: "1000",
      CLAIM_READ_RATE_LIMIT_MAX: "1000",
      EVIDENCE_RATE_LIMIT_WINDOW_MS: "3600000",
      EVIDENCE_RATE_LIMIT_MAX: "6",
      CLAIM_EVIDENCE_MAX_IMAGES: "10",
      CLAIM_MAX_RESUBMISSIONS: "2",
      CLAIM_RESUBMIT_COOLDOWN_MS: "0",
      IMAGE_STORAGE_MODE: "mock",
      IMAGE_AI_MODE: "mock",
      ADMIN_RATE_LIMIT_WINDOW_MS: "3600000",
      ADMIN_RATE_LIMIT_MAX: "1000",
      ADMIN_OVERRIDE_APPROVER_ACRE_THRESHOLD: "0",
      CLAIM_AUTOMATED_VERIFICATION_ENABLED: "false",
      // Pinned so the existing suites stay the v1-legacy regression suite whatever the code default
      // becomes (ADR-022). Suites that test another policy set it themselves in vi.hoisted.
      CLAIM_VERIFICATION_POLICY: "v1-legacy",
      // config/env.js must not load the developer's .env at all in tests (and in the worker child
      // processes the worker suites spawn, which inherit this environment): a key that exists only in
      // .env could otherwise route a test to a live provider.
      VIVASAYI_SKIP_DOTENV: "1",
      // Belt and braces for a process that loads .env anyway (dotenv never overrides a variable that
      // is already set): every live credential is blanked, so no test reaches a real provider (Atlas,
      // S3, Copernicus, a land-record service, Cognito).
      MONGO_URI: "",
      MY_AWS_ACCESS_KEY_ID: "",
      MY_AWS_SECRET_ACCESS_KEY: "",
      CDSE_CLIENT_ID: "",
      CDSE_CLIENT_SECRET: "",
      SENTINEL_HUB_CLIENT_ID: "",
      SENTINEL_HUB_CLIENT_SECRET: "",
      SATELLITE_PROCESSING_ENABLED: "false",
      LAND_RECORD_PROVIDER_URL: "",
      LAND_RECORD_API_KEY: "",
      COGNITO_CLIENT_SECRET: "",
    },
  },
});