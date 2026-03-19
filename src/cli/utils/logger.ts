import pino from 'pino';
import { createPrettyDestination } from './pretty-destination.js';

const REDACT_PATHS = [
  'apiKey',
  '*.apiKey',
  'token',
  '*.token',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'credentials',
  '*.credentials',
  'ANTHROPIC_API_KEY',
  'env.ANTHROPIC_API_KEY',
  'config.anthropicApiKey'
];

/**
 * Create a Pino logger instance with PII redaction.
 *
 * Output format:
 * - TTY (interactive terminal): human-readable progress lines via pretty destination
 * - Non-TTY (piped/CI): structured JSON (pino default)
 *
 * Override with LOG_FORMAT=json to force JSON even in TTY.
 *
 * @returns Pino logger instance
 */
export function createLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL || 'info';
  const redact = { paths: REDACT_PATHS, censor: '[REDACTED]' };
  const forceJson = process.env.LOG_FORMAT === 'json';

  if (!forceJson && process.stderr.isTTY) {
    return pino({ level, redact }, createPrettyDestination());
  }

  return pino({ level, redact });
}

/**
 * Re-export Logger type from pino for use in other modules
 */
export type { Logger } from 'pino';
