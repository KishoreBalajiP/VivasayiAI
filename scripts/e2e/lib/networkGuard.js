// Loopback-only network guard (ADR-024, design-testing §2.1 step 3). Installed by the hermetic e2e
// harness before anything can open a connection, by the process-worker preload, and by the test
// fixture tests/fixtures/networkGuard.js. Every TCP or TLS connection and every DNS query for a host
// other than this machine THROWS (code `<label>_EXTERNAL_NETWORK_BLOCKED`) and is RECORDED with host,
// port, kind and the first stack frame outside this file, so a run can prove it made zero external
// attempts (GET /__e2e/network-violations). This covers axios (weather), undici fetch, the AWS SDK,
// Cohere, Chroma and Gemini, which all end in net.Socket#connect, tls.connect or dns.
//
// Pure Node: imports nothing from the application, so it can run before config/env.js is loaded.

import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";

const LOOPBACK_NAMES = new Set(["localhost", "::1", "[::1]", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]);
export const isLoopbackHost = (host) => {
  const value = String(host ?? "").trim().toLowerCase();
  if (value === "") return true; // Node's default host is localhost
  return LOOPBACK_NAMES.has(value) || /^127(\.\d{1,3}){3}$/.test(value) || /^::ffff:127(\.\d{1,3}){3}$/.test(value);
};

const DNS_NAMES = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolveSrv", "resolveTxt", "resolveNaptr", "resolvePtr", "resolveSoa", "resolveCaa", "reverse"];

let state = null;

const topFrame = () => {
  const lines = String(new Error().stack || "").split("\n").slice(1);
  const frame = lines.find((line) => !line.includes("/scripts/e2e/lib/networkGuard.js") && !line.includes("node:"));
  return frame ? frame.trim().slice(0, 300) : null;
};

// Record a blocked attempt and return the error to throw (or reject with, for promise APIs).
const blockedError = (kind, host, port) => {
  const violation = { kind, host: String(host ?? ""), port: port === undefined || port === null ? null : Number(port) || String(port), at: new Date().toISOString(), frame: topFrame() };
  state.violations.push(violation);
  try {
    state.onViolation?.(violation);
  } catch {
    // recording must never mask the block itself
  }
  return Object.assign(new Error(`${state.label}_EXTERNAL_NETWORK_BLOCKED: ${kind} ${violation.host}${violation.port ? `:${violation.port}` : ""}`), {
    code: `${state.label}_EXTERNAL_NETWORK_BLOCKED`,
  });
};
const block = (kind, host, port) => {
  throw blockedError(kind, host, port);
};

// Where a connect call is going: (options), (port, host), (path) or ([options, cb]) (internal form).
const connectTarget = (args) => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (first.path) return null; // a Unix socket or named pipe is local
    return { host: first.host ?? first.hostname ?? "localhost", port: first.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null; // connect(path)
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
};

export const installNetworkGuard = ({ label = "E2E", onViolation = null } = {}) => {
  if (state) {
    state.label = label;
    state.onViolation = onViolation ?? state.onViolation;
    return state.api;
  }
  state = { label, onViolation, violations: [], originals: [] };
  const patch = (target, name, wrap) => {
    const original = target[name];
    if (typeof original !== "function") return;
    state.originals.push([target, name, original]);
    target[name] = wrap(original);
  };

  patch(net.Socket.prototype, "connect", (original) =>
    function guardedConnect(...args) {
      const target = connectTarget(args);
      if (target && !isLoopbackHost(target.host)) block("connect", target.host, target.port);
      return original.apply(this, args);
    }
  );
  patch(tls, "connect", (original) =>
    function guardedTlsConnect(...args) {
      const first = args[0];
      const options = first && typeof first === "object" ? first : null;
      const host = options ? options.host ?? options.servername ?? "localhost" : typeof args[1] === "string" ? args[1] : "localhost";
      const port = options ? options.port : first;
      if (!(options && (options.path || options.socket)) && !isLoopbackHost(host)) block("tls", host, port);
      return original.apply(this, args);
    }
  );
  // The callback APIs throw at once (like the socket guard); the promise APIs reject.
  for (const [target, promises] of [[dns, false], [dns.Resolver.prototype, false], [dns.promises, true], [dns.promises.Resolver.prototype, true]]) {
    for (const name of DNS_NAMES) {
      patch(target, name, (original) =>
        function guardedResolve(hostname, ...rest) {
          if (!isLoopbackHost(hostname)) {
            if (promises) return Promise.reject(blockedError(`dns.${name}`, hostname, null));
            block(`dns.${name}`, hostname, null);
          }
          return original.call(this, hostname, ...rest);
        }
      );
    }
  }

  state.api = {
    violations: () => state.violations.map((entry) => ({ ...entry })),
    clear: () => {
      state.violations.length = 0;
    },
  };
  return state.api;
};

// Restore every patched function (tests). A no-op when the guard is not installed.
export const uninstallNetworkGuard = () => {
  if (!state) return;
  for (const [target, name, original] of state.originals.reverse()) target[name] = original;
  state = null;
};

export const networkViolations = () => (state ? state.api.violations() : []);
export const isNetworkGuardInstalled = () => Boolean(state);

export default { installNetworkGuard, uninstallNetworkGuard, networkViolations, isNetworkGuardInstalled, isLoopbackHost };
