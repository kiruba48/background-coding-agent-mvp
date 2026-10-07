import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**'],
    // Never export real telemetry from tests, even if the shell has SPLUNK_AO_* set.
    env: { SPLUNK_AO_LOGGING_DISABLED: 'true' },
  },
});
