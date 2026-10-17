// What the e2e control server does (ADR-024, design-testing §2.1 steps 7-8). Imported by
// scripts/e2e/hermeticBackend.js only AFTER the hermetic environment is loaded and checked, so the
// application modules below see the e2e configuration, never .env.
//
// Everything that creates data goes through the product's own HTTP API with the farmer's token (profile,
// parcel, claim, photo presign -> signed PUT to the dev receiver -> complete, documents, submit), so a
// seeded claim is indistinguishable from one a browser made. Only the User row (what a Cognito login
// would upsert) and the session token (signAccessToken, what /auth/google mints) are created directly.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import User from "../../../models/User.js";
import LossClaim from "../../../models/LossClaim.js";
import ClaimAudit from "../../../models/ClaimAudit.js";
import ClaimAssessment from "../../../models/ClaimAssessment.js";
import VerificationEvidence from "../../../models/VerificationEvidence.js";
import VerificationJob from "../../../models/VerificationJob.js";
import { signAccessToken, verifyAccessToken } from "../../../utils/token.js";
import { env } from "../../../config/env.js";
import { MOCK_SATELLITE_OUTCOMES } from "../../../services/satellite/mockProvider.js";
import { MOCK_WEATHER_OUTCOMES } from "../../../services/weatherArchive.service.js";
import { drainDueJobs, runWorkerLoop } from "../../../services/verificationWorker.service.js";
import { ensureDefaultExecutors } from "../../../services/verificationJobs.service.js";
import { networkViolations } from "./networkGuard.js";
import { fixtureJpeg, greyTilePng } from "./fixtureImage.js";
import { defaultParcelGeometry, overLimitGeometry, utcEventDate } from "./seedHelpers.js";

