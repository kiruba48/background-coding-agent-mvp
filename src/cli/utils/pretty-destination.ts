import { Writable } from 'node:stream';
import pc from 'picocolors';

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}m${remaining}s`;
}

/**
 * Format cost in human-readable form
 */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Map a parsed pino JSON object to a human-readable line.
 * Returns null if the message should be suppressed.
 */
function formatMessage(obj: Record<string, unknown>): string | null {
  const level = obj.level as number;
  const msg = obj.msg as string;

  // Route by message key for known structured events
  switch (msg) {
    case 'Starting retry attempt': {
      const attempt = obj.attempt as number;
      const max = obj.maxRetries as number;
      return pc.cyan(`▸ Starting attempt ${attempt}/${max}`);
    }

    case 'mcp_server_registered': {
      const server = obj.server as string;
      const tools = obj.tools as string[];
      return pc.dim(`  MCP server: ${server} [${tools?.join(', ')}]`);
    }

    case 'file_changed': {
      const path = obj.path as string;
      const tool = obj.tool as string;
      if (!path) return null; // suppress if no path
      const shortPath = path.split('/').slice(-2).join('/');
      return pc.dim(`  ${tool}: ${shortPath}`);
    }

    case 'tool_blocked': {
      const reason = obj.reason as string;
      return pc.red(`✖ ${reason}`);
    }

    case 'sdk_session_cost': {
      const cost = obj.totalCostUsd as number;
      const turns = obj.numTurns as number;
      return pc.dim(`  Cost: ${formatCost(cost)} (${turns} turns)`);
    }

    case 'Verification passed':
      return pc.green(`✔ Verification passed`);

    case 'Verification failed, retrying with error context': {
      const attempt = obj.attempt as number;
      const max = obj.maxRetries as number;
      const errors = obj.errorCount as number;
      return pc.yellow(`✖ Verification failed (${errors} errors) — retrying ${attempt}/${max}`);
    }

    case 'Session failed, not retrying': {
      const status = obj.status as string;
      return pc.red(`✖ Session failed: ${status}`);
    }

    case 'LLM Judge result': {
      const verdict = obj.verdict as string;
      const duration = obj.durationMs as number;
      const durationStr = duration ? ` (${formatDuration(duration)})` : '';
      if (verdict === 'APPROVE') {
        return pc.green(`✔ Judge: APPROVE${durationStr}`);
      }
      const reason = obj.veto_reason as string;
      return pc.yellow(`✖ Judge: VETO${durationStr} — ${reason}`);
    }

    case 'Judge vetoed, retrying with veto feedback':
      return pc.yellow(`  Retrying with judge feedback...`);

    case 'Judge retry budget exhausted':
      return pc.red(`✖ Judge veto budget exhausted`);

    case 'Agent run completed': {
      const result = obj.retryResult as Record<string, unknown>;
      const metrics = obj.metrics as Record<string, unknown>;
      if (!result) break;

      const status = result.finalStatus as string;
      const attempts = result.attempts as number;
      const totalDuration = metrics?.totalDurationMs as number;
      const durationStr = totalDuration ? ` in ${formatDuration(totalDuration)}` : '';

      if (status === 'success') {
        return pc.green(pc.bold(`\n✔ Agent completed successfully (${attempts} attempt${attempts > 1 ? 's' : ''})${durationStr}`));
      }
      return pc.red(pc.bold(`\n✖ Agent finished: ${status} after ${attempts} attempt${attempts > 1 ? 's' : ''}${durationStr}`));
    }

    case 'Creating GitHub PR...':
      return pc.cyan(`▸ Creating GitHub PR...`);

    case 'GitHub PR created': {
      const url = obj.prUrl as string;
      return pc.green(`✔ PR created: ${url}`);
    }

    case 'PR already exists': {
      const url = obj.prUrl as string;
      return pc.green(`✔ Existing PR: ${url}`);
    }

    case 'PR creation failed': {
      const error = obj.error as string;
      return pc.yellow(`⚠ PR creation failed: ${error}`);
    }

    case 'ClaudeCodeSession failed': {
      return pc.red(`✖ Session error`);
    }

    case 'Pre-verify hook failed':
      return pc.red(`✖ Pre-verify hook failed`);

    case 'Verifier crashed':
      return pc.red(`✖ Verifier crashed`);

    case 'Judge crashed, failing open':
      return pc.yellow(`⚠ Judge crashed, failing open (approving)`);

    case 'Session timeout reached':
      return pc.yellow(`⚠ Session timeout reached`);
  }

  // Fallback: format remaining messages by level
  if (!msg) return null;

  // Known informational messages
  if (msg.includes('npm install completed')) return pc.green(`  ✔ npm install completed`);
  if (msg.includes('npm install') || msg.includes('regenerate lockfile')) return pc.cyan(`▸ ${msg}`);
  if (msg.includes('LLM Judge disabled')) return pc.dim(`  Judge disabled`);
  if (msg.includes('SIGINT') || msg.includes('SIGTERM')) return pc.yellow(`\n⚠ ${msg}`);

  // Generic fallback by level
  if (level >= 50) return pc.red(`✖ ${msg}`);       // error/fatal
  if (level >= 40) return pc.yellow(`⚠ ${msg}`);     // warn
  return pc.dim(`  ${msg}`);                          // info/debug
}

/**
 * A Writable stream that formats pino NDJSON into human-readable CLI output.
 * Used when stdout is a TTY for interactive use.
 */
export function createPrettyDestination(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const line = chunk.toString().trim();
      if (!line) {
        callback();
        return;
      }

      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const formatted = formatMessage(obj);
        if (formatted !== null) {
          process.stderr.write(formatted + '\n');
        }
      } catch {
        // Not JSON — pass through as-is
        process.stderr.write(line + '\n');
      }

      callback();
    },
  });
}
