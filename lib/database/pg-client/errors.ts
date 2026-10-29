/**
 * Errors in the same shape supabase-js returns (PostgrestError), so callers
 * checking `error.code === 'PGRST116'` keep working.
 */

export interface PostgrestError {
  message: string;
  details: string | null;
  hint: string | null;
  code: string;
}

export class PgClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: string | null = null,
    public readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'PgClientError';
  }
}

export function toPostgrestError(error: unknown): PostgrestError {
  if (error instanceof PgClientError) {
    return { message: error.message, details: error.details, hint: error.hint, code: error.code };
  }

  const pgError = error as { message?: string; detail?: string; hint?: string; code?: string };
  return {
    message: pgError?.message ?? String(error),
    details: pgError?.detail ?? null,
    hint: pgError?.hint ?? null,
    code: pgError?.code ?? 'PGRST000',
  };
}
