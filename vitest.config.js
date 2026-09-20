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
    },
  },
});