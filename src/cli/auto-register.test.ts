import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { autoRegisterCwd } from './auto-register.js';
import { ProjectRegistry } from '../agent/registry.js';

/**
 * Helper: create a temp directory
 */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'auto-reg-test-'));
}

/**
 * Helper: clean up temp directory
 */
async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('autoRegisterCwd', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(tmpDir);
  });

  it('Test 1: registers directory basename when .git exists in cwd', async () => {
    // Create .git indicator
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });

    const registry = new ProjectRegistry({ cwd: tmpDir });
    await autoRegisterCwd(registry);

    const name = path.basename(tmpDir);
    expect(registry.resolve(name)).toBe(tmpDir);
  });

  it('Test 2: registers when package.json exists (no .git)', async () => {
    // Create package.json only
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');

    const registry = new ProjectRegistry({ cwd: tmpDir });
    await autoRegisterCwd(registry);

    const name = path.basename(tmpDir);
    expect(registry.resolve(name)).toBe(tmpDir);
  });

  it('Test 3: registers when pom.xml exists (no .git, no package.json)', async () => {
    // Create pom.xml only
    await fs.writeFile(path.join(tmpDir, 'pom.xml'), '<project/>');

    const registry = new ProjectRegistry({ cwd: tmpDir });
    await autoRegisterCwd(registry);

    const name = path.basename(tmpDir);
    expect(registry.resolve(name)).toBe(tmpDir);
  });

  it('Test 4: does nothing when no indicators exist', async () => {
    // No .git, package.json, or pom.xml

    const registry = new ProjectRegistry({ cwd: tmpDir });
    await autoRegisterCwd(registry);

    const name = path.basename(tmpDir);
    expect(registry.resolve(name)).toBeUndefined();
    expect(registry.list()).toEqual({});
  });

  it('Test 5: skips silently when name already registered to a different path', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });

    const registry = new ProjectRegistry({ cwd: tmpDir });
    const name = path.basename(tmpDir);

    // Pre-register to a different path
    const differentPath = '/some/other/path';
    registry.register(name, differentPath);

    await autoRegisterCwd(registry);

    // Should not have overwritten the different path
    expect(registry.resolve(name)).toBe(differentPath);
    // Should not have printed anything
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('Test 6: is a no-op when name already registered to same path (no console output)', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });

    const registry = new ProjectRegistry({ cwd: tmpDir });
    const name = path.basename(tmpDir);

    // Pre-register to same path
    registry.register(name, tmpDir);

    await autoRegisterCwd(registry);

    // Should still be same path
    expect(registry.resolve(name)).toBe(tmpDir);
    // Should not have printed anything (no double-notice)
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('Test 7: prints notice on first registration ("Registered project: name -> path")', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });

    const registry = new ProjectRegistry({ cwd: tmpDir });
    await autoRegisterCwd(registry);

    const name = path.basename(tmpDir);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Registered project: ${name}`)
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(tmpDir)
    );
  });

  it('Test 8: uses directory basename as name (e.g., /Users/kiruba/code/myapp -> myapp)', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });

    // Create a subdirectory called "myapp" and make it the cwd
    const myappDir = path.join(tmpDir, 'myapp');
    await fs.mkdir(myappDir, { recursive: true });
    await fs.mkdir(path.join(myappDir, '.git'), { recursive: true });

    cwdSpy.mockReturnValue(myappDir);

    // Use a separate registry storage dir to avoid conflicts
    const regDir = path.join(tmpDir, 'reg');
    await fs.mkdir(regDir, { recursive: true });
    const registry = new ProjectRegistry({ cwd: regDir });

    await autoRegisterCwd(registry);

    expect(registry.resolve('myapp')).toBe(myappDir);
  });
});
