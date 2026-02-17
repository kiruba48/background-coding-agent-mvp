/**
 * Orchestrator module exports
 *
 * The orchestrator runs on the host and manages:
 * - Docker container lifecycle (via dockerode)
 * - Claude communication (via Anthropic SDK)
 * - Workspace persistence
 */

export { ContainerManager } from './container.js';
export { AgentClient } from './agent.js';
export { AgentSession } from './session.js';
export { MetricsCollector } from './metrics.js';
export { RetryOrchestrator } from './retry.js';
export { ErrorSummarizer } from './summarizer.js';
export type {
  Tool,
  ToolCall,
  ToolResultInput,
  ExecuteToolFn,
  OnTextFn,
  AgentClientOptions
} from './agent.js';
export type { SessionConfig } from './session.js';
export type { SessionMetrics, ComputedMetrics } from './metrics.js';
export type { SessionResult, VerificationError, VerificationResult, RetryConfig, RetryResult } from '../types.js';
