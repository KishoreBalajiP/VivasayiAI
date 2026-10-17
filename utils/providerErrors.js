import ApiError from "./ApiError.js";
import { AiTimeoutError } from "./aiTimeout.js";

// Provider error taxonomy (plan A1). Every failure of an external provider (Gemini, S3, the land
// record service) is classified into ONE kind, so the queue can decide whether to retry, the engine
// can hold instead of deciding, and the logs say what went wrong without carrying the provider's
// message body, the prompt or a key.
//
//   kind                 code                   retry                 log level
//   quota                PROVIDER_QUOTA         yes                   warn
//   overload             PROVIDER_OVERLOAD      yes                   warn
//   timeout              PROVIDER_TIMEOUT       yes                   warn
//   network              PROVIDER_NETWORK       yes                   warn
//   auth_config          PROVIDER_AUTH_CONFIG   yes (operator action) error
//   malformed_response   PROVIDER_MALFORMED     yes                   warn
//   storage              STORAGE_UNAVAILABLE    yes                   warn
//   application_defect   APP_DEFECT             at most 3 attempts    error
//
// A technical failure is never a finding about the claim: callers turn it into `unavailable`, a
// retry or a review case, never into a rejection or a request for more evidence.

export const PROVIDER_ERROR_KINDS = Object.freeze({
  QUOTA: "quota",
  OVERLOAD: "overload",
  TIMEOUT: "timeout",
  NETWORK: "network",
  AUTH_CONFIG: "auth_config",
  MALFORMED: "malformed_response",
  STORAGE: "storage",
  DEFECT: "application_defect",
});

const KIND_SET = new Set(Object.values(PROVIDER_ERROR_KINDS));

export const PROVIDER_ERROR_CODES = Object.freeze({
  quota: "PROVIDER_QUOTA",
  overload: "PROVIDER_OVERLOAD",
  timeout: "PROVIDER_TIMEOUT",
  network: "PROVIDER_NETWORK",
  auth_config: "PROVIDER_AUTH_CONFIG",
  malformed_response: "PROVIDER_MALFORMED",
  storage: "STORAGE_UNAVAILABLE",
  application_defect: "APP_DEFECT",
});

// Farmer-safe defaults. Call sites that already had a message keep it (see `message` below).
const DEFAULT_MESSAGE = Object.freeze({
  quota: "AI service is busy. Please try again later.",
  overload: "AI service is busy. Please try again later.",
  timeout: "AI service did not respond in time",
  network: "AI service could not be reached. Please try again later.",
  auth_config: "AI service is temporarily unavailable",
  malformed_response: "AI service returned an unreadable response",
  storage: "Image storage unavailable",
  application_defect: "Internal server error",
});

// "Busy" and "temporarily unavailable" are 503 so a client waits instead of retrying at once.
const DEFAULT_STATUS = Object.freeze({ quota: 503, overload: 503, auth_config: 503 });

export class ProviderError extends ApiError {
  // `statusCode` and `message` let an existing call site keep its exact HTTP behaviour while still
  // carrying a kind. Without them the defaults above apply.
  constructor({ kind, provider = null, operation = null, httpStatus = null, cause = null, message = null, statusCode = null } = {}) {
    const safeKind = KIND_SET.has(kind) ? kind : PROVIDER_ERROR_KINDS.DEFECT;
    super(statusCode ?? DEFAULT_STATUS[safeKind] ?? 500, message || DEFAULT_MESSAGE[safeKind]);
    this.name = "ProviderError";
    this.kind = safeKind;
    this.code = PROVIDER_ERROR_CODES[safeKind];
    this.retryable = safeKind !== PROVIDER_ERROR_KINDS.DEFECT;
    this.provider = provider;
    this.operation = operation;
    this.httpStatus = Number.isFinite(Number(httpStatus)) && httpStatus !== null ? Number(httpStatus) : null;
    // `cause` is accepted but deliberately NOT kept: pino's error serializer appends `err.cause`
    // messages to every logged error, and a provider's message can carry a prompt, a URL or a key.
    void cause;
  }
}

export const isProviderError = (err) => err instanceof ProviderError;