export const LAND_RECORD_OUTCOMES = Object.freeze(["match", "mismatch", "not_found", "unavailable"]);
const DECISION_STATES = new Set(["verified", "partially_verified", "rejected", "duplicate_area", "out_of_limit", "more_evidence_required"]);
const DECISION_INPUT_AND_ENGINE = new Set(["ai_assessment", "land_documents", "official_land_record", "engine"]);
const ACTIVE = new Set(["queued", "running"]);

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const positive = (raw, fallback) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const createHarnessServices = async ({ apiUrl, fake, policy, scenarioFile, violationsFile, defaultFarmerName, workerMode, backendRoot, log }) => {
  await ensureDefaultExecutors();
  const scenariosPath = path.join(backendRoot, "scripts", "e2e", "scenarios.json");
  const loadScenarios = () => JSON.parse(fs.readFileSync(scenariosPath, "utf8"));
  const startedAt = new Date().toISOString();
  let sessionCount = 0;

  // ---- the product API, as the browser calls it ------------------------------------------------------
  const api = async (method, route, { token = null, body, raw = null, contentType = null, url = null } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (raw) headers["Content-Type"] = contentType;
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url || `${apiUrl}${route}`, { method, headers, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, data: json && json.data, message: json && json.message, headers: response.headers };
  };
  const expectOk = (result, what) => {
    if (result.status !== 200) throw httpError(result.status >= 400 && result.status < 500 ? 409 : 502, `${what} failed with HTTP ${result.status}: ${result.message || ""}`.trim());
    return result.data;
  };

  // ---- scenario (fake Gemini + mock outcomes) -------------------------------------------------------------
  const outcomes = () => ({
    satellite: process.env.SATELLITE_MOCK_OUTCOME || "imagery_found",
    weather: process.env.WEATHER_MOCK_OUTCOME || "available",
    landRecord: process.env.LAND_RECORD_MOCK_OUTCOME || "unavailable",
  });
  const getScenario = () => ({ ...fake.snapshot(), ...outcomes() });
  const persistScenario = () => {
    // A process worker reads this file (scripts/e2e/fakeGeminiPreload.js) and follows every change.
    const current = getScenario();
    const temp = `${scenarioFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ai: current.ai, landDocument: current.landDocument, holderNames: current.holderNames, satellite: current.satellite, weather: current.weather, landRecord: current.landRecord, version: current.version }));
    fs.renameSync(temp, scenarioFile);
  };

  const applyScenario = (body = {}) => {
    let setup = body;
    if (body.id !== undefined || body.reset) {
      const document = loadScenarios();
      const scenario = body.id !== undefined ? document.scenarios.find((entry) => entry.id === body.id) : null;
      if (body.id !== undefined && !scenario) throw httpError(404, `Unknown scenario ${body.id}`);
      setup = { ...document.defaults.setup, ...(scenario ? scenario.setup : {}), ...Object.fromEntries(Object.entries(body).filter(([key]) => !["id", "reset"].includes(key))) };
    }
    const { ai, landDocument, holderNames, satellite, weather, landRecord } = setup;
    if (satellite !== undefined && !MOCK_SATELLITE_OUTCOMES.includes(satellite)) throw httpError(400, `Unknown satellite outcome ${satellite}`);
    if (weather !== undefined && !MOCK_WEATHER_OUTCOMES.includes(weather)) throw httpError(400, `Unknown weather outcome ${weather}`);
    if (landRecord !== undefined && !LAND_RECORD_OUTCOMES.includes(landRecord)) throw httpError(400, `Unknown landRecord outcome ${landRecord}`);
    fake.configure({ ai, landDocument, holderNames }); // validates ai / landDocument (400 on an unknown mode)
    if (satellite !== undefined) process.env.SATELLITE_MOCK_OUTCOME = satellite;
    if (weather !== undefined) process.env.WEATHER_MOCK_OUTCOME = weather;
    if (landRecord !== undefined) process.env.LAND_RECORD_MOCK_OUTCOME = landRecord;
    persistScenario();
    return getScenario();
  };
  persistScenario();

  // ---- sessions ----------------------------------------------------------------------------------------
  const createSession = async (body = {}) => {
    const role = body.role === undefined ? "farmer" : body.role;
    if (!["farmer", "admin"].includes(role)) throw httpError(400, "role must be farmer or admin");
    const language = body.language === undefined ? "en" : body.language;
    if (!["en", "ta"].includes(language)) throw httpError(400, "language must be en or ta");
    const name = String(body.name || (role === "admin" ? "E2E Reviewer" : defaultFarmerName)).trim().slice(0, 80);
    const district = String(body.district || "Thanjavur");
    sessionCount += 1;
    const cognitoSub = `e2e-${role}-${randomUUID()}`;
    const email = `${role}.${cognitoSub.slice(-12)}@e2e.invalid`;
    // What a Cognito login upserts (services/auth.service.js); the land-document check reads User.name.
    await User.updateOne({ cognitoSub }, { $set: { cognitoSub, name, email, language } }, { upsert: true });
    const accessToken = signAccessToken({ cognitoSub, email, name, role });
    const user = { email, name, role, cognitoSub };
    if (role === "admin") return { accessToken, user, parcelId: null, parcel: null, expiresInMs: env.accessTokenTtlMs };

    expectOk(await api("POST", "/profile", { token: accessToken, body: { district, crops: ["Paddy"], acres: 2, language } }), "POST /profile");
    const geometry = body.parcel && body.parcel.geometry ? body.parcel.geometry : defaultParcelGeometry(sessionCount);
    const created = expectOk(
      await api("POST", "/profile/parcels", { token: accessToken, body: { name: (body.parcel && body.parcel.name) || "E2E field", crop: "Paddy", geometry } }),
      "POST /profile/parcels"
    );
    const parcelId = created.parcel.parcelId;
    return { accessToken, user, parcelId, parcel: { parcelId, geometry: created.parcel.geometry || geometry }, expiresInMs: env.accessTokenTtlMs };
  };

  // ---- seeding a claim through the API -------------------------------------------------------------------
  const uploadClaimPhoto = async (token, claimId, seed) => {
    const bytes = await fixtureJpeg({ seed, width: 640, height: 480 });
    const presign = expectOk(await api("POST", `/claims/${claimId}/evidence/presign`, { token, body: { contentType: "image/jpeg", size: bytes.length, filename: `photo-${seed}.jpg` } }), "evidence presign");
    // The browser's direct upload: a PUT to the signed dev receiver URL, with the signed Content-Type.
    const put = await api("PUT", null, { url: presign.uploadUrl, raw: bytes, contentType: "image/jpeg" });
    if (put.status !== 200) throw httpError(502, `PUT to the upload URL failed with HTTP ${put.status}`);
    expectOk(await api("POST", `/claims/${claimId}/evidence/${presign.uploadId}/complete`, { token }), "evidence complete");
    return presign.uploadId;
  };
  const attachDocument = async (token, claimId, category, seed) => {
    const bytes = await fixtureJpeg({ seed, width: 600, height: 800 });
    const presign = expectOk(await api("POST", "/upload/presign", { token, body: { contentType: "image/jpeg", size: bytes.length, filename: `document-${seed}.jpg` } }), "upload presign");
    const put = await api("PUT", null, { url: presign.uploadUrl, raw: bytes, contentType: "image/jpeg" });
    if (put.status !== 200) throw httpError(502, `PUT to the upload URL failed with HTTP ${put.status}`);
    expectOk(await api("POST", `/upload/${presign.uploadId}/complete`, { token }), "upload complete");
    const attached = expectOk(await api("POST", `/claims/${claimId}/ownership`, { token, body: category ? { uploadId: presign.uploadId, documentCategory: category } : { uploadId: presign.uploadId } }), "attach document");
    return attached.evidence.id;
  };

  const seedClaim = async (body = {}) => {
    const decoded = verifyAccessToken(body.accessToken);
    if (!decoded) throw httpError(400, "accessToken is missing or invalid (use the token from POST /__e2e/session)");
    const token = body.accessToken;
    const document = loadScenarios();
    let spec = { ...document.defaults.claim };
    if (body.scenario !== undefined) {
      const scenario = document.scenarios.find((entry) => entry.id === body.scenario);
      if (!scenario) throw httpError(404, `Unknown scenario ${body.scenario}`);
      spec = { ...spec, ...scenario.claim };
    }
    for (const key of ["eventDaysAgo", "eventType", "photos", "documents", "relationship", "geometry", "overlap", "parcelId", "submit"]) {
      if (body[key] !== undefined) spec[key] = body[key];
    }
    const parcels = expectOk(await api("GET", "/profile/parcels", { token }), "GET /profile/parcels").parcels || [];
    const parcel = spec.parcelId ? parcels.find((entry) => entry.parcelId === spec.parcelId) : parcels[0];
    if (!parcel) throw httpError(409, "the farmer has no parcel (create the session with POST /__e2e/session)");

    let neighbour = null;
    if (spec.overlap === "other_farmer_claim") {
      // Another farmer, whose parcel is the same land, claims it first (critique E2 / DC-6).
      const other = await createSession({ name: "E2E Neighbour", parcel: { geometry: parcel.geometry } });
      const theirs = expectOk(
        await api("POST", "/claims", { token: other.accessToken, body: { parcelId: other.parcelId, eventType: "flood", eventDate: utcEventDate(spec.eventDaysAgo ?? 3), geometry: other.parcel.geometry, idempotencyKey: `e2e-${randomUUID()}` } }),
        "neighbour claim"
      ).claim.id;
      await uploadClaimPhoto(other.accessToken, theirs, `neighbour-${theirs}`);
      expectOk(await api("POST", `/claims/${theirs}/submit`, { token: other.accessToken }), "neighbour submit");
      neighbour = { claimId: String(theirs), cognitoSub: other.user.cognitoSub };
    }

    const geometry = spec.geometry && typeof spec.geometry === "object" ? spec.geometry : spec.geometry === "over_limit" ? overLimitGeometry(parcel.geometry) : parcel.geometry;
    const eventDate = utcEventDate(spec.eventDaysAgo ?? 3);
    const createBody = { parcelId: parcel.parcelId, eventType: spec.eventType || "flood", eventDate, geometry, idempotencyKey: `e2e-${randomUUID()}` };
    if (spec.relationship) createBody.claimantRelationship = spec.relationship;
    const claimId = String(expectOk(await api("POST", "/claims", { token, body: createBody }), "POST /claims").claim.id);

    const photos = [];
    for (let i = 0; i < Math.max(0, Math.min(10, Number(spec.photos) || 0)); i += 1) photos.push(await uploadClaimPhoto(token, claimId, `${claimId}-${i}`));
    const documents = [];
    for (const [index, entry] of (Array.isArray(spec.documents) ? spec.documents : []).entries()) documents.push(await attachDocument(token, claimId, entry && entry.category, `${claimId}-doc-${index}`));
    if (spec.submit !== false) expectOk(await api("POST", `/claims/${claimId}/submit`, { token }), "POST /claims/:id/submit");
    return { claimId, eventDate, photos, documents, submitted: spec.submit !== false, neighbour };
  };

  // ---- inspection (read-only) --------------------------------------------------------------------------
  const inspect = async (claimId) => {
    if (!mongoose.isValidObjectId(String(claimId))) throw httpError(400, "invalid claim id");
    const claim = await LossClaim.findById(claimId).select("state submissionRound firstSubmittedAt submittedAt decidedAt cognitoSub").lean();
    if (!claim) throw httpError(404, "claim not found");
    const [auditCounts, jobs, reviewCases, assessment, satelliteRows] = await Promise.all([
      ClaimAudit.aggregate([{ $match: { claimId: claim._id } }, { $group: { _id: "$action", count: { $sum: 1 } } }]),
      VerificationJob.find({ claimId: claim._id }).sort({ createdAt: 1, _id: 1 }).select("step status attempts planKey recoveryRound runAt lastError requeuedAt").lean(),
      VerificationEvidence.countDocuments({ claimId: claim._id, "metadata.kind": "review_case" }),
      ClaimAssessment.findOne({ claimId: claim._id }).select("status state policy verification hold").lean(),
      VerificationEvidence.countDocuments({ claimId: claim._id, component: "satellite", "metadata.kind": { $ne: "review_case" } }),
    ]);
    const now = Date.now();
    const jobRows = jobs.map((job) => ({
      step: job.step,
      status: job.status,
      attempts: job.attempts || 0,
      planKey: job.planKey || null,
      recoveryRound: job.recoveryRound || 0,
      runAt: job.runAt ? new Date(job.runAt).toISOString() : null,
      lastErrorKind: (job.lastError && job.lastError.kind) || null,
      requeued: Boolean(job.requeuedAt),
    }));
    const held = Boolean(assessment && !assessment.state && assessment.verification && assessment.verification.status === "held");
    const decided = DECISION_STATES.has(claim.state);
    const activeDecisionJobs = jobRows.filter((job) => DECISION_INPUT_AND_ENGINE.has(job.step) && ACTIVE.has(job.status)).length;
    // Jobs that will run soon (a satellite re-check queued for tomorrow does not count).
    const pendingSoon = jobRows.filter((job) => job.status === "running" || (job.status === "queued" && (!job.runAt || Date.parse(job.runAt) <= now + 60_000))).length;
    const maxRecoveryRound = jobRows.filter((job) => job.step === "ai_assessment").reduce((max, job) => Math.max(max, job.recoveryRound), 0);
    return {
      claimId: String(claim._id),
      state: claim.state,
      submissionRound: claim.submissionRound ?? null,
      firstSubmittedAt: claim.firstSubmittedAt ? new Date(claim.firstSubmittedAt).toISOString() : null,
      decidedAt: claim.decidedAt ? new Date(claim.decidedAt).toISOString() : null,
      audits: Object.fromEntries(auditCounts.map((row) => [row._id, row.count])),
      jobs: jobRows,
      reviewCases,
      satelliteRows,
      assessment: assessment
        ? {
            status: assessment.status || null,
            state: assessment.state || null,
            verificationStatus: (assessment.verification && assessment.verification.status) || null,
            held,
            policy: assessment.policy && assessment.policy.id ? { id: assessment.policy.id, hash: assessment.policy.hash || null } : null,
          }
        : null,
      settled: {
        decided: decided && pendingSoon === 0,
        held: claim.state === "submitted" && held && activeDecisionJobs === 0,
        activeDecisionJobs,
        pendingSoon,
        maxRecoveryRound,
      },
    };
  };

  // ---- the worker ----------------------------------------------------------------------------------------
  const settings = {
    pollIntervalMs: positive(process.env.WORKER_POLL_INTERVAL_MS, 250),
    batchBudgetMs: positive(process.env.WORKER_BATCH_BUDGET_MS, 20_000),
    maxJobsPerBatch: positive(process.env.WORKER_MAX_JOBS, 25),
    sweepIntervalMs: positive(process.env.WORKER_SWEEP_INTERVAL_MS, 1000),
  };
  const worker = { mode: workerMode, state: "stopped", loop: null, stop: false, child: null, starts: 0, lastExit: null };

  const startInline = () => {
    if (worker.loop) return;
    worker.stop = false;
    worker.state = "running";
    worker.starts += 1;
    worker.loop = runWorkerLoop({ shouldStop: () => worker.stop, ...settings })
      .catch((error) => log(`inline worker stopped with an error: ${error?.message}`))
      .finally(() => {
        worker.loop = null;
        if (worker.state === "running") worker.state = "stopped";
      });
  };
  const stopInline = async (nextState) => {
    worker.stop = true;
    if (worker.loop) await worker.loop;
    worker.state = nextState;
  };

  const startProcess = () => {
    if (worker.child) return;
    const preload = pathToFileURL(path.join(backendRoot, "scripts", "e2e", "fakeGeminiPreload.js")).href;
    const child = spawn(process.execPath, ["--import", preload, path.join(backendRoot, "scripts", "worker.js")], {
      cwd: backendRoot,
      env: { ...process.env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    worker.child = child;
    worker.state = "running";
    worker.starts += 1;
    child.once("exit", (code, signal) => {
      worker.lastExit = { code, signal, at: new Date().toISOString() };
      if (worker.child === child) worker.child = null;
      if (worker.state === "running") worker.state = "stopped";
    });
  };
  const signalProcess = (signal, nextState) =>
    new Promise((resolve) => {
      const child = worker.child;
      if (!child) {
        worker.state = nextState;
        return resolve();
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.once("exit", () => {
        clearTimeout(timer);
        worker.state = nextState;
        resolve();
      });
      worker.state = nextState === "killed" ? "killing" : "stopping";
      child.kill(signal);
    });

  const status = () => ({
    mode: worker.mode,
    state: worker.state,
    starts: worker.starts,
    pid: worker.child ? worker.child.pid : null,
    lastExit: worker.lastExit,
  });

  const startWorker = async () => {
    if (worker.mode === "process") startProcess();
    else startInline();
    return status();
  };
  const stopWorker = async () => {
    if (worker.mode === "process") await signalProcess("SIGTERM", "stopped");
    else await stopInline("stopped");
  };

  const workerAction = async (action) => {
    switch (action) {
      case "pause":
        if (worker.mode === "process") await signalProcess("SIGTERM", "paused");
        else await stopInline("paused");
        return status();
      case "resume":
      case "start":
        if (action === "start" && worker.mode !== "process") throw httpError(409, "start is for --worker=process (use resume)");
        if (worker.mode === "off") throw httpError(409, "the worker is off (--worker=off); use drain-once");
        return startWorker();
      case "kill":
        if (worker.mode !== "process") throw httpError(409, "kill is for --worker=process");
        await signalProcess("SIGKILL", "killed");
        return status();
      case "drain-once": {
        const result = await drainDueJobs({ deadline: Date.now() + settings.batchBudgetMs, maxJobs: settings.maxJobsPerBatch, requestId: `e2e-drain-${randomUUID()}` });
        return { ...status(), processed: result.processed, outcomes: result.results.map((entry) => `${entry.step}:${entry.outcome}`) };
      }
      case "status":
        return status();
      default:
        throw httpError(400, "action must be pause, resume, drain-once, kill, start or status");
    }
  };

  // ---- network violations (this process and a process worker) --------------------------------------------
  const violations = () => {
    const local = networkViolations().map((entry) => ({ ...entry, process: "harness" }));
    let child = [];
    try {
      child = fs
        .readFileSync(violationsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { kind: "unparseable", line: line.slice(0, 200) };
          }
        });
    } catch {
      child = [];
    }
    return [...local, ...child];
  };

  const controlDeps = ({ controlUrl }) => ({
    health: async () => ({ apiUrl, controlUrl: controlUrl(), policy: { id: policy.id, hash: policy.hash }, worker: status(), startedAt }),
    createSession,
    getScenario: async () => getScenario(),
    applyScenario: async (body) => applyScenario(body),
    scenarios: async () => loadScenarios(),
    worker: workerAction,
    inspect,
    seedClaim,
    fixtureImage: ({ seed, width, height }) => fixtureJpeg({ seed: seed ?? "1", width, height }),
    violations: async () => violations(),
    tile: () => greyTilePng(),
  });

  return { controlDeps, startWorker, stopWorker, workerStatus: status, applyScenario, createSession, seedClaim, inspect, violations };
};

export default { createHarnessServices, LAND_RECORD_OUTCOMES };
