/**
 * Session metrics collection for tracking agent performance
 *
 * In-memory metrics tracking for session outcomes, turn counts, and durations.
 * Tracks merge rate, veto rate, failure rate, and averages.
 */

export type SessionStatus = 'success' | 'failed' | 'timeout' | 'turn_limit' | 'vetoed';

export interface SessionMetrics {
  totalSessions: number;
  successCount: number;
  failureCount: number;
  vetoCount: number;
  timeoutCount: number;
  turnLimitCount: number;
  totalTurns: number;
  totalDurationMs: number;
}

export interface ComputedMetrics extends SessionMetrics {
  mergeRate: number; // successCount / totalSessions (0-1)
  vetoRate: number; // vetoCount / totalSessions (0-1)
  failureRate: number; // failureCount / totalSessions (0-1)
  avgTurnsPerSession: number;
  avgDurationMs: number; // average session duration
}

/**
 * In-memory metrics collector for agent sessions
 *
 * Tracks session outcomes and computes rates. Intentionally simple with no
 * persistence - metrics are per-process for CLI logging. Persistence/export
 * can be added later if needed.
 */
export class MetricsCollector {
  private metrics: SessionMetrics;

  constructor() {
    this.metrics = {
      totalSessions: 0,
      successCount: 0,
      failureCount: 0,
      vetoCount: 0,
      timeoutCount: 0,
      turnLimitCount: 0,
      totalTurns: 0,
      totalDurationMs: 0,
    };
  }

  /**
   * Record a completed session
   *
   * @param status - Session outcome
   * @param toolCallCount - Number of tool calls executed in session
   * @param durationMs - Session duration in milliseconds
   */
  recordSession(status: SessionStatus, toolCallCount: number, durationMs: number): void {
    this.metrics.totalSessions++;
    this.metrics.totalTurns += toolCallCount;
    this.metrics.totalDurationMs += durationMs;

    switch (status) {
      case 'success':
        this.metrics.successCount++;
        break;
      case 'failed':
        this.metrics.failureCount++;
        break;
      case 'vetoed':
        this.metrics.vetoCount++;
        break;
      case 'timeout':
        this.metrics.timeoutCount++;
        break;
      case 'turn_limit':
        this.metrics.turnLimitCount++;
        break;
    }
  }

  /**
   * Get raw and computed metrics
   *
   * Computes rates and averages from recorded sessions:
   * - mergeRate: successCount / totalSessions
   * - vetoRate: vetoCount / totalSessions
   * - failureRate: failureCount / totalSessions
   * - avgTurnsPerSession: totalTurns / totalSessions
   * - avgDurationMs: totalDurationMs / totalSessions
   *
   * All computed values return 0 if no sessions recorded.
   */
  getMetrics(): ComputedMetrics {
    const { totalSessions } = this.metrics;

    return {
      ...this.metrics,
      mergeRate: totalSessions > 0 ? this.metrics.successCount / totalSessions : 0,
      vetoRate: totalSessions > 0 ? this.metrics.vetoCount / totalSessions : 0,
      failureRate: totalSessions > 0 ? this.metrics.failureCount / totalSessions : 0,
      avgTurnsPerSession: totalSessions > 0 ? this.metrics.totalTurns / totalSessions : 0,
      avgDurationMs: totalSessions > 0 ? this.metrics.totalDurationMs / totalSessions : 0,
    };
  }

  /**
   * Reset all metrics to zero
   *
   * Useful for testing and per-session isolation.
   */
  reset(): void {
    this.metrics = {
      totalSessions: 0,
      successCount: 0,
      failureCount: 0,
      vetoCount: 0,
      timeoutCount: 0,
      turnLimitCount: 0,
      totalTurns: 0,
      totalDurationMs: 0,
    };
  }
}
