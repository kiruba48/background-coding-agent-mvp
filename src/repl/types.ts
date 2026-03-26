import type { ResolvedIntent, TaskType } from '../intent/types.js';
import type { PRResult, RetryResult } from '../types.js';

/** A single completed task entry stored in session history. */
export interface TaskHistoryEntry {
  taskType: TaskType;
  dep: string | null;
  version: string | null;
  repo: string;
  status: 'success' | 'failed' | 'cancelled' | 'zero_diff';
  description?: string;  // FLLW-01: human-readable task description for follow-up referencing
}

/** Maximum number of history entries to retain per session. */
export const MAX_HISTORY_ENTRIES = 10;

/** Mutable state for a REPL session. Owned by the CLI adapter, passed to session core. */
export interface ReplState {
  currentProject: string | null;   // resolved repo path from most recent task
  currentProjectName: string | null; // short name for prompt display
  history: TaskHistoryEntry[];     // recent completed task entries for multi-turn context
  lastRetryResult?: RetryResult;   // FLLW-02: last successful run result (for post-hoc PR and follow-up)
  lastIntent?: ResolvedIntent;     // FLLW-02: last confirmed intent (for post-hoc PR and follow-up)
}

/** Callbacks the CLI adapter provides to the session core for I/O that requires process interaction. */
export interface SessionCallbacks {
  /** Display parsed intent and prompt user to confirm. Return confirmed intent or null if cancelled. */
  confirm: (intent: ResolvedIntent, reparse: (correction: string) => Promise<ResolvedIntent>) => Promise<ResolvedIntent | null>;
  /** Display clarification options and prompt user to pick one. Return selected intent string or null. */
  clarify: (clarifications: Array<{ label: string; intent: string }>) => Promise<string | null>;
  /** Get the AbortSignal for the current task. CLI adapter creates a fresh AbortController per task. */
  getSignal: () => AbortSignal;
  /** Called when the agent run begins (after confirmation). CLI adapter can start a progress indicator. */
  onAgentStart?: () => void;
  /** Called when the agent run finishes (success or failure). CLI adapter can stop the progress indicator. */
  onAgentEnd?: () => void;
}

/** Result of processing a single input line in the session core. */
export interface SessionOutput {
  action: 'continue' | 'quit';
  result?: RetryResult | null;  // null = user cancelled before run; undefined = quit
  intent?: ResolvedIntent;       // the resolved intent (for result block rendering)
  prResult?: PRResult;           // post-hoc PR result (for Plan 02)
}
