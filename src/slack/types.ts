import type { ReplState } from '../repl/types.js';
import type { ResolvedIntent } from '../intent/types.js';
import type { WebClient } from '@slack/web-api';

/** Per-thread session data stored in the module-level Map */
export interface ThreadSession {
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
}

/** Context passed to adapter functions for Slack API calls */
export interface SlackContext {
  client: WebClient;
  channel: string;
  threadTs: string;
}
