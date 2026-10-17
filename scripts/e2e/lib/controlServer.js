// The e2e CONTROL server (ADR-024, design-testing §2.1 step 8). A separate Express app on its own port
// (127.0.0.1:18081 by default): it is never mounted on the product app, so none of these routes exist on
// the API port, in production or anywhere else. Every route needs `Authorization: Bearer
// <E2E_CONTROL_TOKEN>` except the health check, the map tiles and the geocoder stubs (HX-5), which the
// browser fetches. The behaviour lives in `deps` (scripts/e2e/hermeticBackend.js), so this file can be
// tested without a database.

import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";

export const PUBLIC_PATHS = Object.freeze([/^\/__e2e\/health$/, /^\/tiles\/\d+\/\d+\/\d+\.png$/, /^\/geocode\/(search|reverse)$/]);
export const isPublicPath = (pathname) => PUBLIC_PATHS.some((pattern) => pattern.test(pathname));

const digest = (value) => createHash("sha256").update(String(value)).digest();
export const tokenMatches = (header, token) => {
  if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice(7).trim()), digest(token));
};

// Map an error from a dependency to a JSON response: `statusCode` when it carries one, else 500.
const send = (res, error) => {
  const status = Number(error && (error.statusCode || error.status)) || 500;
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: String((error && error.message) || "error").slice(0, 300) });
};
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    send(res, error);
  }
};

const THANJAVUR = Object.freeze({ lat: "10.7870", lon: "79.1378" });

export const createControlApp = ({ token, deps }) => {
  if (!token || String(token).length < 16) throw new Error("createControlApp: a control token of at least 16 characters is required");
  const app = express();
  app.disable("x-powered-by");

  // Tiles and geocoding are requested by the browser (MapLibre, the location search) from the Vite
  // origin, so they answer CORS; nothing else does.
  app.use((req, res, next) => {
    if (isPublicPath(req.path) && req.path !== "/__e2e/health") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      if (req.method === "OPTIONS") {
        res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.set("Access-Control-Allow-Headers", req.get("access-control-request-headers") || "*");
        return res.status(204).end();
      }
    }
    if (isPublicPath(req.path) || tokenMatches(req.get("authorization"), token)) return next();
    return res.status(401).json({ error: "control token required" });
  });
  app.use(express.json({ limit: "256kb" }));

  // --- public ---------------------------------------------------------------------------------------
  app.get("/__e2e/health", wrap(async (req, res) => res.json({ ok: true, ...(await deps.health()) })));
  app.get("/tiles/:z/:x/:y.png", wrap(async (req, res) => {
    res.type("image/png").set("Cache-Control", "public, max-age=3600").send(await deps.tile());
  }));
  app.get("/geocode/search", (req, res) => {
    // Nominatim's search shape: a fixed Thanjavur result whatever the query (no network, no data source).
    res.json([
      {
        place_id: 1,
        osm_type: "relation",
        osm_id: 1,
        lat: THANJAVUR.lat,
        lon: THANJAVUR.lon,
        class: "boundary",
        type: "administrative",
        name: "Thanjavur",
        display_name: "Thanjavur, Thanjavur district, Tamil Nadu, 613001, India",
        boundingbox: ["10.7570", "10.8170", "79.1078", "79.1678"],
        address: { city: "Thanjavur", state_district: "Thanjavur", state: "Tamil Nadu", "ISO3166-2-lvl4": "IN-TN", postcode: "613001", country: "India", country_code: "in" },
      },
    ]);
  });
  app.get("/geocode/reverse", (req, res) => {
    res.json({
      place_id: 1,
      lat: String(req.query.lat ?? THANJAVUR.lat),
      lon: String(req.query.lon ?? THANJAVUR.lon),
      display_name: "Vallam, Thanjavur, Thanjavur district, Tamil Nadu, 613403, India",
      address: { village: "Vallam", county: "Thanjavur", state_district: "Thanjavur", state: "Tamil Nadu", "ISO3166-2-lvl4": "IN-TN", postcode: "613403", country: "India", country_code: "in" },
    });
  });

  // --- protected --------------------------------------------------------------------------------------
  app.post("/__e2e/session", wrap(async (req, res) => res.json(await deps.createSession(req.body || {}))));
  app.get("/__e2e/scenario", wrap(async (req, res) => res.json(await deps.getScenario())));
  app.post("/__e2e/scenario", wrap(async (req, res) => res.json(await deps.applyScenario(req.body || {}))));
  app.get("/__e2e/scenarios", wrap(async (req, res) => res.json(await deps.scenarios())));
  app.post("/__e2e/worker", wrap(async (req, res) => res.json(await deps.worker(String((req.body || {}).action || "")))));
  app.get("/__e2e/claims/:id/inspect", wrap(async (req, res) => res.json(await deps.inspect(req.params.id))));
  app.post("/__e2e/seed-claim", wrap(async (req, res) => res.json(await deps.seedClaim(req.body || {}))));
  app.get("/__e2e/fixture-image", wrap(async (req, res) => {
    res.type("image/jpeg").set("Cache-Control", "no-store").send(await deps.fixtureImage({ seed: req.query.seed, width: req.query.w, height: req.query.h }));
  }));
  app.get("/__e2e/network-violations", wrap(async (req, res) => res.json(await deps.violations())));

  app.use((req, res) => res.status(404).json({ error: "not found" }));
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => send(res, error));
  return app;
};

export default { createControlApp, isPublicPath, tokenMatches, PUBLIC_PATHS };
