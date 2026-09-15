import pino from "pino";

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const maskUrl = (url = "") => url.replace(EMAIL_PATTERN, "<email>");

const isProduction = (process.env.NODE_ENV || "development") === "production";
const defaultLevel = isProduction ? "info" : "debug";
const level = process.env.LOG_LEVEL || defaultLevel;

const baseOptions = {
  level,
  base: { service: "vivasayi-backend" },
};

let logger;
if (isProduction) {
  logger = pino(baseOptions);
} else {
  const transport = pino.transport({
    target: "pino-pretty",
    options: {
      colorize: false,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  });
  logger = pino(baseOptions, transport);
}

export default logger;