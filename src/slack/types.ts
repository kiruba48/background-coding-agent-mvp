import type { ReplState } from '../repl/types.js';
import type { ResolvedIntent } from '../intent/types.js';
import type { WebClient } from '@slack/web-api';

/** Per-thread session data stored in the module-level Map */
export interface ThreadSession {
  /** Slack user ID who initiated the task — used for authorization on button clicks */
  userId: string;
  /** Session lifecycle state — guards against race conditions (P5) */
  status: 'confirming' | 'running' | 'done';
  /** Creation timestamp for TTL eviction (P3) */
  createdAt: number;
  state: ReplState;
  abortController: AbortController;
  /** Pending confirmation: resolve with confirmed intent or null (cancel) */
  pendingConfirm?: {
    resolve: (intent: ResolvedIntent | null) => void;
  };
  /** Timestamp of the Block Kit confirmation message (for chat.update) */
  confirmationMessageTs?: string;
  /** The parsed intent awaiting confirmation */
  intent?: ResolvedIntent;
  /** Number of tasks completed in this thread (for summary on end) */
  taskCount: number;
  /** Last activity timestamp — reset on each new mention, used for TTL */
  lastActiveAt: number;
}

/** Context passed to adapter functions for Slack API calls */
export interface SlackContext {
  client: WebClient;
  channel: string;
  threadTs: string;
}
