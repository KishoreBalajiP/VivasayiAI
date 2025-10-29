class ApiResponse {
  constructor(statusCode, message, data) {
    this.statusCode = statusCode;
    this.message = message;
    this.data = data;
  }

  static success(res, message, data = {}) {
    return res.status(200).json(new ApiResponse(200, message, data));
  }

  static error(res, statusCode, message, data = {}) {
    return res
      .status(statusCode)
      .json(new ApiResponse(statusCode, message, data));
  }

  static badRequest(res, message, data = {}) {
    return res.status(400).json(new ApiResponse(400, message, data));
  }

  static unauthorized(res, message) {
    return res.status(401).json(new ApiResponse(401, message, ""));
  }
}

export default ApiResponse;