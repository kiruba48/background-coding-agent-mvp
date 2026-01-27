import { ContainerManager } from './container.js';
import { AgentClient, Tool } from './agent.js';
import { ContainerConfig } from '../types.js';

export interface SessionConfig {
  workspaceDir: string;
  image?: string;
  apiKey?: string;
}

/**
 * Built-in tools available to Claude for workspace interaction
 */
const TOOLS: Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to file relative to workspace'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'execute_bash',
    description: 'Execute a bash command in the workspace',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Bash command to execute'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'list_files',
    description: 'List files in a directory',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to workspace (default: .)'
        }
      }
    }
  }
];

/**
 * AgentSession orchestrates the complete flow:
 * Claude -> tool request -> container exec -> tool result -> Claude
 *
 * Integration architecture:
 * 1. Session creates ContainerManager and AgentClient
 * 2. Session defines tools (read_file, execute_bash, list_files)
 * 3. Session calls AgentClient.runAgenticLoop with tool executor
 * 4. Tool executor routes to ContainerManager.exec
 * 5. Results flow back through the agentic loop
 * 6. Session cleans up container when done
 */
export class AgentSession {
  private container: ContainerManager;
  private agent: AgentClient;
  private config: SessionConfig;
  private started = false;

  constructor(config: SessionConfig) {
    this.config = config;
    this.container = new ContainerManager();
    this.agent = new AgentClient();
  }

  /**
   * Create and start the isolated container
   *
   * Container configuration:
   * - Network mode: none (no external network access)
   * - Read-only root filesystem
   * - Non-root user (agent)
   * - Workspace bind mount
   */
  async start(): Promise<void> {
    const containerConfig: ContainerConfig = {
      image: this.config.image ?? 'agent-sandbox:latest',
      workspaceDir: this.config.workspaceDir,
    };

    await this.container.create(containerConfig);
    await this.container.start();
    this.started = true;
  }

  /**
   * Execute the agentic loop with Claude
   *
   * @param userMessage - Initial instruction for Claude
   * @returns Final text response from Claude after completing task
   * @throws Error if session not started
   */
  async run(userMessage: string): Promise<string> {
    if (!this.started) {
      throw new Error('Session not started. Call start() first.');
    }

    return this.agent.runAgenticLoop(
      userMessage,
      TOOLS,
      async (name, input) => this.executeTool(name, input),
    );
  }

  /**
   * Execute a tool in the isolated container
   *
   * Routes tool calls to appropriate container commands:
   * - read_file: cat <path>
   * - execute_bash: bash -c "<command>"
   * - list_files: ls -la <path>
   *
   * @param name - Tool name
   * @param input - Tool input parameters
   * @returns Tool execution result (stdout, or stderr if failed)
   */
  private async executeTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      case 'read_file': {
        const path = input.path as string;
        const result = await this.container.exec(['cat', path]);
        if (result.exitCode !== 0) {
          return `Error reading file: ${result.stderr}`;
        }
        return result.stdout;
      }

      case 'execute_bash': {
        const command = input.command as string;
        const result = await this.container.exec(['bash', '-c', command]);
        const output = result.stdout + result.stderr;
        return output || `(exit code: ${result.exitCode})`;
      }

      case 'list_files': {
        const path = (input.path as string) || '.';
        const result = await this.container.exec(['ls', '-la', path]);
        if (result.exitCode !== 0) {
          return `Error listing files: ${result.stderr}`;
        }
        return result.stdout;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  /**
   * Stop and remove the container
   *
   * Ensures clean teardown even if errors occurred during execution.
   * Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (this.started) {
      await this.container.cleanup();
      this.started = false;
    }
  }
}
