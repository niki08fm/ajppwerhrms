/** Wrap an async route handler so a rejected promise reaches the error handler. */
export const asyncHandler = (fn) => (req, res, next) => {
  fn(req, res, next).catch(next);
};
