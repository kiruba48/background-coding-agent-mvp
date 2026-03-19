import Conf from 'conf';

interface RegistrySchema {
  projects: Record<string, string>;  // name -> absolute path
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
    const projects = this.store.get('projects');
    projects[name] = repoPath;
    this.store.set('projects', projects);
  }

  resolve(name: string): string | undefined {
    return this.store.get('projects')[name];
  }

  has(name: string): boolean {
    return name in this.store.get('projects');
  }

  remove(name: string): boolean {
    const projects = this.store.get('projects');
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
