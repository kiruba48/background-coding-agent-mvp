import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectRegistry } from '../agent/registry.js';

const INDICATORS = ['.git', 'package.json', 'pom.xml'];

/**
 * Auto-register the current working directory as a project in the registry.
 *
 * Fires when cwd contains any project indicator (.git, package.json, pom.xml).
 * Uses the directory basename as the project short name.
 * Skips silently if name is already registered to a different path (no conflict resolution).
 * Prints a one-line notice on first registration.
 */
export async function autoRegisterCwd(registry: ProjectRegistry): Promise<void> {
  const cwd = process.cwd();
  const name = path.basename(cwd);

  // Check if any project indicator exists in cwd
  let hasIndicator = false;
  for (const indicator of INDICATORS) {
    try {
      await fs.access(path.join(cwd, indicator));
      hasIndicator = true;
      break;
    } catch {
      // indicator not found, try next
    }
  }
  if (!hasIndicator) return;

  // Already registered to same path — silent no-op
  const existing = registry.resolve(name);
  if (existing === cwd) return;

  // Name registered to different path — skip silently (no conflict resolution)
  if (existing !== undefined && existing !== cwd) return;

  // New registration
  registry.register(name, cwd);
  console.log(`Registered project: ${name} \u2192 ${cwd}`);
}
