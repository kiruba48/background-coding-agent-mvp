import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fastPathParse, validateDepInManifest, detectTaskType } from './fast-path.js';

describe('fastPathParse', () => {
  it('"update recharts" returns { dep: "recharts", version: "latest", project: null }', () => {
    const result = fastPathParse('update recharts');
    expect(result).toEqual({ dep: 'recharts', version: 'latest', project: null, createPr: false });
  });

  it('"upgrade lodash" returns { dep: "lodash", version: "latest", project: null }', () => {
    const result = fastPathParse('upgrade lodash');
    expect(result).toEqual({ dep: 'lodash', version: 'latest', project: null, createPr: false });
  });

  it('"bump @types/node" returns scoped package', () => {
    const result = fastPathParse('bump @types/node');
    expect(result).toEqual({ dep: '@types/node', version: 'latest', project: null, createPr: false });
  });

  it('"update recharts to 2.15.0" returns explicit version', () => {
    const result = fastPathParse('update recharts to 2.15.0');
    expect(result).toEqual({ dep: 'recharts', version: '2.15.0', project: null, createPr: false });
  });

  it('"update recharts in myapp" extracts project name', () => {
    const result = fastPathParse('update recharts in myapp');
    expect(result).toEqual({ dep: 'recharts', version: 'latest', project: 'myapp', createPr: false });
  });

  it('"update recharts for myapp" extracts project name using "for" preposition', () => {
    const result = fastPathParse('update recharts for myapp');
    expect(result).toEqual({ dep: 'recharts', version: 'latest', project: 'myapp', createPr: false });
  });

  it('"update recharts to 2.15.0 in myapp" returns version and project', () => {
    const result = fastPathParse('update recharts to 2.15.0 in myapp');
    expect(result).toEqual({ dep: 'recharts', version: '2.15.0', project: 'myapp', createPr: false });
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
    expect(result).toEqual({ dep: 'recharts', version: 'latest', project: null, createPr: false });
  });

  it('"update recharts in myapp to 2.15.0" matches reversed project-before-version order', () => {
    const result = fastPathParse('update recharts in myapp to 2.15.0');
    expect(result).toEqual({ dep: 'recharts', version: '2.15.0', project: 'myapp', createPr: false });
  });

  it('"update recharts for myapp to latest" matches reversed order with "for"', () => {
    const result = fastPathParse('update recharts for myapp to latest');
    expect(result).toEqual({ dep: 'recharts', version: 'latest', project: 'myapp', createPr: false });
  });

  it('"update lodash and create PR" sets createPr true', () => {
    const result = fastPathParse('update lodash and create PR');
    expect(result).toEqual({ dep: 'lodash', version: 'latest', project: null, createPr: true });
  });

  it('"update lodash in myapp and raise a pull request" sets createPr true', () => {
    const result = fastPathParse('update lodash in myapp and raise a pull request');
    expect(result).toEqual({ dep: 'lodash', version: 'latest', project: 'myapp', createPr: true });
  });

  it('"update lodash and open pr" sets createPr true (case insensitive)', () => {
    const result = fastPathParse('update lodash and open pr');
    expect(result).toEqual({ dep: 'lodash', version: 'latest', project: null, createPr: true });
  });

  it('"update lodash create PR" sets createPr true (no "and")', () => {
    const result = fastPathParse('update lodash create PR');
    expect(result).toEqual({ dep: 'lodash', version: 'latest', project: null, createPr: true });
  });
});

describe('follow-up patterns', () => {
  it('"also update lodash" returns isFollowUp: true, dep: "lodash"', () => {
    const result = fastPathParse('also update lodash');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBe(true);
    expect(result?.dep).toBe('lodash');
    expect(result?.version).toBe('latest');
    expect(result?.project).toBeNull();
    expect(result?.createPr).toBe(false);
  });

  it('"now do recharts" returns isFollowUp: true, dep: "recharts"', () => {
    const result = fastPathParse('now do recharts');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBe(true);
    expect(result?.dep).toBe('recharts');
  });

  it('"same for @types/node" returns isFollowUp: true, dep: "@types/node"', () => {
    const result = fastPathParse('same for @types/node');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBe(true);
    expect(result?.dep).toBe('@types/node');
  });

  it('"lodash too" returns isFollowUp: true, dep: "lodash"', () => {
    const result = fastPathParse('lodash too');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBe(true);
    expect(result?.dep).toBe('lodash');
  });

  it('"update lodash too" returns isFollowUp: true, dep: "lodash"', () => {
    const result = fastPathParse('update lodash too');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBe(true);
    expect(result?.dep).toBe('lodash');
  });

  it('"bump axios too" returns isFollowUp: true, dep: "axios"', () => {
    const result = fastPathParse('bump axios too');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBe(true);
    expect(result?.dep).toBe('axios');
  });

  it('"also fix the login bug" returns null (multi-word non-dep)', () => {
    expect(fastPathParse('also fix the login bug')).toBeNull();
  });

  it('"also update the config file" returns null ("the" breaks dep character class)', () => {
    expect(fastPathParse('also update the config file')).toBeNull();
  });

  it('"do the same for express" returns isFollowUp: true, dep: "express"', () => {
    const result = fastPathParse('do the same for express');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBe(true);
    expect(result?.dep).toBe('express');
  });

  it('"now bump @angular/core" returns isFollowUp: true, dep: "@angular/core"', () => {
    const result = fastPathParse('now bump @angular/core');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBe(true);
    expect(result?.dep).toBe('@angular/core');
  });

  it('standard "update recharts" does not set isFollowUp', () => {
    const result = fastPathParse('update recharts');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBeFalsy();
  });

  it('"also update lodash and create PR" sets isFollowUp: true, dep: "lodash", createPr: true', () => {
    const result = fastPathParse('also update lodash and create PR');
    expect(result).not.toBeNull();
    expect(result?.isFollowUp).toBe(true);
    expect(result?.dep).toBe('lodash');
    expect(result?.createPr).toBe(true);
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

describe('verb guard', () => {
  it('"replace axios with fetch" returns null (refactoring verb blocked)', () => {
    expect(fastPathParse('replace axios with fetch')).toBeNull();
  });

  it('"rename getUserData to fetchUserProfile" returns null', () => {
    expect(fastPathParse('rename getUserData to fetchUserProfile')).toBeNull();
  });

  it('"move utils to shared" returns null', () => {
    expect(fastPathParse('move utils to shared')).toBeNull();
  });

  it('"extract helper function" returns null', () => {
    expect(fastPathParse('extract helper function')).toBeNull();
  });

  it('"migrate from jest to vitest" returns null', () => {
    expect(fastPathParse('migrate from jest to vitest')).toBeNull();
  });

  it('"rewrite auth module" returns null', () => {
    expect(fastPathParse('rewrite auth module')).toBeNull();
  });

  it('"REPLACE axios with fetch" returns null (case insensitive)', () => {
    expect(fastPathParse('REPLACE axios with fetch')).toBeNull();
  });

  it('"replace axios with fetch and create PR" returns null (verb guard fires before PR suffix strip)', () => {
    expect(fastPathParse('replace axios with fetch and create PR')).toBeNull();
  });

  it('"update recharts" still returns a dep result (dep verbs NOT blocked)', () => {
    const result = fastPathParse('update recharts');
    expect(result).not.toBeNull();
    expect(result?.dep).toBe('recharts');
    expect(result?.version).toBe('latest');
  });

  it('"update axios" still returns dep result (not blocked even though "axios" is a dep name)', () => {
    const result = fastPathParse('update axios');
    expect(result).not.toBeNull();
    expect(result?.dep).toBe('axios');
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
