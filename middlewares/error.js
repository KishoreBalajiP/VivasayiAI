import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import logger, { maskUrl } from "../utils/logger.js";

const notFoundHandler = (req, res) => {
  res.status(404).json(new ApiResponse(404, "Route not found", {}));
};

const errorHandler = (err, req, res, next) => {
  const isApiError = err instanceof ApiError;
  const isBodyParseError = err.type === "entity.parse.failed";
  const statusCode = isApiError ? err.statusCode : isBodyParseError ? 400 : 500;
  const message = isApiError
    ? err.message
    : isBodyParseError
    ? "Invalid JSON payload"
    : "Internal server error";

  logger.error(
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