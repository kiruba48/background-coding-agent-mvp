export interface ContainerConfig {
  image: string;
  workspaceDir: string;
  memoryMB?: number;
  cpuCount?: number;
  timeoutSeconds?: number;
}

export interface AgentSession {
  id: string;
  containerId: string;
  workspaceDir: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  startedAt: Date;
  endedAt?: Date;
}

export interface ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