const NETWORK_CODES = new Set(["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

// The HTTP status a provider answered with, if any. Our own ApiError carries `statusCode` for the
// response WE send, which says nothing about the provider, so it is ignored here.
export const providerStatusOf = (err) => {
  if (!err || typeof err !== "object") return null;
  const raw = err.status ?? err.response?.status ?? err.$metadata?.httpStatusCode ?? (err instanceof ApiError ? null : err.statusCode);
  const status = Number(raw);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
};

const errorCodeOf = (err) => String(err?.code ?? err?.cause?.code ?? err?.errno ?? "");
const messageOf = (err) => String(err?.message ?? "");

// Pure: one kind for any thrown value. First match wins; anything unrecognised is an application
// defect (retried at most three times), never silently "transient".
export const classifyProviderError = (err) => {
  if (!err) return PROVIDER_ERROR_KINDS.DEFECT;
  if (err instanceof ProviderError) return err.kind;
  if (typeof err.kind === "string" && KIND_SET.has(err.kind) && err.name === "ProviderError") return err.kind;

  const code = errorCodeOf(err);
  const message = messageOf(err);
  const status = providerStatusOf(err);

  // AbortError: our own fetch deadlines abort the request (officialLandRecord, satellite).
  if (err instanceof AiTimeoutError || err.name === "AiTimeoutError" || err.name === "TimeoutError" || err.name === "AbortError" || TIMEOUT_CODES.has(code)) {
    return PROVIDER_ERROR_KINDS.TIMEOUT;
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|too many requests/i.test(message)) return PROVIDER_ERROR_KINDS.QUOTA;
  // `UNAVAILABLE` is matched case-sensitively: it is the gRPC status word, not our own "… unavailable".
  if (status === 502 || status === 503 || status === 504 || /\bUNAVAILABLE\b/.test(message) || /overloaded|service unavailable/i.test(message)) {
    return PROVIDER_ERROR_KINDS.OVERLOAD;
  }
  if (
    status === 401 ||
    status === 403 ||
    /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message) ||
    /API[_ ]?KEY/i.test(code)
  ) {
    return PROVIDER_ERROR_KINDS.AUTH_CONFIG;
  }
  if (NETWORK_CODES.has(code) || /fetch failed|socket hang up|network error/i.test(message)) return PROVIDER_ERROR_KINDS.NETWORK;
  return PROVIDER_ERROR_KINDS.DEFECT;
};

// Wrap any thrown value as a ProviderError with call-site context. An existing ProviderError is
// returned unchanged so a kind decided deeper down (for example malformed output) is never lost.
export const toProviderError = (err, { provider = null, operation = null, message = null, statusCode = null, kind = null } = {}) => {
  if (err instanceof ProviderError) return err;
  return new ProviderError({
    kind: kind || classifyProviderError(err),
    provider,
    operation,
    httpStatus: providerStatusOf(err),
    cause: err,
    message,
    statusCode,
  });
};

// Context keys a log record may carry. Identifiers only: never prompts, message bodies, URLs, keys.
const SAFE_CONTEXT_KEYS = ["claimId", "evidenceId", "uploadId", "jobId", "step", "requestId", "conversationId", "attempt"];

export const logProviderError = (log, err, context = {}) => {
  const providerError = toProviderError(err);
  const record = {
    code: providerError.code,
    kind: providerError.kind,
    provider: providerError.provider,
    operation: providerError.operation,
    httpStatus: providerError.httpStatus,
    retryable: providerError.retryable,
  };
  if (providerError.kind === PROVIDER_ERROR_KINDS.AUTH_CONFIG) record.operatorAction = true;
  for (const key of SAFE_CONTEXT_KEYS) {
    if (context && context[key] !== undefined && context[key] !== null) record[key] = String(context[key]).slice(0, 120);
  }
  const level = providerError.kind === PROVIDER_ERROR_KINDS.AUTH_CONFIG || providerError.kind === PROVIDER_ERROR_KINDS.DEFECT ? "error" : "warn";
  if (log && typeof log[level] === "function") log[level](record, "provider.error");
  return record;
};

export default {
  PROVIDER_ERROR_KINDS,
  PROVIDER_ERROR_CODES,
  ProviderError,
  isProviderError,
  classifyProviderError,
  toProviderError,
  providerStatusOf,
  logProviderError,
};
