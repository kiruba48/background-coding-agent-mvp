import type { ResolvedIntent } from '../intent/types.js';
import type { RetryResult } from '../types.js';

/** Mutable state for a REPL session. Owned by the CLI adapter, passed to session core. */
export interface ReplState {
  currentProject: string | null;   // resolved repo path from most recent task
  currentProjectName: string | null; // short name for prompt display
}

/** Callbacks the CLI adapter provides to the session core for I/O that requires process interaction. */
export interface SessionCallbacks {
  /** Display parsed intent and prompt user to confirm. Return confirmed intent or null if cancelled. */
  confirm: (intent: ResolvedIntent, reparse: (correction: string) => Promise<ResolvedIntent>) => Promise<ResolvedIntent | null>;
  /** Display clarification options and prompt user to pick one. Return selected intent string or null. */
  clarify: (clarifications: Array<{ label: string; intent: string }>) => Promise<string | null>;
  /** Get the AbortSignal for the current task. CLI adapter creates a fresh AbortController per task. */
  getSignal: () => AbortSignal;
}

/** Result of processing a single input line in the session core. */
export interface SessionOutput {
  action: 'continue' | 'quit';
  result?: RetryResult | null;  // null = user cancelled before run; undefined = quit
  intent?: ResolvedIntent;       // the resolved intent (for result block rendering)
}
