import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastPathResult } from './types.js';

// Patterns: "update|upgrade|bump <dep> [to <version>] [in|for <project>]"
// Supports scoped packages (@scope/name) and dotted names
const DEPENDENCY_PATTERNS = [
  /^(?:update|upgrade|bump)\s+(?<dep>@?[a-z0-9\-._~/]+)(?:\s+to\s+(?<version>[a-zA-Z0-9._\-+]+))?(?:\s+(?:in|for)\s+(?<project>[a-zA-Z0-9._-]+))?$/i,
];

export function fastPathParse(input: string): FastPathResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  for (const pattern of DEPENDENCY_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m?.groups) {
      return {
        dep: m.groups.dep,
        version: m.groups.version ?? 'latest',
        project: m.groups.project ?? null,
      };
    }
  }
  return null;
}

export async function validateDepInManifest(repoPath: string, dep: string): Promise<boolean> {
  // Try package.json
  try {
    const raw = await fs.readFile(path.join(repoPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (dep in allDeps) return true;
  } catch { /* no package.json */ }

  // Try pom.xml
  try {
    const raw = await fs.readFile(path.join(repoPath, 'pom.xml'), 'utf-8');
    const depBlocks = [...raw.matchAll(/<dependency>[\s\S]*?<\/dependency>/g)];
    const artifactIds = depBlocks.map(m => {
      const match = m[0].match(/<artifactId>([^<]+)<\/artifactId>/);
      return match?.[1] ?? '';
    }).filter(Boolean);
    // For Maven, dep might be "groupId:artifactId" — check artifactId part
    const targetArtifact = dep.includes(':') ? dep.split(':')[1] : dep;
    if (artifactIds.includes(targetArtifact)) return true;
  } catch { /* no pom.xml */ }

  return false;
}

export async function detectTaskType(repoPath: string): Promise<'npm-dependency-update' | 'maven-dependency-update' | null> {
  let hasPackageJson = false;
  let hasPomXml = false;
  try { await fs.access(path.join(repoPath, 'package.json')); hasPackageJson = true; } catch { /* not found */ }
  try { await fs.access(path.join(repoPath, 'pom.xml')); hasPomXml = true; } catch { /* not found */ }

  if (hasPackageJson && !hasPomXml) return 'npm-dependency-update';
  if (hasPomXml && !hasPackageJson) return 'maven-dependency-update';
  return null; // both or neither — fall through to LLM
}
