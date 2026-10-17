import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ADR-024 (plan A8) — the hermetic e2e harness, booted for real in a child process
// (node scripts/e2e/hermeticBackend.js, ephemeral ports, its own memory MongoDB):
//   MK-3   a claim goes through the presigned PUT to the dev receiver, the WORKER (never POST /verify)
//          reaches the decision, and the harness recorded ZERO external network attempts;
//   MK-3b  the same with --worker=process (scripts/worker.js in a separate process with the fake-Gemini
//          preload and the shared file-backed mock store; critique B3, owner decision D7);
//   HX-6   the out file is written 0600 with the documented fields; SIGTERM shuts everything down
//          cleanly (exit 0, out file removed, both ports closed).
// The vitest process itself only talks to 127.0.0.1.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createScenarioClient } from "../scripts/e2e/lib/scenarioClient.js";
import { fixtureJpeg } from "../scripts/e2e/lib/fixtureImage.js";
import { resolvePolicy } from "../config/verificationPolicy.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const bootHarness = async (label, args = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vivasayi-${label}-`));
  const out = path.join(dir, "harness.json");
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "e2e", "hermeticBackend.js"), "--port=0", "--control-port=0", `--out=${out}`, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 240 && !fs.existsSync(out); i += 1) {
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  if (!fs.existsSync(out)) throw new Error(`harness did not start: ${stderr.slice(-2000)}`);
  const harness = JSON.parse(fs.readFileSync(out, "utf8"));
  return { dir, out, child, exited, harness, stderr: () => stderr };
};

const stopHarness = async (booted) => {
  if (!booted) return null;
  if (booted.child.exitCode === null) booted.child.kill("SIGTERM");
  const result = await Promise.race([booted.exited, sleep(40_000).then(() => ({ code: "timeout" }))]);
  if (booted.child.exitCode === null) booted.child.kill("SIGKILL");
  fs.rmSync(booted.dir, { recursive: true, force: true });
  return result;
};

