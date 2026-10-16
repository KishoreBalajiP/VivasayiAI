import { describe, expect, it } from "vitest";
import { api } from "./helpers.js";

// x-request-id is echoed in a response header and written to every log line, so a client must not be
// able to choose arbitrary content for it.
describe("x-request-id", () => {
  it("RQ-1: a well-formed id is kept and echoed", async () => {
    const response = await api().get("/health").set("x-request-id", "req-12345678-abc");
    expect(response.headers["x-request-id"]).toBe("req-12345678-abc");
  });

  it("RQ-2: oversized, malformed or log-forging ids are replaced with a generated one", async () => {
    for (const bad of ["x".repeat(500), "short", "has spaces in it 12345", "line\\nbreak-injected-12345", "<script>alert(1)</script>", "a".repeat(65)]) {
      const response = await api().get("/health").set("x-request-id", bad);
      const echoed = response.headers["x-request-id"];
      expect(echoed).not.toBe(bad);
      expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("RQ-3: no id supplied gets a generated one", async () => {
    expect((await api().get("/health")).headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
