import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectRegistry } from './registry.js';

let tmpDir: string;
let registry: ProjectRegistry;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-agent-test-'));
  registry = new ProjectRegistry({ cwd: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ProjectRegistry', () => {
  it('Test 1: register(name, path) stores the mapping, resolve(name) returns the path', () => {
    registry.register('myapp', '/home/user/projects/myapp');
    expect(registry.resolve('myapp')).toBe('/home/user/projects/myapp');
  });

  it('Test 2: resolve(name) returns undefined for unregistered name', () => {
    expect(registry.resolve('nonexistent')).toBeUndefined();
  });

  it('Test 3: has(name) returns true for registered, false for unregistered', () => {
    registry.register('myapp', '/home/user/projects/myapp');
    expect(registry.has('myapp')).toBe(true);
    expect(registry.has('other')).toBe(false);
  });

  it('Test 4: remove(name) returns true and deletes entry for registered name', () => {
    registry.register('myapp', '/home/user/projects/myapp');
    const result = registry.remove('myapp');
    expect(result).toBe(true);
    expect(registry.resolve('myapp')).toBeUndefined();
  });

  it('Test 5: remove(name) returns false for unregistered name', () => {
    const result = registry.remove('nonexistent');
    expect(result).toBe(false);
  });

  it('Test 6: list() returns a copy of all registered projects (not a reference)', () => {
    registry.register('app1', '/path/to/app1');
    registry.register('app2', '/path/to/app2');
    const listed = registry.list();
    expect(listed).toEqual({ app1: '/path/to/app1', app2: '/path/to/app2' });
    // Modifying result should not affect registry
    listed['app3'] = '/path/to/app3';
    expect(registry.has('app3')).toBe(false);
  });

  it('Test 7: re-registering same name overwrites the path', () => {
    registry.register('myapp', '/old/path');
    registry.register('myapp', '/new/path');
    expect(registry.resolve('myapp')).toBe('/new/path');
    expect(Object.keys(registry.list())).toHaveLength(1);
  });

  it('Test 8: registry persists across instances (create registry, register, create new registry, resolve)', () => {
    registry.register('myapp', '/home/user/projects/myapp');
    // Create a new registry instance pointing to same cwd (same storage)
    const registry2 = new ProjectRegistry({ cwd: tmpDir });
    expect(registry2.resolve('myapp')).toBe('/home/user/projects/myapp');
  });

  it('Test 9: rejects __proto__ as project name', () => {
    expect(() => registry.register('__proto__', '/path')).toThrow('Invalid project name');
  });

  it('Test 10: rejects constructor as project name', () => {
    expect(() => registry.register('constructor', '/path')).toThrow('Invalid project name');
  });

  it('Test 11: rejects names with path separators', () => {
    expect(() => registry.register('../../etc', '/path')).toThrow('Invalid project name');
  });

  it('Test 12: rejects empty string as project name', () => {
    expect(() => registry.register('', '/path')).toThrow('Invalid project name');
  });

  it('Test 13: allows valid names with dots, hyphens, underscores', () => {
    registry.register('my-app_v2.0', '/path/to/app');
    expect(registry.resolve('my-app_v2.0')).toBe('/path/to/app');
  });
});
