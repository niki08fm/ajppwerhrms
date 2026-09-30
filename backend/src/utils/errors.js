/** Every error the API returns has a machine code and a message written for a person. */
export class AppError extends Error {
  constructor(code, message, status = 400, field = null, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.field = field;
    this.details = details;
    this.name = 'AppError';
  }
}

export const notFound = (what) => new AppError('NOT_FOUND', `${what} was not found.`, 404);
export const forbidden = (message = 'You do not have permission to do this. Ask the HR administrator.') => new AppError('FORBIDDEN', message, 403);
