import Conf from 'conf';

interface RegistrySchema {
  projects: Record<string, string>;  // name -> absolute path
}

const VALID_NAME = /^[a-zA-Z0-9._-]+$/;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function validateName(name: string): void {
  if (!VALID_NAME.test(name) || RESERVED_NAMES.has(name)) {
    throw new Error(`Invalid project name: "${name}". Names must match ${VALID_NAME} and not be a reserved word.`);
  }
}

export class ProjectRegistry {
  private store: Conf<RegistrySchema>;

  constructor(options?: { cwd?: string }) {
    this.store = new Conf<RegistrySchema>({
      projectName: 'background-agent',
      defaults: { projects: {} },
      ...(options?.cwd ? { cwd: options.cwd } : {}),
    });
  }

  register(name: string, repoPath: string): void {
    validateName(name);
    const projects = { ...this.store.get('projects') };
    projects[name] = repoPath;
    this.store.set('projects', projects);
  }

  resolve(name: string): string | undefined {
    validateName(name);
    const projects = this.store.get('projects');
    // Exact match first
    if (name in projects) return projects[name];
    // Case-insensitive fallback
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(projects)) {
      if (key.toLowerCase() === lower) return value;
    }
    return undefined;
  }

  has(name: string): boolean {
    validateName(name);
    return name in this.store.get('projects');
  }

  remove(name: string): boolean {
    validateName(name);
    const projects = { ...this.store.get('projects') };
    if (!(name in projects)) return false;
    delete projects[name];
    this.store.set('projects', projects);
    return true;
  }

  list(): Record<string, string> {
    return { ...this.store.get('projects') };
  }

  /** Expose config file path (useful for debugging) */
  get configPath(): string {
    return this.store.path;
  }
}
