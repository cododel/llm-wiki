export class ServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function requireCondition(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new ServiceError(code, message, status);
}
export function errorResult(error: unknown) {
  return error instanceof ServiceError
    ? { code: error.code, message: error.message, status: error.status }
    : { code: 'internal_error', message: 'Operation failed; contact the operator', status: 500 };
}
