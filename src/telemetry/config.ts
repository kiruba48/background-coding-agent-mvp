/**
 * Splunk Agent Observability telemetry configuration.
 *
 * Telemetry is opt-in: it is enabled only when both SPLUNK_AO_REALM and
 * SPLUNK_AO_O11Y_TOKEN are set (and SPLUNK_AO_LOGGING_DISABLED is not "true").
 */
export interface TelemetryConfig {
  realm: string;
  token: string;
  project: string;
  agentStream: string;
  /** false → prompts, outputs, tool args and tool results are redacted before export */
  captureContent: boolean;
  serviceName: string;
}

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

export function readTelemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig | null {
  if (value(env, 'SPLUNK_AO_LOGGING_DISABLED')?.toLowerCase() === 'true') return null;

  const realm = value(env, 'SPLUNK_AO_REALM');
  const token = value(env, 'SPLUNK_AO_O11Y_TOKEN');
  if (!realm || !token) return null;

  return {
    realm,
    token,
    project: value(env, 'SPLUNK_AO_PROJECT') ?? 'background-coding-agent',
    agentStream: value(env, 'SPLUNK_AO_AGENT_STREAM') ?? 'default',
    captureContent: value(env, 'SPLUNK_AO_CAPTURE_CONTENT')?.toLowerCase() !== 'false',
    serviceName: value(env, 'OTEL_SERVICE_NAME') ?? 'background-coding-agent',
  };
}