const portClosed = (url) =>
  new Promise((resolve) => {
    const { hostname, port } = new URL(url);
    const socket = net.connect({ host: hostname, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });

// The browser's journey, over HTTP: create, presign, PUT to the signed URL, complete, submit.
const browserJourney = async ({ harness, client }) => {
  const session = await client.control("POST", "/__e2e/session", { role: "farmer", language: "en" });
  const call = async (method, route, body) => {
    const response = await fetch(`${harness.apiUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${session.accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: (await response.json()).data };
  };
  const today = new Date();
  const eventDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3)).toISOString();
  const created = await call("POST", "/claims", { parcelId: session.parcelId, eventType: "flood", eventDate, geometry: session.parcel.geometry, idempotencyKey: `mk3-${Date.now()}` });
  expect(created.status).toBe(200);
  const claimId = created.data.claim.id;
  const photo = await fixtureJpeg({ seed: `mk3-${claimId}`, width: 320, height: 240 });
  const presign = await call("POST", `/claims/${claimId}/evidence/presign`, { contentType: "image/jpeg", size: photo.length, filename: "field.jpg" });
  expect(presign.status).toBe(200);
  // The presigned URL is the dev receiver on the API itself.
  expect(presign.data.uploadUrl.startsWith(`${harness.apiUrl}/__dev/storage/uploads/claims/${claimId}/`)).toBe(true);
  const put = await fetch(presign.data.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: photo });
  expect(put.status).toBe(200);
  expect((await call("POST", `/claims/${claimId}/evidence/${presign.data.uploadId}/complete`)).status).toBe(200);
  expect((await call("POST", `/claims/${claimId}/submit`)).status).toBe(200);
  return { session, claimId, call };
};

describe("hermetic e2e harness, booted (MK-3, HX-6)", () => {
  let inline;
  beforeAll(async () => {
    inline = await bootHarness("mk3");
  }, 120_000);
  afterAll(async () => {
    await stopHarness(inline);
  });

  it("MK-3: a claim goes through the presigned PUT to the receiver, the worker decides it without POST /verify, and zero external network attempts are recorded", async () => {
    const { harness } = inline;
    const policy = resolvePolicy("v1.1-safe-ai");
    expect(harness.policy).toEqual({ id: policy.id, hash: policy.hash });
    const client = createScenarioClient(harness);
    const health = await fetch(`${harness.controlUrl}/__e2e/health`).then((response) => response.json());
    expect(health).toMatchObject({ ok: true, apiUrl: harness.apiUrl, policy: { id: "v1.1-safe-ai" }, worker: { mode: "inline", state: "running" } });
    await client.control("POST", "/__e2e/scenario", { reset: true });

    const { session, claimId, call } = await browserJourney({ harness, client });
    const settled = await client.waitFor(claimId, { settle: "decided", expected: {} }, { timeoutMs: 90_000 });
    expect(settled.settled).toBe(true);
    expect(settled.inspection).toMatchObject({ state: "verified", assessment: { policy: { id: "v1.1-safe-ai", hash: policy.hash } } });
    expect(settled.inspection.audits).toMatchObject({ submitted: 1, verified: 1 });
    // Decided by the queue alone: every decision step ran as a job.
    expect(settled.inspection.jobs.filter((job) => ["ai_assessment", "engine"].includes(job.step)).map((job) => `${job.step}:${job.status}`)).toEqual(["ai_assessment:succeeded", "engine:succeeded"]);
    const progress = await call("GET", `/claims/${claimId}/progress`);
    expect(progress.data.progress).toMatchObject({ overallStatus: "decided", decision: "verified", satellite: { status: "unavailable", reasonCode: "analysis_not_enabled", supportingOnly: true } });
    // The stored photo reads back through a signed receiver GET URL.
    const photos = await call("GET", `/claims/${claimId}`);
    const uploadId = photos.data.claim.evidence[0].uploadId;
    const view = await call("GET", `/claims/${claimId}/evidence/${uploadId}/url`);
    const image = await fetch(view.data.url);
    expect(image.status).toBe(200);
    expect(image.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(session.user).toMatchObject({ role: "farmer", name: expect.any(String), email: expect.stringMatching(/@e2e\.invalid$/) });

    // A scenario through the control server's own seeding (it uses the same API and receiver). A new
    // farmer: the first farmer's verified claim already covers that parcel (a second claim over it
    // would rightly be duplicate_area).
    await client.control("POST", "/__e2e/scenario", { id: "S13" });
    const second = await client.control("POST", "/__e2e/session", { role: "farmer", language: "ta" });
    const seeded = await client.control("POST", "/__e2e/seed-claim", { accessToken: second.accessToken, scenario: "S13" });
    const s13 = await client.waitFor(seeded.claimId, { settle: "decided", expected: {} }, { timeoutMs: 90_000 });
    expect(s13.inspection.state).toBe("verified");
    const s13Progress = await fetch(`${harness.apiUrl}/claims/${seeded.claimId}/progress`, { headers: { Authorization: `Bearer ${second.accessToken}` } }).then((response) => response.json());
    expect(s13Progress.data.progress.satellite).toMatchObject({ status: "passed", supportingOnly: true });

    expect(await client.control("GET", "/__e2e/network-violations")).toEqual([]);
    expect(inline.stderr()).not.toContain("BLOCKED external network attempt");
  }, 150_000);

  it("HX-6: the out file is 0600 with the documented fields, and SIGTERM stops the worker, both servers and MongoDB cleanly (exit 0, out file removed, ports closed)", async () => {
    const { out, harness } = inline;
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(Object.keys(harness).sort()).toEqual(["apiUrl", "controlToken", "controlUrl", "mongo", "pid", "policy", "startedAt", "worker"].sort());
    expect(harness.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(harness.controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(harness.controlToken.length).toBeGreaterThanOrEqual(32);
    expect(harness.mongo).toMatchObject({ mode: "memory", uri: expect.stringMatching(/^mongodb:\/\/127\.0\.0\.1:\d+\/vivasayi_e2e$/) });

    const result = await stopHarness(inline);
    inline = null;
    expect(result).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(out)).toBe(false);
    expect(await portClosed(harness.apiUrl)).toBe(true);
    expect(await portClosed(harness.controlUrl)).toBe(true);
  }, 60_000);

  it("MK-3b: with --worker=process a separate worker process (fake-Gemini preload, shared file-backed store) decides the claim; pause, kill and restart work; zero network violations", async () => {
    const booted = await bootHarness("mk3b", ["--worker=process"]);
    try {
      const { harness } = booted;
      const client = createScenarioClient(harness);
      expect((await client.control("POST", "/__e2e/worker", { action: "status" })).mode).toBe("process");
      // Paused: nothing moves.
      expect((await client.control("POST", "/__e2e/worker", { action: "pause" })).state).toBe("paused");
      const { claimId, call } = await browserJourney({ harness, client });
      await sleep(1500);
      expect((await client.control("GET", `/__e2e/claims/${claimId}/inspect`)).jobs.every((job) => job.status === "queued" && job.attempts === 0)).toBe(true);
      // A killed worker is replaced; the new one decides the claim.
      expect((await client.control("POST", "/__e2e/worker", { action: "start" })).state).toBe("running");
      expect((await client.control("POST", "/__e2e/worker", { action: "kill" })).state).toBe("killed");
      const restarted = await client.control("POST", "/__e2e/worker", { action: "start" });
      expect(restarted).toMatchObject({ state: "running", starts: 3, lastExit: { signal: "SIGKILL" } });
      const settled = await client.waitFor(claimId, { settle: "decided", expected: {} }, { timeoutMs: 90_000 });
      expect(settled.settled).toBe(true);
      expect(settled.inspection.state).toBe("verified");
      expect((await call("GET", `/claims/${claimId}/progress`)).data.progress.decision).toBe("verified");
      expect(await client.control("GET", "/__e2e/network-violations")).toEqual([]);
    } finally {
      expect(await stopHarness(booted)).toEqual({ code: 0, signal: null });
    }
  }, 180_000);
});
