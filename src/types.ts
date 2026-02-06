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
