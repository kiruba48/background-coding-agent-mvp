import pino from 'pino';

/**
 * Create a Pino logger instance with structured JSON output and PII redaction
 *
 * Features:
 * - JSON output for structured logging
 * - Log level from LOG_LEVEL env var (default: 'info')
 * - Automatic redaction of sensitive fields (apiKey, token, password, etc.)
 *
 * @returns Pino logger instance
 */
export function createLogger(): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: [
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
      ],
      censor: '[REDACTED]'
    }
  });
}

/**
 * Re-export Logger type from pino for use in other modules
 */
export type { Logger } from 'pino';
