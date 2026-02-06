/**
 * Custom error classes for typed error handling.
 * Use instanceof checks instead of fragile string matching.
 */

export class TurnLimitError extends Error {
  constructor(maxIterations: number) {
    super(
      `Maximum iterations (${maxIterations}) reached. ` +
      'This may indicate an infinite loop. Check tool implementations.'
    );
    this.name = 'TurnLimitError';
  }
}

export class SessionTimeoutError extends Error {
  constructor(timeoutMs?: number) {
    super(timeoutMs ? `Session timed out after ${timeoutMs}ms` : 'Session timeout');
    this.name = 'SessionTimeoutError';
  }
}
