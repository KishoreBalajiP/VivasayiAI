class ApiResponse {
  constructor(statusCode, message, data) {
    this.statusCode = statusCode;
    this.message = message;
    this.data = data;
  }

  static success(res, message, data = {}) {
    return res.status(200).json(new ApiResponse(200, message, data));
  }
}

export default ApiResponse;
