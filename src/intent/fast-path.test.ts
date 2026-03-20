import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fastPathParse, validateDepInManifest, detectTaskType } from './fast-path.js';

describe('fastPathParse', () => {
  it('"update recharts" returns { dep: "recharts", version: "latest", project: null }', () => {
    const result = fastPathParse('update recharts');
    expect(result).toEqual({ dep: 'recharts', version: 'latest', project: null });
  });

  it('"upgrade lodash" returns { dep: "lodash", version: "latest", project: null }', () => {
    const result = fastPathParse('upgrade lodash');
    expect(result).toEqual({ dep: 'lodash', version: 'latest', project: null });
  });

  it('"bump @types/node" returns scoped package', () => {
    const result = fastPathParse('bump @types/node');
    expect(result).toEqual({ dep: '@types/node', version: 'latest', project: null });
  });

  it('"update recharts to 2.15.0" returns explicit version', () => {
    const result = fastPathParse('update recharts to 2.15.0');
    expect(result).toEqual({ dep: 'recharts', version: '2.15.0', project: null });
  });

  it('"update recharts in myapp" extracts project name', () => {
    const result = fastPathParse('update recharts in myapp');
    expect(result).toEqual({ dep: 'recharts', version: 'latest', project: 'myapp' });
  });

  it('"update recharts for myapp" extracts project name using "for" preposition', () => {
    const result = fastPathParse('update recharts for myapp');
    expect(result).toEqual({ dep: 'recharts', version: 'latest', project: 'myapp' });
  });

  it('"update recharts to 2.15.0 in myapp" returns version and project', () => {
    const result = fastPathParse('update recharts to 2.15.0 in myapp');
    expect(result).toEqual({ dep: 'recharts', version: '2.15.0', project: 'myapp' });
  });

  it('"something completely different" returns null', () => {
    expect(fastPathParse('something completely different')).toBeNull();
  });

  it('"fix the login bug" returns null', () => {
    expect(fastPathParse('fix the login bug')).toBeNull();
  });

  it('empty string returns null', () => {
    expect(fastPathParse('')).toBeNull();
  });

  it('handles uppercase input (case insensitive)', () => {
    const result = fastPathParse('UPDATE recharts');
    expect(result).toEqual({ dep: 'recharts', version: 'latest', project: null });
  });
});

describe('validateDepInManifest', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-path-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true when dep exists in package.json dependencies', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { recharts: '^2.0.0' }, devDependencies: {} }),
    );
    expect(await validateDepInManifest(tmpDir, 'recharts')).toBe(true);
  });

  it('returns true when dep exists in package.json devDependencies', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: {}, devDependencies: { vitest: '^1.0.0' } }),
    );
    expect(await validateDepInManifest(tmpDir, 'vitest')).toBe(true);
  });

  it('returns false when dep not in package.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.0.0' }, devDependencies: {} }),
    );
    expect(await validateDepInManifest(tmpDir, 'recharts')).toBe(false);
  });

  it('returns true when dep (artifactId) exists in pom.xml dependency blocks', async () => {
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
    expect(await validateDepInManifest(tmpDir, 'spring-core')).toBe(true);
  });

  it('returns false when dep not in pom.xml dependency blocks', async () => {
    const pomXml = `<?xml version="1.0"?>
<project>
  <artifactId>my-project</artifactId>
  <dependencies>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
    </dependency>
  </dependencies>
</project>`;
    await fs.writeFile(path.join(tmpDir, 'pom.xml'), pomXml);
    expect(await validateDepInManifest(tmpDir, 'spring-core')).toBe(false);
  });

  it('returns false when neither package.json nor pom.xml exists', async () => {
    expect(await validateDepInManifest(tmpDir, 'anything')).toBe(false);
  });

  it('supports groupId:artifactId format for maven deps', async () => {
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
    expect(await validateDepInManifest(tmpDir, 'org.springframework:spring-core')).toBe(true);
  });
});

describe('detectTaskType', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-task-type-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns "npm-dependency-update" when only package.json exists', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({}));
    expect(await detectTaskType(tmpDir)).toBe('npm-dependency-update');
  });

  it('returns "maven-dependency-update" when only pom.xml exists', async () => {
    await fs.writeFile(path.join(tmpDir, 'pom.xml'), '<project></project>');
    expect(await detectTaskType(tmpDir)).toBe('maven-dependency-update');
  });

  it('returns null when both package.json and pom.xml exist', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({}));
    await fs.writeFile(path.join(tmpDir, 'pom.xml'), '<project></project>');
    expect(await detectTaskType(tmpDir)).toBeNull();
  });

  it('returns null when neither file exists', async () => {
    expect(await detectTaskType(tmpDir)).toBeNull();
  });
});
