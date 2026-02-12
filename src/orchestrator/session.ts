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

// Allowed git flags for diff and commit operations
const ALLOWED_GIT_DIFF_FLAGS = new Set([
  '--cached', '--staged', '--stat', '--name-only', '--name-status',
  '--shortstat', '--numstat', '--no-color'
]);
const ALLOWED_GIT_COMMIT_FLAGS = new Set(['-m', '--message']);

// Verified paths in agent-sandbox Alpine 3.18 image
const COMMAND_PATHS: Record<string, string> = {
  'cat': '/bin/cat',
  'head': '/usr/bin/head',
  'tail': '/usr/bin/tail',
  'find': '/usr/bin/find',
  'wc': '/usr/bin/wc'
};

// Dangerous find flags that enable arbitrary execution or deletion
const BLOCKED_FIND_FLAGS = new Set([
  '-exec', '-execdir', '-delete', '-ok', '-okdir'
]);

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
    name: 'edit_file',
    description: 'Edit a file using string replacement, or create a new file',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['str_replace', 'create'],
          description: 'Edit command: str_replace to edit existing, create to make new file'
        },
        path: { type: 'string', description: 'File path relative to workspace' },
        old_str: { type: 'string', description: 'Exact text to replace (str_replace only)' },
        new_str: { type: 'string', description: 'New text to insert (str_replace only)' },
        content: { type: 'string', description: 'File content (create only)' }
      },
      required: ['command', 'path']
    }
  },
  {
    name: 'git_operation',
    description: 'Execute safe Git operations: status, diff, add, commit. Push is not allowed.',
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['status', 'diff', 'add', 'commit'],
          description: 'Git operation to perform'
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments for the operation (e.g., file paths for add, -m "message" for commit)'
        }
      },
      required: ['operation']
    }
  },
  {
    name: 'grep',
    description: 'Search for patterns in files using ripgrep',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex supported)' },
        path: { type: 'string', description: 'Path to search relative to workspace (default: workspace root)' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
        context_lines: { type: 'number', description: 'Lines of context around matches (default: 0)' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'bash_command',
    description: 'Run an allowlisted bash command. Allowed: cat, head, tail, find, wc. Use grep tool for searching.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['cat', 'head', 'tail', 'find', 'wc'],
          description: 'Command to run'
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments for the command'
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
 * 2. Session defines tools (read_file, edit_file, git_operation, grep, bash_command, list_files)
 * 3. Session calls AgentClient.runAgenticLoop with tool executor
 * 4. Tool executor routes to ContainerManager.exec or host execution (git_operation, edit_file)
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
   * Returns error string on failure instead of throwing.
   */
  private safeValidatePath(inputPath: string): { path: string } | { error: string } {
    if (inputPath.includes('\0')) {
      return { error: 'Null byte in path - access denied' };
    }

    const resolved = nodePath.resolve(this.workspaceDir, inputPath);

    if (!resolved.startsWith(this.workspaceDir + nodePath.sep) && resolved !== this.workspaceDir) {
      return { error: 'Path traversal detected - access denied' };
    }

    const relativePath = nodePath.relative(this.workspaceDir, resolved);

    if (relativePath.startsWith('.git/hooks') || relativePath.startsWith('.git\\hooks')) {
      return { error: 'Access to .git/hooks is denied' };
    }

    if (relativePath.includes('node_modules/.bin') || relativePath.includes('node_modules\\.bin')) {
      return { error: 'Access to node_modules/.bin is denied' };
    }

    return { path: resolved };
  }

  /**
   * Throwing version for backward compatibility (used in git_operation arg loops).
   */
  private validatePath(inputPath: string): string {
    const result = this.safeValidatePath(inputPath);
    if ('error' in result) {
      throw new Error(result.error);
    }
    return result.path;
  }

  /**
   * Route tool calls to the appropriate handler.
   */
  private async executeTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      case 'read_file': return this.handleReadFile(input);
      case 'edit_file': return this.handleEditFile(input);
      case 'git_operation': return this.handleGitOperation(input);
      case 'grep': return this.handleGrep(input);
      case 'bash_command': return this.handleBashCommand(input);
      case 'list_files': return this.handleListFiles(input);
      default: return `Unknown tool: ${name}`;
    }
  }

  private async handleReadFile(input: Record<string, unknown>): Promise<string> {
    if (typeof input.path !== 'string') {
      return 'Error: path must be a string';
    }

    const validated = this.safeValidatePath(input.path);
    if ('error' in validated) return `Error: ${validated.error}`;

    const result = await this.container.exec([COMMAND_PATHS['cat'], validated.path]);
    if (result.exitCode !== 0) {
      return `Error reading file: ${result.stderr}`;
    }
    return result.stdout;
  }

  private async handleEditFile(input: Record<string, unknown>): Promise<string> {
    if (typeof input.command !== 'string') {
      return 'Error: command must be a string';
    }
    if (typeof input.path !== 'string') {
      return 'Error: path must be a string';
    }

    const validated = this.safeValidatePath(input.path);
    if ('error' in validated) return `Error: ${validated.error}`;
    const safePath = validated.path;

    if (input.command === 'str_replace') {
      if (typeof input.old_str !== 'string') {
        return 'Error: old_str must be a string for str_replace';
      }
      if (typeof input.new_str !== 'string') {
        return 'Error: new_str must be a string for str_replace';
      }

      // Read file via container
      const readResult = await this.container.exec([COMMAND_PATHS['cat'], safePath]);
      if (readResult.exitCode !== 0) {
        return `Error reading file: ${readResult.stderr}`;
      }
      const content = readResult.stdout;
      const occurrences = content.split(input.old_str).length - 1;

      if (occurrences === 0) {
        return 'Error: old_str not found in file';
      }

      if (occurrences > 1) {
        // Find match positions using indexOf loop on FULL content (multi-line safe)
        let pos = 0;
        const matchPositions: number[] = [];
        while ((pos = content.indexOf(input.old_str, pos)) !== -1) {
          const lineNum = content.substring(0, pos).split('\n').length;
          matchPositions.push(lineNum);
          pos += input.old_str.length;
        }
        return `Error: old_str found ${occurrences} times at lines ${matchPositions.join(', ')}. Provide more context for unique match.`;
      }

      // Exactly 1 match - perform replacement
      const newContent = content.replace(input.old_str, input.new_str);

      try {
        await writeFileAtomic(safePath, newContent, { encoding: 'utf-8', mode: 0o644 });
        return 'File edited successfully';
      } catch (err: unknown) {
        return `Error writing file: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    } else if (input.command === 'create') {
      if (typeof input.content !== 'string') {
        return 'Error: content must be a string for create';
      }

      // Check if file already exists using fs.access
      try {
        await fs.access(safePath);
        return 'Error: File already exists. Use str_replace to edit existing files.';
      } catch (err: unknown) {
        // File doesn't exist (ENOENT) - proceed with creation
        const isNodeErr = err && typeof err === 'object' && 'code' in err;
        if (isNodeErr && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return `Error checking file existence: ${err instanceof Error ? err.message : 'Unknown error'}`;
        }
      }

      try {
        await writeFileAtomic(safePath, input.content, { encoding: 'utf-8', mode: 0o644 });
        return 'File created successfully';
      } catch (err: unknown) {
        return `Error creating file: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    } else {
      return `Error: Unknown edit command '${input.command}'. Use 'str_replace' or 'create'.`;
    }
  }

  private async handleGitOperation(input: Record<string, unknown>): Promise<string> {
    if (typeof input.operation !== 'string') {
      return 'Error: operation must be a string';
    }
    const operation = input.operation;
    const args = (Array.isArray(input.args) ? input.args as string[] : []);

    let command: string[];

    switch (operation) {
      case 'status':
        command = ['git', '-C', this.workspaceDir, 'status', '--porcelain'];
        break;

      case 'diff': {
        const diffArgs: string[] = [];
        for (const arg of args) {
          if (arg.startsWith('-')) {
            if (!ALLOWED_GIT_DIFF_FLAGS.has(arg)) {
              return `Error: Flag '${arg}' is not allowed for git diff. Allowed: ${[...ALLOWED_GIT_DIFF_FLAGS].join(', ')}`;
            }
            diffArgs.push(arg);
          } else {
            try {
              this.validatePath(arg);
              diffArgs.push(arg);
            } catch (e) {
              return `Error: ${e instanceof Error ? e.message : 'Invalid path'}`;
            }
          }
        }
        command = ['git', '-C', this.workspaceDir, 'diff', ...diffArgs];
        break;
      }

      case 'add': {
        const validatedPaths: string[] = [];
        for (const arg of args) {
          try {
            validatedPaths.push(this.validatePath(arg));
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : 'Invalid path'}`;
          }
        }
        if (validatedPaths.length === 0) {
          return 'Error: git add requires at least one file path';
        }
        command = ['git', '-C', this.workspaceDir, 'add', '--', ...validatedPaths];
        break;
      }

      case 'commit': {
        const commitArgs: string[] = ['--no-verify']; // ALWAYS prevent hook execution
        let i = 0;
        while (i < args.length) {
          const arg = args[i];
          if (arg === '-m' || arg === '--message') {
            if (i + 1 >= args.length) {
              return 'Error: -m flag requires a message argument';
            }
            commitArgs.push(arg, args[i + 1]);
            i += 2;
          } else if (arg.startsWith('-')) {
            return `Error: Flag '${arg}' is not allowed for git commit. Allowed: -m, --message`;
          } else {
            try {
              this.validatePath(arg);
              commitArgs.push(arg);
            } catch (e) {
              return `Error: ${e instanceof Error ? e.message : 'Invalid path'}`;
            }
            i++;
          }
        }
        command = ['git', '-C', this.workspaceDir, 'commit', ...commitArgs];
        break;
      }

      default:
        return `Error: Unknown git operation '${operation}'. Allowed: status, diff, add, commit`;
    }

    // Execute on HOST via execFileAsync (NOT container.exec)
    try {
      const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
        cwd: this.workspaceDir,
        timeout: 30000
      });
      const output = (stdout + stderr).trim();
      return output || (operation === 'status' ? '(no changes)' : operation === 'diff' ? '(no differences)' : 'Done');
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      if (execErr.stdout || execErr.stderr) {
        return `Error: ${(execErr.stderr || execErr.stdout || '').trim()}`;
      }
      return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
    }
  }

  private async handleGrep(input: Record<string, unknown>): Promise<string> {
    if (typeof input.pattern !== 'string') {
      return 'Error: pattern must be a string';
    }

    let searchPath = this.workspaceDir;
    if (input.path !== undefined) {
      if (typeof input.path !== 'string') {
        return 'Error: path must be a string';
      }
      const validated = this.safeValidatePath(input.path);
      if ('error' in validated) return `Error: ${validated.error}`;
      searchPath = validated.path;
    }

    const cmd = ['/usr/bin/rg', '--color', 'never', '--no-heading', '--with-filename', '--line-number'];

    if (input.case_insensitive === true) {
      cmd.push('-i');
    }

    // Cap context_lines at 50 to prevent OOM
    if (typeof input.context_lines === 'number' && input.context_lines > 0) {
      const contextLines = Math.min(input.context_lines, 50);
      cmd.push('-C', String(contextLines));
    }

    cmd.push('--', input.pattern, searchPath);

    const result = await this.container.exec(cmd);
    if (result.exitCode === 0) {
      return result.stdout;
    } else if (result.exitCode === 1) {
      return '(no matches found)';
    } else {
      return `Error: ${result.stderr}`;
    }
  }

  private async handleBashCommand(input: Record<string, unknown>): Promise<string> {
    if (typeof input.command !== 'string') {
      return 'Error: command must be a string';
    }

    const cmdName = input.command;
    const cmdArgs = (Array.isArray(input.args) ? input.args as string[] : []);

    const cmdPath = COMMAND_PATHS[cmdName];
    if (!cmdPath) {
      return 'Error: Command not allowed. Allowed commands: cat, head, tail, find, wc';
    }

    // Validate arguments: block dangerous flags for find, validate paths
    const validatedArgs: string[] = [];
    for (const arg of cmdArgs) {
      if (arg.startsWith('-')) {
        if (cmdName === 'find' && BLOCKED_FIND_FLAGS.has(arg)) {
          return `Error: Flag '${arg}' is not allowed for find. Blocked flags: ${[...BLOCKED_FIND_FLAGS].join(', ')}`;
        }
        validatedArgs.push(arg);
      } else {
        const validated = this.safeValidatePath(arg);
        if ('error' in validated) return `Error: ${validated.error}`;
        validatedArgs.push(validated.path);
      }
    }

    const result = await this.container.exec([cmdPath, ...validatedArgs], 30000);
    const output = result.stdout + result.stderr;
    return output || `(exit code: ${result.exitCode})`;
  }

  private async handleListFiles(input: Record<string, unknown>): Promise<string> {
    const inputPath = input.path;
    if (inputPath !== undefined && typeof inputPath !== 'string') {
      return 'Error: path must be a string';
    }

    const validated = this.safeValidatePath((inputPath as string) || '.');
    if ('error' in validated) return `Error: ${validated.error}`;

    const result = await this.container.exec(['/bin/ls', '-la', validated.path]);
    if (result.exitCode !== 0) {
      return `Error listing files: ${result.stderr}`;
    }
    return result.stdout;
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
