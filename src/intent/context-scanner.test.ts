import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readManifestDeps } from './context-scanner.js';

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
