import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const IMAGE_TAG = 'background-agent:latest';
const NETWORK_NAME = 'agent-net';

export async function assertDockerRunning(): Promise<void> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 5000 });
  } catch {
    throw new Error(
      'Docker is not running. Start Docker Desktop or the Docker daemon before running background-agent.'
    );
  }
}

export async function ensureNetworkExists(networkName: string = NETWORK_NAME): Promise<void> {
  try {
    await execFileAsync('docker', ['network', 'inspect', networkName], {});
  } catch {
    await execFileAsync('docker', ['network', 'create', networkName], {});
  }
}

export async function buildImageIfNeeded(imageTag: string = IMAGE_TAG): Promise<void> {
  try {
    await execFileAsync('docker', ['image', 'inspect', imageTag], {});
  } catch {
    // Resolve the docker/ directory relative to this source file
    const currentDir = nodePath.dirname(fileURLToPath(import.meta.url));
    const dockerDir = nodePath.resolve(currentDir, '../../../docker');
    await execFileAsync(
      'docker',
      ['build', '-t', imageTag, '-f', nodePath.join(dockerDir, 'Dockerfile'), dockerDir],
      {
        timeout: 600_000, // 10 min for image build
      }
    );
  }
}

export interface DockerRunOptions {
  workspaceDir: string;
  apiKey: string;
  sessionId: string;
  networkName?: string;
  imageTag?: string;
}

export function buildDockerRunArgs(
  opts: DockerRunOptions,
  sdkCommand: string,
  sdkArgs: string[],
): string[] {
  const containerName = `agent-${opts.sessionId}`;
  const networkName = opts.networkName ?? NETWORK_NAME;
  const imageTag = opts.imageTag ?? IMAGE_TAG;

  return [
    'run', '--rm', '--interactive',
    '--name', containerName,
    '--network', networkName,
    '--cap-drop', 'ALL',
    '--cap-add', 'NET_ADMIN',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '200',
    '--memory', '2g',
    '--read-only',
    '--tmpfs', '/tmp',
    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
    '-e', 'ANTHROPIC_API_KEY',  // inherit from parent env, not in ps args
    '-v', `${opts.workspaceDir}:/workspace:rw`,
    '--workdir', '/workspace',
    imageTag,
    sdkCommand,
    ...sdkArgs,
  ];
}
