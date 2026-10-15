import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import logger, { maskUrl } from "../utils/logger.js";

const notFoundHandler = (req, res) => {
  res.status(404).json(new ApiResponse(404, "Route not found", {}));
};

// Errors raised by body-parser (express.json) before any route runs. Each carries a `type`; without
// this table everything but a JSON syntax error was reported as an opaque 500.
const BODY_PARSER_ERRORS = {
  "entity.parse.failed": [400, "Invalid JSON payload"],
  "entity.too.large": [413, "Request body too large"],
  "encoding.unsupported": [415, "Unsupported content encoding"],
  "charset.unsupported": [415, "Unsupported charset"],
  "request.aborted": [400, "Request aborted"],
  "request.size.invalid": [400, "Invalid request size"],
};

const errorHandler = (err, req, res, next) => {
  const isApiError = err instanceof ApiError;
  const bodyParserError = !isApiError ? BODY_PARSER_ERRORS[err?.type] : undefined;
  const statusCode = isApiError ? err.statusCode : bodyParserError ? bodyParserError[0] : 500;
  const message = isApiError
    ? err.message
    : bodyParserError
    ? bodyParserError[1]
    : "Internal server error";

  // Expected client errors (4xx) are routine; only server faults should page anyone.
  const log = statusCode >= 500 ? logger.error : logger.warn;
  log.call(
    logger,
    {
      requestId: req && req.requestId,
      method: req && req.method,
      url: req && maskUrl(req.originalUrl),
      statusCode,
      err,
    },
    "request failed"
  );

  res.status(statusCode).json(new ApiResponse(statusCode, message, {}));
};

export { notFoundHandler, errorHandler };
