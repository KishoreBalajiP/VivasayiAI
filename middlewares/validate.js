import ApiError from "../utils/ApiError.js";

const validate = (schema, source = "body") => (req, res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    throw ApiError.badRequest(result.error.issues[0].message);
  }
  // Only req.body is writable; req.query/req.params are Express getters.
  if (source === "body") {
    req.body = result.data;
  }
  next();
};

export default validate;
