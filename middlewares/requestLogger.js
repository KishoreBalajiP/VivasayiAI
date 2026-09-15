import crypto from "crypto";
import logger, { maskUrl } from "../utils/logger.js";

const requestLogger = (req, res, next) => {
  const requestId =
    req.headers["x-request-id"] ||
    (typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex"));

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs =
      Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    logger.info(
      {
        requestId,
        method: req.method,
        url: maskUrl(req.originalUrl),
        status: res.statusCode,
        durationMs,
      },
      "request completed"
    );
  });

  next();
};

export default requestLogger;