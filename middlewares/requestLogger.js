import crypto from "crypto";
import logger, { maskUrl } from "../utils/logger.js";

const requestLogger = (req, res, next) => {
  // A client may supply a correlation id, but only a short, plain one: it is echoed in a response
  // header and written to every log line, so anything else (long, spaces, line breaks, markup) is
  // replaced rather than trusted.
  const supplied = req.headers["x-request-id"];
  const requestId =
    typeof supplied === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(supplied)
      ? supplied
      : typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex");

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