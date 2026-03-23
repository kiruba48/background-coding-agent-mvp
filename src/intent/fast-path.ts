import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastPathResult } from './types.js';
import { readPackageJson, readPomDependencies } from './manifest-utils.js';

// Follow-up patterns: "also update X", "now do X", "same for X", "X too", "update X too", etc.
// dep character class prevents false positives: "also fix the login bug" won't match
// because "the" and spaces break the @?[a-z0-9\-._~/]+ character class
const FOLLOW_UP_PATTERNS = [
  /^(?:also\s+(?:update|upgrade|bump)|now\s+(?:do|update|upgrade|bump)|same\s+for|do\s+the\s+same\s+(?:for|with))\s+(?<dep>@?[a-z0-9\-._~/]+)\s*$/i,
  /^(?:update|upgrade|bump)\s+(?<dep>@?[a-z0-9\-._~/]+)\s+too\s*$/i,
  /^(?<dep>@?[a-z0-9\-._~/]+)\s+too\s*$/i,
];

// Stripping regexes for follow-up prefix/suffix removal in no-history fallback path.
// Exported so parseIntent (index.ts) uses the same source of truth as detection above.
export const FOLLOW_UP_PREFIX = /^(?:also\s+(?:update|upgrade|bump)\s+|now\s+(?:do|update|upgrade|bump)\s+|same\s+for\s+|do\s+the\s+same\s+(?:for|with)\s+)/i;
export const FOLLOW_UP_TOO_SUFFIX = /\s+too\s*$/i;

// Patterns: "update|upgrade|bump <dep> [to <version>] [in|for <project>]"
// Also matches reversed order: "update <dep> in <project> to <version>"
const DEPENDENCY_PATTERNS = [
  /^(?:update|upgrade|bump)\s+(?<dep>@?[a-z0-9\-._~/]+)(?:\s+to\s+(?<version>[a-zA-Z0-9._\-+]+))?(?:\s+(?:in|for)\s+(?<project>[a-zA-Z0-9._-]+))?$/i,
  /^(?:update|upgrade|bump)\s+(?<dep>@?[a-z0-9\-._~/]+)\s+(?:in|for)\s+(?<project>[a-zA-Z0-9._-]+)(?:\s+to\s+(?<version>[a-zA-Z0-9._\-+]+))?$/i,
];

// Matches trailing PR-creation phrases: "and create PR", "and raise a pull request", etc.
const PR_SUFFIX = /\s+(?:and\s+)?(?:create|raise|open|make)\s+(?:a\s+)?(?:pr|pull\s*request)\s*$/i;

// Verb guard: refactoring instructions must go through LLM classification,
// not be misclassified as dependency updates by DEPENDENCY_PATTERNS.
// Fires before PR suffix strip so "replace axios with fetch and create PR" is also blocked.
export const REFACTORING_VERB_GUARD = /^(?:replace|rename|move|extract|migrate|rewrite)\s/i;

export function fastPathParse(input: string): FastPathResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (REFACTORING_VERB_GUARD.test(trimmed)) return null;

  // Strip PR suffix before matching dependency patterns
  const createPr = PR_SUFFIX.test(trimmed);
  const cleaned = createPr ? trimmed.replace(PR_SUFFIX, '') : trimmed;

  // Check follow-up patterns before standard dependency patterns
  for (const pattern of FOLLOW_UP_PATTERNS) {
    const m = cleaned.match(pattern);
    if (m?.groups) {
      return {
        dep: m.groups.dep,
        version: 'latest',
        project: null,
        createPr,
        isFollowUp: true,
      };
    }
  }

  for (const pattern of DEPENDENCY_PATTERNS) {
    const m = cleaned.match(pattern);
    if (m?.groups) {
      return {
        dep: m.groups.dep,
        version: m.groups.version ?? 'latest',
        project: m.groups.project ?? null,
        createPr,
      };
    }
  }
  return null;
}

export async function validateDepInManifest(repoPath: string, dep: string): Promise<boolean> {
  // Try package.json
  const pkg = await readPackageJson(repoPath);
  if (pkg) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (dep in allDeps) return true;
  }

  // Try pom.xml
  const pomDeps = await readPomDependencies(repoPath);
  if (pomDeps) {
    const targetArtifact = dep.includes(':') ? dep.split(':')[1] : dep;
    if (pomDeps.some(d => d.artifactId === targetArtifact)) return true;
  }

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
