import * as nodePath from 'path';
import * as crypto from 'crypto';
import pino from 'pino';
import writeFileAtomic from 'write-file-atomic';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ContainerManager } from './container.js';
import { AgentClient, Tool } from './agent.js';
import { ContainerConfig, SessionResult } from '../types.js';
import { TurnLimitError } from '../errors.js';

const execFileAsync = promisify(execFile);

export interface SessionConfig {
  workspaceDir: string;
  image?: string;
  model?: string;
  turnLimit?: number;    // default: 10
  timeoutMs?: number;    // default: 300000 (5 minutes)
  logger?: pino.Logger;
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
  private workspaceDir: string = '';
  private started = false;
  private sessionId: string = '';

  constructor(config: SessionConfig) {
    this.config = config;
    this.container = new ContainerManager(undefined, config.logger);
    this.agent = new AgentClient({ model: config.model, logger: config.logger });
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
    // Resolve workspace to absolute path for path traversal checks
    this.workspaceDir = nodePath.resolve(this.config.workspaceDir);

    const containerConfig: ContainerConfig = {
      image: this.config.image ?? 'agent-sandbox:latest',
      workspaceDir: this.workspaceDir,
    };

    await this.container.create(containerConfig);
    await this.container.start();
    this.started = true;
  }

  /**
   * Execute the agentic loop with Claude
   *
   * @param userMessage - Initial instruction for Claude
   * @param logger - Optional Pino logger for structured logging
   * @returns SessionResult with status, toolCallCount (number of tool invocations), duration, and finalResponse
   * @throws Error if session not started
   */
  async run(userMessage: string, logger?: pino.Logger): Promise<SessionResult> {
    if (!this.started) {
      throw new Error('Session not started. Call start() first.');
    }

    // Create no-op logger if not provided
    const log = logger ?? pino({ level: 'silent' });

    // Generate session ID
    this.sessionId = crypto.randomUUID();

    // Log session created (pending state)
    log.info({ sessionId: this.sessionId, status: 'pending' }, 'Session created');

    const startTime = Date.now();
    let toolCallCount = 0;
    let finalResponse = '';
    let status: SessionResult['status'] = 'success';
    let error: string | undefined;

    // Set up timeout
    const turnLimit = this.config.turnLimit ?? 10;
    const timeoutMs = this.config.timeoutMs ?? 300000;

    const abortController = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;

    try {
      // Log session started (running state)
      log.info({ sessionId: this.sessionId, status: 'running' }, 'Session started');

      // Set timeout
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        log.warn({ sessionId: this.sessionId, toolCallCount }, 'Session timeout reached');
        abortController.abort();
      }, timeoutMs);

      // Run agentic loop with turn limit
      finalResponse = await this.agent.runAgenticLoop(
        userMessage,
        TOOLS,
        async (name, input) => {
          if (abortController.signal.aborted) {
            throw new Error('Session timeout');
          }
          toolCallCount++;
          return this.executeTool(name, input);
        },
        undefined,
        turnLimit
      );

      status = 'success';
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      error = errorMessage;

      // Determine failure reason using typed errors
      if (timedOut || err instanceof Error && err.message.includes('Session timeout')) {
        status = 'timeout';
        error = 'Session timeout';
        log.error({ sessionId: this.sessionId, err, toolCallCount }, 'Session timeout');
      } else if (err instanceof TurnLimitError) {
        status = 'turn_limit';
        error = 'Turn limit exceeded';
        log.error({ sessionId: this.sessionId, err, toolCallCount }, 'Turn limit exceeded');
      } else {
        status = 'failed';
        log.error({ sessionId: this.sessionId, err, toolCallCount }, 'Session failed');
      }
    } finally {
      // Clear timeout
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    const duration = Date.now() - startTime;

    // Log session completed
    log.info(
      { sessionId: this.sessionId, status, toolCallCount, duration },
      'Session completed'
    );

    return {
      sessionId: this.sessionId,
      status,
      toolCallCount,
      duration,
      finalResponse,
      error
    };
  }

  /**
   * Validate and resolve a path, ensuring it stays within the workspace.
   * Prevents path traversal attacks (e.g., ../../../etc/passwd).
   *
   * @param inputPath - User-provided path (relative or absolute)
   * @returns Resolved absolute path within workspace
   * @throws Error if path escapes workspace
   */
  private validatePath(inputPath: string): string {
    // Reject null bytes (often used in path injection attacks)
    if (inputPath.includes('\0')) {
      throw new Error('Null byte in path - access denied');
    }

    // Resolve path relative to workspace
    const resolved = nodePath.resolve(this.workspaceDir, inputPath);

    // Ensure resolved path is within workspace (prevent traversal)
    if (!resolved.startsWith(this.workspaceDir + nodePath.sep) && resolved !== this.workspaceDir) {
      throw new Error('Path traversal detected - access denied');
    }

    // Get relative path for additional checks
    const relativePath = nodePath.relative(this.workspaceDir, resolved);

    // Block .git/hooks access (prevents git hook privilege escalation)
    if (relativePath.startsWith('.git/hooks') || relativePath.startsWith('.git\\hooks')) {
      throw new Error('Access to .git/hooks is denied');
    }

    // Block node_modules/.bin access (prevents execution of npm scripts)
    if (relativePath.includes('node_modules/.bin') || relativePath.includes('node_modules\\.bin')) {
      throw new Error('Access to node_modules/.bin is denied');
    }

    return resolved;
  }

  /**
   * Execute a tool in the isolated container
   *
   * Routes tool calls to appropriate container commands:
   * - read_file: cat <path>
   * - execute_bash: bash -c "<command>" (Note: container isolation is primary defense)
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
        // Validate input type
        if (typeof input.path !== 'string') {
          return 'Error: path must be a string';
        }

        // Validate path stays within workspace
        let safePath: string;
        try {
          safePath = this.validatePath(input.path);
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : 'Invalid path'}`;
        }

        const result = await this.container.exec(['cat', safePath]);
        if (result.exitCode !== 0) {
          return `Error reading file: ${result.stderr}`;
        }
        return result.stdout;
      }

      case 'execute_bash': {
        // Validate input type
        if (typeof input.command !== 'string') {
          return 'Error: command must be a string';
        }

        // Note: Command injection is mitigated by container isolation (network: none,
        // read-only rootfs, non-root user, dropped capabilities). Phase 3 will add
        // command allowlisting for defense-in-depth.
        const result = await this.container.exec(['bash', '-c', input.command]);
        const output = result.stdout + result.stderr;
        return output || `(exit code: ${result.exitCode})`;
      }

      case 'list_files': {
        // Validate input type (path is optional, defaults to '.')
        const inputPath = input.path;
        if (inputPath !== undefined && typeof inputPath !== 'string') {
          return 'Error: path must be a string';
        }

        // Validate path stays within workspace
        let safePath: string;
        try {
          safePath = this.validatePath(inputPath || '.');
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : 'Invalid path'}`;
        }

        const result = await this.container.exec(['ls', '-la', safePath]);
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
