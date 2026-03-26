import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readManifestDeps, readTopLevelDirs } from './context-scanner.js';

describe('readManifestDeps', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-scanner-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns "No manifest found" when no package.json or pom.xml exists', async () => {
    const result = await readManifestDeps(tmpDir);
    expect(result).toBe('No manifest found');
  });

  it('returns package.json dependencies when present', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { recharts: '^2.0.0', lodash: '^4.0.0' }, devDependencies: {} }),
    );
    const result = await readManifestDeps(tmpDir);
    expect(result).toContain('recharts');
    expect(result).toContain('lodash');
    expect(result).toContain('package.json dependencies');
  });

  it('returns package.json devDependencies when present', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: {}, devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0' } }),
    );
    const result = await readManifestDeps(tmpDir);
    expect(result).toContain('vitest');
    expect(result).toContain('typescript');
    expect(result).toContain('package.json devDependencies');
  });

  it('returns both dependencies and devDependencies sections when both present', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { recharts: '^2.0.0' },
        devDependencies: { vitest: '^1.0.0' },
      }),
    );
    const result = await readManifestDeps(tmpDir);
    expect(result).toContain('recharts');
    expect(result).toContain('vitest');
    expect(result).toContain('package.json dependencies');
    expect(result).toContain('package.json devDependencies');
  });

  it('returns pom.xml dependency artifactIds when present', async () => {
    const pomXml = `<?xml version="1.0"?>
<project>
  <artifactId>my-project</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>5.3.0</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
    </dependency>
  </dependencies>
</project>`;
    await fs.writeFile(path.join(tmpDir, 'pom.xml'), pomXml);
    const result = await readManifestDeps(tmpDir);
    expect(result).toContain('spring-core');
    expect(result).toContain('junit');
    expect(result).toContain('pom.xml dependencies');
  });

  it('does NOT include project artifactId in pom.xml results (only dependency blocks)', async () => {
    const pomXml = `<?xml version="1.0"?>
<project>
  <artifactId>my-own-project-name</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>5.3.0</version>
    </dependency>
  </dependencies>
</project>`;
    await fs.writeFile(path.join(tmpDir, 'pom.xml'), pomXml);
    const result = await readManifestDeps(tmpDir);
    // Should include spring-core but NOT my-own-project-name
    expect(result).toContain('spring-core');
    expect(result).not.toContain('my-own-project-name');
  });

  it('returns both package.json and pom.xml when both exist', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { recharts: '^2.0.0' }, devDependencies: {} }),
    );
    const pomXml = `<?xml version="1.0"?>
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>5.3.0</version>
    </dependency>
  </dependencies>
</project>`;
    await fs.writeFile(path.join(tmpDir, 'pom.xml'), pomXml);
    const result = await readManifestDeps(tmpDir);
    expect(result).toContain('recharts');
    expect(result).toContain('spring-core');
  });

  it('includes groupId:artifactId format in pom.xml output', async () => {
    const pomXml = `<?xml version="1.0"?>
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>5.3.0</version>
    </dependency>
  </dependencies>
</project>`;
    await fs.writeFile(path.join(tmpDir, 'pom.xml'), pomXml);
    const result = await readManifestDeps(tmpDir);
    // Should include groupId:artifactId format
    expect(result).toContain('org.springframework:spring-core');
  });
});

describe('readTopLevelDirs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readtopleveldirs-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns directory names from a tmp dir fixture', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.mkdir(path.join(tmpDir, 'tests'));
    await fs.mkdir(path.join(tmpDir, 'docs'));
    const result = await readTopLevelDirs(tmpDir);
    expect(result).toContain('src');
    expect(result).toContain('tests');
    expect(result).toContain('docs');
    expect(result).toContain('Top-level directories:');
  });

  it('returns empty string for nonexistent path', async () => {
    const result = await readTopLevelDirs('/nonexistent/path/that/does/not/exist');
    expect(result).toBe('');
  });

  it('excludes hidden directories (starting with .)', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.mkdir(path.join(tmpDir, '.git'));
    await fs.mkdir(path.join(tmpDir, '.hidden'));
    const result = await readTopLevelDirs(tmpDir);
    expect(result).toContain('src');
    expect(result).not.toContain('.git');
    expect(result).not.toContain('.hidden');
  });

  it('returns empty string when no non-hidden directories present', async () => {
    // Only create a file, no directories
    await fs.writeFile(path.join(tmpDir, 'readme.txt'), 'hello');
    const result = await readTopLevelDirs(tmpDir);
    expect(result).toBe('');
  });

  it('returns directories sorted alphabetically', async () => {
    await fs.mkdir(path.join(tmpDir, 'zebra'));
    await fs.mkdir(path.join(tmpDir, 'alpha'));
    await fs.mkdir(path.join(tmpDir, 'middle'));
    const result = await readTopLevelDirs(tmpDir);
    const dirsMatch = result.match(/Top-level directories: (.+)/);
    expect(dirsMatch).toBeTruthy();
    const dirs = dirsMatch![1].split(', ');
    expect(dirs).toEqual(['alpha', 'middle', 'zebra']);
  });
});
