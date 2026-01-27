import Docker from 'dockerode';
import * as path from 'path';
import { Writable } from 'stream';
import { ContainerConfig, ToolResult } from '../types.js';

export class ContainerManager {
  private docker: Docker;
  private container: Docker.Container | null = null;
  private workspaceDir: string = '';

  constructor(socketPath = '/var/run/docker.sock') {
    this.docker = new Docker({ socketPath });
  }

  async create(config: ContainerConfig): Promise<void> {
    const absWorkspace = path.resolve(config.workspaceDir);
    this.workspaceDir = absWorkspace;

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
        Cmd: ['sh', '-c', 'sleep infinity'],
      });
      console.log('Container created:', this.container.id);
    } catch (error) {
      throw new Error(`Failed to create container: ${error}`);
    }
  }

  async start(): Promise<void> {
    if (!this.container) {
      throw new Error('Container not created. Call create() first.');
    }

    try {
      await this.container.start();
      console.log('Container started:', this.container.id);
    } catch (error) {
      throw new Error(`Failed to start container: ${error}`);
    }
  }

  async exec(command: string[]): Promise<ToolResult> {
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
        write(chunk: any, encoding: string, callback: () => void) {
          stdout += chunk.toString();
          callback();
        }
      });

      const stderrStream = new Writable({
        write(chunk: any, encoding: string, callback: () => void) {
          stderr += chunk.toString();
          callback();
        }
      });

      await new Promise<void>((resolve, reject) => {
        this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      const inspection = await exec.inspect();
      return {
        stdout,
        stderr,
        exitCode: inspection.ExitCode ?? 0,
      };
    } catch (error) {
      throw new Error(`Failed to execute command: ${error}`);
    }
  }

  async stop(timeoutSeconds: number = 10): Promise<void> {
    if (!this.container) {
      throw new Error('Container not created.');
    }

    try {
      await this.container.stop({ t: timeoutSeconds });
      console.log('Container stopped gracefully');
    } catch (error: any) {
      if (error.statusCode === 304) {
        console.log('Container already stopped');
      } else {
        console.warn('Failed to stop container gracefully, forcing kill:', error.message);
        try {
          await this.container.kill({ signal: 'SIGKILL' });
          console.log('Container killed forcefully');
        } catch (killError) {
          throw new Error(`Failed to kill container: ${killError}`);
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
      console.log('Container removed');
    } catch (error: any) {
      if (error.statusCode === 404) {
        console.log('Container already removed');
      } else {
        console.warn('Failed to remove container:', error.message);
      }
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    await this.remove();
  }
}
