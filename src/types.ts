export interface ContainerConfig {
  image: string;
  workspaceDir: string;
  memoryMB?: number;
  cpuCount?: number;
  timeoutSeconds?: number;
}

/**
 * Session state tracking for orchestrator (used in Phase 2 CLI)
 */
export interface SessionState {
  id: string;
  containerId: string;
  workspaceDir: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'vetoed';
  startedAt: Date;
  endedAt?: Date;
}

export interface ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
