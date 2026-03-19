import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProjectsCommand } from './projects.js';
import { ProjectRegistry } from '../../agent/registry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-agent-projects-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Helper: run a command with a fresh registry tied to tmpDir
async function runCommand(args: string[]): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdout.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderr.push(args.map(String).join(' '));
  });

  // Reset process.exitCode
  process.exitCode = undefined;

  // Build command with injected registry factory
  const cmd = createProjectsCommand({ registryFactory: () => new ProjectRegistry({ cwd: tmpDir }) });
  cmd.exitOverride(); // Prevent process.exit from throwing on Commander errors

  try {
    await cmd.parseAsync(['node', 'bg-agent', ...args]);
  } catch {
    // exitOverride throws on errors - ignore
  }

  logSpy.mockRestore();
  errSpy.mockRestore();

  return { stdout, stderr, exitCode: process.exitCode };
}

describe('projects list', () => {
  it('Test 1: with empty registry outputs "No projects registered"', async () => {
    const result = await runCommand(['list']);
    expect(result.stdout.join(' ')).toContain('No projects registered');
  });

  it('Test 2: with entries outputs name -> path', async () => {
    const registry = new ProjectRegistry({ cwd: tmpDir });
    registry.register('myapp', '/path/to/myapp');
    registry.register('other', '/path/to/other');
    const result = await runCommand(['list']);
    const output = result.stdout.join('\n');
    expect(output).toContain('myapp');
    expect(output).toContain('/path/to/myapp');
    expect(output).toContain('other');
  });
});

describe('projects add', () => {
  it('Test 3: registers the project when path exists', async () => {
    // Use tmpDir itself as a path that definitely exists
    const result = await runCommand(['add', 'myapp', tmpDir]);
    const output = result.stdout.join(' ');
    expect(output).toContain('myapp');
    // Verify actually registered
    const registry = new ProjectRegistry({ cwd: tmpDir });
    expect(registry.resolve('myapp')).toBe(path.resolve(tmpDir));
  });

  it('Test 4: with existing name in non-TTY mode errors with "already registered"', async () => {
    // Register first
    const registry = new ProjectRegistry({ cwd: tmpDir });
    registry.register('myapp', '/old/path');

    // Mock non-TTY
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const result = await runCommand(['add', 'myapp', tmpDir]);
    const errOutput = result.stderr.join(' ');
    expect(errOutput).toContain('already registered');
    expect(result.exitCode).toBe(1);

    // Restore
    if (isTTYDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', isTTYDescriptor);
    } else {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    }
  });

  it('Test 7: validates that the path exists (fs.access check)', async () => {
    const result = await runCommand(['add', 'myapp', '/nonexistent/path/that/does/not/exist']);
    const errOutput = result.stderr.join(' ');
    expect(errOutput).toContain('does not exist');
    expect(result.exitCode).toBe(1);
  });
});

describe('projects remove', () => {
  it('Test 5: removes the project and confirms', async () => {
    const registry = new ProjectRegistry({ cwd: tmpDir });
    registry.register('myapp', '/path/to/myapp');

    const result = await runCommand(['remove', 'myapp']);
    expect(result.stdout.join(' ')).toContain('myapp');
    // Verify actually removed
    const registry2 = new ProjectRegistry({ cwd: tmpDir });
    expect(registry2.has('myapp')).toBe(false);
  });

  it('Test 6: errors with "not found" for nonexistent project', async () => {
    const result = await runCommand(['remove', 'nonexistent']);
    const errOutput = result.stderr.join(' ');
    expect(errOutput).toContain('not found');
    expect(result.exitCode).toBe(1);
  });
});
