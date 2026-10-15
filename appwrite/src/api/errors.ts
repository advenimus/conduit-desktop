// Errors keep the PostgREST shape ({ code, message, details, hint }) and the Postgres SQLSTATE codes the
// apps already branch on (42501 denied, 23514 check/plan rule, 28000 signed out, PGRST116 single row).

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(code: string, message: string, status = statusFor(code), details: string | null = null, hint: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.hint = hint;
  }

  toJSON(): { code: string; message: string; details: string | null; hint: string | null } {
    return { code: this.code, message: this.message, details: this.details, hint: this.hint };
  }
}

/** Commit lost a race (guard row or a changed row). The whole operation is retried. */
export class ConflictError extends Error {
  constructor(message = 'write conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}

function statusFor(code: string): number {
  if (code === '28000') return 401;
  if (code === '42501') return 403;
  if (code === 'PGRST116') return 406;
  if (code === '23505') return 409;
  if (code === '23503' || code === '23502' || code === '23514' || code === '22023' || code === '22P02') return 400;
  if (code.startsWith('PGRST')) return 400;
  return 400;
}

export const denied = (table: string): ApiError =>
  new ApiError('42501', `new row violates row-level security policy for table "${table}"`);

export const raise = (code: string, message: string): never => {
  throw new ApiError(code, message);
};
