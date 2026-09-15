const asyncHandler = (request) => async (req, res, next) => {
  try {
    return await Promise.resolve(request(req, res, next));
  } catch (err) {
    next(err);
  }
};

export default asyncHandler;
