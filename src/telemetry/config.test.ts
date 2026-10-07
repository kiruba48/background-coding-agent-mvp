import { describe, it, expect } from 'vitest';
import { readTelemetryConfig } from './config.js';

const base = { SPLUNK_AO_REALM: 'eu0', SPLUNK_AO_O11Y_TOKEN: 'tok' };

describe('readTelemetryConfig', () => {
  it('returns null when realm or token is missing', () => {
    expect(readTelemetryConfig({})).toBeNull();
    expect(readTelemetryConfig({ SPLUNK_AO_REALM: 'eu0' })).toBeNull();
    expect(readTelemetryConfig({ SPLUNK_AO_O11Y_TOKEN: 'tok' })).toBeNull();
    expect(readTelemetryConfig({ SPLUNK_AO_REALM: '  ', SPLUNK_AO_O11Y_TOKEN: 'tok' })).toBeNull();
  });

  it('returns null when explicitly disabled', () => {
    expect(readTelemetryConfig({ ...base, SPLUNK_AO_LOGGING_DISABLED: 'true' })).toBeNull();
    expect(readTelemetryConfig({ ...base, SPLUNK_AO_LOGGING_DISABLED: 'TRUE' })).toBeNull();
  });

  it('applies defaults', () => {
    expect(readTelemetryConfig(base)).toEqual({
      realm: 'eu0',
      token: 'tok',
      project: 'background-coding-agent',
      agentStream: 'default',
      captureContent: true,
      serviceName: 'background-coding-agent',
    });
  });

  it('reads overrides and trims whitespace', () => {
    expect(readTelemetryConfig({
      SPLUNK_AO_REALM: ' eu0 ',
      SPLUNK_AO_O11Y_TOKEN: ' tok ',
      SPLUNK_AO_PROJECT: 'bg-agent-spike',
      SPLUNK_AO_AGENT_STREAM: 'dev',
      SPLUNK_AO_CAPTURE_CONTENT: 'false',
      OTEL_SERVICE_NAME: 'bg-agent-local',
    })).toEqual({
      realm: 'eu0',
      token: 'tok',
      project: 'bg-agent-spike',
      agentStream: 'dev',
      captureContent: false,
      serviceName: 'bg-agent-local',
    });
  });

  it('treats any capture value other than "false" as enabled', () => {
    expect(readTelemetryConfig({ ...base, SPLUNK_AO_CAPTURE_CONTENT: 'no' })?.captureContent).toBe(true);
    expect(readTelemetryConfig({ ...base, SPLUNK_AO_CAPTURE_CONTENT: 'FALSE' })?.captureContent).toBe(false);
  });
});
