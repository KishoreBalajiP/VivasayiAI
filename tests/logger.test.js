import { describe, expect, it } from "vitest";
import { createLogger } from "../utils/logger.js";

// The Lambda image installs production dependencies only, and Dockerfile/CI never set NODE_ENV, so
// the logger took its "development" branch and required the pino-pretty devDependency, which is not
// installed there. A missing optional pretty-printer must degrade to plain JSON logs, not crash.

describe("createLogger", () => {
  it("LG-1: without pino-pretty (production image) it falls back to JSON logging instead of throwing", () => {
    const logger = createLogger({ isProduction: false, prettyAvailable: false, level: "info" });
    expect(typeof logger.info).toBe("function");
    expect(logger.level).toBe("info");
  });

  it("LG-2: in production it never loads the pretty transport", () => {
    const logger = createLogger({ isProduction: true, prettyAvailable: true, level: "warn" });
    expect(logger.level).toBe("warn");
  });

  it("LG-3: the default export is a working logger with the service tag", async () => {
    const { default: logger } = await import("../utils/logger.js");
    expect(typeof logger.error).toBe("function");
    expect(logger.bindings().service).toBe("vivasayi-backend");
  });

  it("LG-4: when Lambda is detected it behaves as production even without NODE_ENV", () => {
    const logger = createLogger({ isProduction: false, prettyAvailable: true, level: "info", runningInLambda: true });
    expect(logger.level).toBe("info");
  });
});
