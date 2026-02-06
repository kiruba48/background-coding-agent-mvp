import Docker from 'dockerode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Writable } from 'stream';
import pino from 'pino';
import { ContainerConfig, ToolResult } from '../types.js';

/**
 * Type guard for Docker API errors which have a statusCode property
 */
function isDockerError(error: unknown): error is { statusCode: number; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as Record<string, unknown>).statusCode === 'number'
  );
}

/**
 * Extract error message safely without exposing internal details
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

export class ContainerManager {
  private docker: Docker;
  private container: Docker.Container | null = null;
  private workspaceDir: string = '';
  private log: pino.Logger;

  constructor(socketPath = '/var/run/docker.sock', logger?: pino.Logger) {
    this.docker = new Docker({ socketPath });
    this.log = logger ?? pino({ level: 'silent' });
  }

  /**
   * Verify Docker daemon is running and accessible.
   * Call this before create() to provide a clear error message.
   *
   * @throws Error with actionable message if Docker is not available
   */
  async checkHealth(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (error) {
      throw new Error(
        'Docker daemon is not running or not accessible. ' +
        'Please ensure Docker is installed and running. ' +
        'Try: docker ps'
      );
    }
  }

  async create(config: ContainerConfig): Promise<void> {
    await this.checkHealth();
    const absWorkspace = path.resolve(config.workspaceDir);
    this.workspaceDir = absWorkspace;

    // Validate workspace directory exists
    try {
      await fs.access(absWorkspace);
    } catch {
      throw new Error(`Workspace directory does not exist: ${absWorkspace}`);
    }

    const image = config.image || 'agent-sandbox:latest';
    const memoryBytes = (config.memoryMB ?? 512) * 1024 * 1024;
    const nanoCpus = (config.cpuCount ?? 1) * 1e9;

    try {
      this.container = await this.docker.createContainer({
        Image: image,
        User: 'agent:agent',
        HostConfig: {
          NetworkMode: 'none',
          Memory: memoryBytes,
          NanoCpus: nanoCpus,
          PidsLimit: 100,
          ReadonlyRootfs: true,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=100m' },
          Binds: [`${absWorkspace}:${absWorkspace}:rw`],
          SecurityOpt: ['no-new-privileges:true'],
          CapDrop: ['ALL'],
        },
        WorkingDir: absWorkspace,
        Cmd: ['sleep', 'infinity'],
      });
      this.log.info({ containerId: this.container.id }, 'Container created');
    } catch (error) {
      throw new Error(`Failed to create container: ${getErrorMessage(error)}`);
    }
  }

  async start(): Promise<void> {
    if (!this.container) {
      throw new Error('Container not created. Call create() first.');
    }

    try {
      await this.container.start();
      this.log.info({ containerId: this.container.id }, 'Container started');
    } catch (error) {
      throw new Error(`Failed to start container: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Execute a command in the container with timeout protection
   *
   * @param command - Command and arguments to execute
   * @param timeoutMs - Maximum execution time in milliseconds (default: 30000)
   * @returns Tool result with stdout, stderr, and exit code
   */
  async exec(command: string[], timeoutMs: number = 30000): Promise<ToolResult> {
    if (!this.container) {
      throw new Error('Container not created. Call create() first.');
    }

    try {
      const exec = await this.container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: false });

      let stdout = '';
      let stderr = '';

      const stdoutStream = new Writable({
        write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void) {
          stdout += chunk.toString();
          callback();
        }
      });

      const stderrStream = new Writable({
        write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void) {
          stderr += chunk.toString();
          callback();
        }
      });

      // Create timeout promise for command execution
      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      // Race between command completion and timeout
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);
            stream.on('end', resolve);
            stream.on('error', reject);
          }),
          timeoutPromise
        ]);
      } finally {
        clearTimeout(timeoutId!);
      }

      const inspection = await exec.inspect();
      return {
        stdout,
        stderr,
        exitCode: inspection.ExitCode ?? 0,
      };
    } catch (error) {
      throw new Error(`Failed to execute command: ${getErrorMessage(error)}`);
    }
  }

  async stop(timeoutSeconds: number = 10): Promise<void> {
    if (!this.container) {
      throw new Error('Container not created.');
    }

    try {
      await this.container.stop({ t: timeoutSeconds });
      this.log.info('Container stopped gracefully');
    } catch (error: unknown) {
      if (isDockerError(error) && error.statusCode === 304) {
        this.log.info('Container already stopped');
      } else {
        this.log.warn({ err: getErrorMessage(error) }, 'Failed to stop container gracefully, forcing kill');
        try {
          await this.container.kill({ signal: 'SIGKILL' });
          this.log.info('Container killed forcefully');
        } catch (killError) {
          throw new Error(`Failed to kill container: ${getErrorMessage(killError)}`);
        }
      }
    }
  }

  async remove(): Promise<void> {
    if (!this.container) {
      throw new Error('Container not created.');
    }

    try {
      await this.container.remove({ force: true });
      this.log.info('Container removed');
    } catch (error: unknown) {
      if (isDockerError(error) && error.statusCode === 404) {
        this.log.info('Container already removed');
      } else {
        this.log.warn({ err: getErrorMessage(error) }, 'Failed to remove container');
      }
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    await this.remove();
  }
}
