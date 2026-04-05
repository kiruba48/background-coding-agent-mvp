import type { ResolvedIntent, TaskType } from '../intent/types.js';
import type { PRResult, RetryResult } from '../types.js';

/** A structured scope hint from the scoping dialogue. */
export interface ScopeHint {
  question: string;
  answer: string;
}

/** A single completed task entry stored in session history. */
export interface TaskHistoryEntry {
  taskType: TaskType;
  dep: string | null;
  version: string | null;
  repo: string;
  status: 'success' | 'failed' | 'cancelled' | 'zero_diff';
  description?: string;  // FLLW-01: human-readable task description for follow-up referencing
  finalResponse?: string; // FLLW-03: raw agent response for enriched history block
}

/** Maximum number of history entries to retain per session. */
export const MAX_HISTORY_ENTRIES = 10;

/** Map agent finalStatus to history entry status. Shared by REPL and Slack adapters. */
export function toHistoryStatus(finalStatus: RetryResult['finalStatus']): TaskHistoryEntry['status'] {
  switch (finalStatus) {
    case 'success':   return 'success';
    case 'zero_diff': return 'zero_diff';
    case 'cancelled': return 'cancelled';
    default:          return 'failed';
  }
}

/** Mutable state for a REPL session. Owned by the CLI adapter, passed to session core. */
export interface ReplState {
  currentProject: string | null;   // resolved repo path from most recent task
  currentProjectName: string | null; // short name for prompt display
  history: TaskHistoryEntry[];     // recent completed task entries for multi-turn context
  lastRetryResult?: RetryResult;   // FLLW-02: last successful run result (for post-hoc PR and follow-up)
  lastIntent?: ResolvedIntent;     // FLLW-02: last confirmed intent (for post-hoc PR and follow-up)
  lastWorktreeBranch?: string;     // WKTREE-05: worktree branch name for post-hoc PR branchOverride
}

/** Callbacks the CLI adapter provides to the session core for I/O that requires process interaction. */
export interface SessionCallbacks {
  /** Display parsed intent and prompt user to confirm. Return confirmed intent or null if cancelled. */
  confirm: (intent: ResolvedIntent, reparse: (correction: string) => Promise<ResolvedIntent>, scopeHints?: ScopeHint[]) => Promise<ResolvedIntent | null>;
  /** Display clarification options and prompt user to pick one. Return selected intent string or null. */
  clarify: (clarifications: Array<{ label: string; intent: string }>) => Promise<string | null>;
  /** Get the AbortSignal for the current task. CLI adapter creates a fresh AbortController per task. */
  getSignal: () => AbortSignal;
  /** Called when intent parsing begins. CLI adapter can show a spinner. */
  onParseStart?: () => void;
  /** Called when intent parsing finishes. CLI adapter can stop the spinner. */
  onParseEnd?: () => void;
  /** Called when the agent run begins (after confirmation). CLI adapter can start a progress indicator. */
  onAgentStart?: () => void;
  /** Called when the agent run finishes (success or failure). CLI adapter can stop the progress indicator. */
  onAgentEnd?: () => void;
  /** Ask one scoping question. Return null to skip (Enter or Ctrl+C). Optional — adapters omitting this bypass scoping. */
  askQuestion?: (prompt: string) => Promise<string | null>;
}

/** Result of processing a single input line in the session core. */
export interface SessionOutput {
  action: 'continue' | 'quit';
  result?: RetryResult | null;  // null = user cancelled before run; undefined = quit
  intent?: ResolvedIntent;       // the resolved intent (for result block rendering)
  prResult?: PRResult;           // post-hoc PR result (for Plan 02)
}
