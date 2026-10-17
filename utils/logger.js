import { createRequire } from "node:module";
import pino from "pino";

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// A signed capability in a query string (the dev upload receiver's `sig`, ADR-024) is never logged.
const SIGNATURE_PARAM = /([?&]sig=)[^&#]*/g;

export const maskUrl = (url = "") => url.replace(EMAIL_PATTERN, "<email>").replace(SIGNATURE_PARAM, "$1<redacted>");

const require = createRequire(import.meta.url);

// pino-pretty is a devDependency. The Lambda image installs production dependencies only, so it
// may be absent even when NODE_ENV was never set to "production" — in that case log plain JSON.
const detectPretty = () => {
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
};

export const createLogger = ({
  isProduction,
  prettyAvailable,
  level,
  runningInLambda = false,
}) => {
  const baseOptions = {
    level,
    base: { service: "vivasayi-backend" },
  };
  if (isProduction || runningInLambda || !prettyAvailable) {
    return pino(baseOptions);
  }
  const transport = pino.transport({
    target: "pino-pretty",
    options: {
      colorize: false,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  });
  return pino(baseOptions, transport);
};

const isProduction = (process.env.NODE_ENV || "development") === "production";
const defaultLevel = isProduction ? "info" : "debug";

const logger = createLogger({
  isProduction,
  prettyAvailable: detectPretty(),
  level: process.env.LOG_LEVEL || defaultLevel,
  runningInLambda: Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME),
});

export default logger;
