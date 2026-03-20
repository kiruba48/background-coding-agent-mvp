import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ParsedPackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface PomDependency {
  groupId?: string;
  artifactId: string;
}

/** Read and parse package.json, returning structured deps. Returns null if file doesn't exist. */
export async function readPackageJson(repoPath: string): Promise<ParsedPackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(repoPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    };
  } catch {
    return null;
  }
}

/** Parse pom.xml dependency blocks. Returns null if file doesn't exist. */
export async function readPomDependencies(repoPath: string): Promise<PomDependency[] | null> {
  try {
    const raw = await fs.readFile(path.join(repoPath, 'pom.xml'), 'utf-8');
    return parsePomDependencyBlocks(raw);
  } catch {
    return null;
  }
}

/** Parse <dependency> blocks from pom.xml content string */
export function parsePomDependencyBlocks(xml: string): PomDependency[] {
  const depBlocks = [...xml.matchAll(/<dependency>[\s\S]*?<\/dependency>/g)];
  const results: PomDependency[] = [];
  for (const m of depBlocks) {
    const groupMatch = m[0].match(/<groupId>([^<]+)<\/groupId>/);
    const artMatch = m[0].match(/<artifactId>([^<]+)<\/artifactId>/);
    if (artMatch) {
      results.push({
        groupId: groupMatch?.[1],
        artifactId: artMatch[1],
      });
    }
  }
  return results;
}
