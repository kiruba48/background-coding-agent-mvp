export interface ContainerConfig {
  image: string;
  workspaceDir: string;
  memoryMB?: number;
  cpuCount?: number;
  timeoutSeconds?: number;
}

export interface ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Result of an agent session execution
 */
export interface SessionResult {
  sessionId: string;
  status: 'success' | 'failed' | 'timeout' | 'turn_limit';
  toolCallCount: number;
  duration: number;      // milliseconds
  finalResponse: string; // Claude's final text response
  error?: string;        // Error message if failed
}

/**
 * A single verification error from a verifier (build, test, lint, judge, or custom).
 * Phase 5 verifiers will produce these; Phase 4 defines the interface.
 */
export interface VerificationError {
  type: 'build' | 'test' | 'lint' | 'judge' | 'custom';
  summary: string;       // LLM-digestible 1-line summary, max ~100 chars
  rawOutput?: string;    // Full output for logging only, NOT sent to LLM
}

/**
 * Result from running verification on a workspace after agent session.
 */
export interface VerificationResult {
  passed: boolean;
  errors: VerificationError[];
  durationMs: number;
}

/**
 * Result from the LLM judge evaluation of agent-produced changes.
 */
export interface JudgeResult {
  verdict: 'APPROVE' | 'VETO';
  reasoning: string;
  veto_reason: string;
  durationMs: number;
  skipped?: boolean;  // true if judge was bypassed due to API error
}

/**
 * Configuration for retry orchestration.
 */
export interface RetryConfig {
  maxRetries: number;  // default: 3
  verifier?: (workspaceDir: string) => Promise<VerificationResult>;
  judge?: (workspaceDir: string, originalTask: string) => Promise<JudgeResult>;
  maxJudgeVetoes?: number;  // default: 1, separate from maxRetries
}

/**
 * Result from a full retry-orchestrated run (may include multiple session attempts).
 */
export interface RetryResult {
  finalStatus: 'success' | 'failed' | 'timeout' | 'turn_limit' | 'max_retries_exhausted' | 'vetoed';
  attempts: number;           // 1-indexed, always >= 1
  sessionResults: SessionResult[];
  verificationResults: VerificationResult[];
  judgeResults?: JudgeResult[];  // all judge invocations for logging
  error?: string;
}
