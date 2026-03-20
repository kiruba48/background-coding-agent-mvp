import { readPackageJson, readPomDependencies } from './manifest-utils.js';

/**
 * Read manifest dependencies from a project directory.
 * Returns a structured string for injection into LLM prompts.
 * Reads package.json and/or pom.xml — both if present.
 */
export async function readManifestDeps(repoPath: string): Promise<string> {
  const sections: string[] = [];

  // Try package.json
  const pkg = await readPackageJson(repoPath);
  if (pkg) {
    const deps = Object.keys(pkg.dependencies);
    const devDeps = Object.keys(pkg.devDependencies);
    if (deps.length > 0) sections.push(`package.json dependencies: ${deps.join(', ')}`);
    if (devDeps.length > 0) sections.push(`package.json devDependencies: ${devDeps.join(', ')}`);
  }

  // Try pom.xml — scope to <dependency> blocks only (avoid project's own artifactId)
  const pomDeps = await readPomDependencies(repoPath);
  if (pomDeps && pomDeps.length > 0) {
    const artifacts = pomDeps.map(d =>
      d.groupId ? `${d.groupId}:${d.artifactId}` : d.artifactId
    );
    sections.push(`pom.xml dependencies: ${artifacts.join(', ')}`);
  }

  return sections.length > 0 ? sections.join('\n') : 'No manifest found';
}
