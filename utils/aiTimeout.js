// Bounded timeout for outbound AI calls.
//
// The backend is deployed behind AWS API Gateway + Lambda. Default synchronous invocation has a
// 30-second ceiling (API Gateway default 29s). Gemini multimodal + RAG + reasoning calls can
// otherwise overrun it and the API Gateway answers the browser with 503 Service Unavailable,
// retrying which eventually trips the per-user application rate limiter and produces the
// follow-on 429.
//
// This helper bounds each external AI call to GEMINI_DEFAULT_TIMEOUT_MS so any single call
// returns a tagged AiTimeoutError well inside the API Gateway ceiling. Other call sites
// translate the tagged error into their existing sanitized 5xx envelopes.
//
// The underlying work is intentionally not aborted (LangChain's @google/generative-ai wrapper
// does not expose the underlying fetch's AbortSignal through its public surface); the result is
// simply discarded once the timeout wins, so the next user action can recover cleanly. Network
// sockets are reclaimed by the Node runtime when the underlying promise eventually settles.

// The production default is re-read on each call so tests can adjust `GEMINI_TIMEOUT_MS` at
// runtime without re-importing the module. The default still lives below the API Gateway /
// Lambda synchronous ceiling (29s default).
export const getDefaultTimeoutMs = () =>
  Number(process.env.GEMINI_TIMEOUT_MS) || 25000;

// Frozen snapshot for logs and tests that need the configured value at import time.
export const GEMINI_DEFAULT_TIMEOUT_MS = getDefaultTimeoutMs();

export class AiTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`AI call '${label}' timed out after ${timeoutMs}ms`);
    this.name = "AiTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

// Returns the result of `work` if it settles before `timeoutMs`; rejects with AiTimeoutError
// otherwise. The `label` is included in the error message and `error.label` for log triage.
export const withAiTimeout = (work, label, timeoutMs) => {
  const effectiveTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : getDefaultTimeoutMs();
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new AiTimeoutError(label, effectiveTimeoutMs));
    }, effectiveTimeoutMs);
    // Do not keep the event loop alive solely for this timer; the real work drives shutdown.
    if (timeoutHandle && typeof timeoutHandle.unref === "function") timeoutHandle.unref();
  });
  // Unref the timer once the work itself settles so we don't pin a worker.
  const cleanup = () => clearTimeout(timeoutHandle);
  return Promise.race([
    Promise.resolve().then(() => work()).finally(cleanup),
    timeout,
  ]).catch((err) => {
    cleanup();
    throw err;
  });
};

export default { withAiTimeout, AiTimeoutError, GEMINI_DEFAULT_TIMEOUT_MS, getDefaultTimeoutMs };
