import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Read manifest dependencies from a project directory.
 * Returns a structured string for injection into LLM prompts.
 * Reads package.json and/or pom.xml — both if present.
 */
export async function readManifestDeps(repoPath: string): Promise<string> {
  const sections: string[] = [];

  // Try package.json
  try {
    const raw = await fs.readFile(path.join(repoPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    if (deps.length > 0) sections.push(`package.json dependencies: ${deps.join(', ')}`);
    if (devDeps.length > 0) sections.push(`package.json devDependencies: ${devDeps.join(', ')}`);
  } catch { /* no package.json */ }

  // Try pom.xml — scope to <dependency> blocks only (avoid project's own artifactId)
  try {
    const raw = await fs.readFile(path.join(repoPath, 'pom.xml'), 'utf-8');
    const depBlocks = [...raw.matchAll(/<dependency>[\s\S]*?<\/dependency>/g)];
    const artifacts = depBlocks.map(m => {
      const groupMatch = m[0].match(/<groupId>([^<]+)<\/groupId>/);
      const artMatch = m[0].match(/<artifactId>([^<]+)<\/artifactId>/);
      if (groupMatch && artMatch) return `${groupMatch[1]}:${artMatch[1]}`;
      if (artMatch) return artMatch[1];
      return '';
    }).filter(Boolean);
    if (artifacts.length > 0) sections.push(`pom.xml dependencies: ${artifacts.join(', ')}`);
  } catch { /* no pom.xml */ }

  return sections.length > 0 ? sections.join('\n') : 'No manifest found';
}
