# Phase 4: Retry & Context Engineering - Research

**Researched:** 2026-02-17
**Domain:** AI Agent Retry Orchestration, Error Summarization, Context Engineering for LLMs
**Confidence:** HIGH

## Summary

Phase 4 builds the infrastructure that allows the agent to recover from verification failures intelligently. The key insight from production systems (Spotify, Anthropic) is that there are **two distinct retry levels** that must not be conflated: (1) API-level retries for transient network/rate-limit errors (already implemented in `agent.ts`) and (2) session-level retries where a fresh agent session is started with error context when verification fails. Phase 4 is entirely about the outer, session-level retry loop.

The established architectural pattern in production coding agents is: run agent session → run verifiers → if failed, summarize errors → start new session with error context injected into the initial user message → repeat up to max retries. The Spotify engineering blog confirms this pattern with 10 turns per session and 3 total session retries. The key principle from Anthropic's context engineering guidance is that verifiers should use regex to extract only the most relevant error messages, returning a very short failure message instead of raw build/test output.

Error context is injected into the **initial user message** of the new session (not via system prompt) using a structured format: original task + prior attempt summary + actionable error digest. The new session starts clean (no conversation history) but with richer initial context. This avoids context window exhaustion from accumulated conversation history and keeps each attempt fresh while still being informed by prior failures.

**Primary recommendation:** Implement a `RetryOrchestrator` class that wraps `AgentSession` in an outer retry loop, with an `ErrorSummarizer` that transforms raw verification output into actionable LLM-digestible context. No external libraries needed — this is pure TypeScript orchestration logic on top of existing infrastructure.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EXEC-05 | Agent can retry on failure with error context (max 3 retries) | Outer retry loop pattern: `RetryOrchestrator` wraps `AgentSession`, passes summarized error context as initial message on each retry attempt |
| EXEC-06 | Verification errors are summarized, not dumped raw (context engineering) | Error summarization pattern: regex-based extraction of key errors, structured digest format ("3 tests failed in AuthModule"), capped at ~500 tokens |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| (none new required) | - | Retry orchestration | Pure TypeScript logic over existing `AgentSession` + `SessionResult` infrastructure |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new required) | - | Error summarization | String manipulation + regex on verification output — no library needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom retry orchestrator | `cockatiel` (retry library) | cockatiel handles API retries well but doesn't model the session-restart semantic; overkill for 3-retry outer loop |
| Custom retry orchestrator | `p-retry` npm | Same issue: designed for function-level retry, not session-orchestration retry with context injection |
| Custom error summarizer | Calling Claude to summarize errors | Too slow, too expensive, adds token cost per retry; regex extraction is sufficient for structured build/test output |

**Installation:**
```bash
# No new packages required
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── orchestrator/
│   ├── session.ts          # Existing: AgentSession (inner loop)
│   ├── agent.ts            # Existing: AgentClient (API retries)
│   ├── retry.ts            # NEW: RetryOrchestrator (outer loop)
│   ├── summarizer.ts       # NEW: ErrorSummarizer (error digest)
│   ├── container.ts        # Existing: ContainerManager
│   └── index.ts            # Export new classes
└── types.ts                # Extend SessionResult, add RetryResult
```

### Pattern 1: Outer Retry Loop (Session-Level Retry)
**What:** `RetryOrchestrator` wraps `AgentSession.run()` in a loop. When verification fails (Phase 5 will provide verifiers), it starts a NEW session with error context injected into the initial message.
**When to use:** Always for user-facing agent runs. The existing `AgentSession.run()` remains unchanged; `RetryOrchestrator` adds the outer loop.
**Why new session (not message injection into existing):** Prevents context window exhaustion from accumulated conversation history. Each retry has a fresh context window but receives the same original task + error digest as initial input. This is what Anthropic and Spotify use in production.

**Example:**
```typescript
// Source: Spotify Engineering blog pattern + Anthropic harness pattern
// src/orchestrator/retry.ts

export interface VerificationResult {
  passed: boolean;
  errors: VerificationError[];
}

export interface VerificationError {
  type: 'build' | 'test' | 'lint';
  summary: string;       // Actionable 1-line summary
  rawOutput?: string;    // Full output for logging only
}

export interface RetryConfig {
  maxRetries: number;          // default: 3
  verifier?: (workspaceDir: string) => Promise<VerificationResult>;
}

export interface RetryResult {
  finalStatus: 'success' | 'failed' | 'max_retries_exhausted' | 'timeout' | 'turn_limit';
  attempts: number;
  sessionResults: SessionResult[];
  verificationResults: VerificationResult[];
  error?: string;
}

export class RetryOrchestrator {
  private config: SessionConfig;
  private retryConfig: RetryConfig;

  constructor(sessionConfig: SessionConfig, retryConfig: RetryConfig = { maxRetries: 3 }) {
    this.config = sessionConfig;
    this.retryConfig = retryConfig;
  }

  async run(originalTask: string, logger?: pino.Logger): Promise<RetryResult> {
    const maxRetries = this.retryConfig.maxRetries ?? 3;
    const sessionResults: SessionResult[] = [];
    const verificationResults: VerificationResult[] = [];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Build message: original task + error context from prior attempts
      const message = this.buildRetryMessage(originalTask, attempt, verificationResults);

      // Start fresh session for this attempt
      const session = new AgentSession(this.config);
      await session.start();

      let sessionResult: SessionResult;
      try {
        sessionResult = await session.run(message, logger);
      } finally {
        await session.stop();
      }

      sessionResults.push(sessionResult);

      // If session itself failed (not verification), stop retrying
      if (sessionResult.status !== 'success') {
        return {
          finalStatus: sessionResult.status,
          attempts: attempt,
          sessionResults,
          verificationResults,
          error: sessionResult.error
        };
      }

      // Run verifier if provided (Phase 5 plugs in here)
      if (!this.retryConfig.verifier) {
        // No verifier configured — treat session success as overall success
        return { finalStatus: 'success', attempts: attempt, sessionResults, verificationResults };
      }

      const verification = await this.retryConfig.verifier(this.config.workspaceDir);
      verificationResults.push(verification);

      if (verification.passed) {
        return { finalStatus: 'success', attempts: attempt, sessionResults, verificationResults };
      }

      // Verification failed — loop continues with error context
      logger?.warn({ attempt, maxRetries, errors: verification.errors }, 'Verification failed, retrying');
    }

    // Exhausted all retries
    return {
      finalStatus: 'max_retries_exhausted',
      attempts: maxRetries,
      sessionResults,
      verificationResults,
      error: `Verification failed after ${maxRetries} attempts`
    };
  }

  private buildRetryMessage(
    originalTask: string,
    attempt: number,
    priorVerificationResults: VerificationResult[]
  ): string {
    if (attempt === 1 || priorVerificationResults.length === 0) {
      return originalTask;
    }

    // Summarize prior failures for context
    const errorDigest = ErrorSummarizer.buildDigest(priorVerificationResults);

    return [
      originalTask,
      '',
      `---`,
      `PREVIOUS ATTEMPT FAILED (attempt ${attempt - 1} of ${this.retryConfig.maxRetries}):`,
      errorDigest,
      `---`,
      `Please fix the issues listed above and try again.`
    ].join('\n');
  }
}
```

### Pattern 2: Error Summarizer
**What:** Transforms raw verification output (build logs, test output, lint reports) into LLM-digestible summaries. Uses regex extraction to pull key lines, not full dumps.
**When to use:** Always, before passing any verification failure back to agent.
**Why:** Spotify: "many of our verifiers use regular expressions to extract only the most relevant error messages." Raw test output can be 10,000+ tokens; a digest should be under 500.

**Example:**
```typescript
// Source: Spotify Engineering Part 3 pattern + Anthropic context engineering guidance
// src/orchestrator/summarizer.ts

export class ErrorSummarizer {
  /**
   * Summarize build errors from TypeScript/tsc/webpack output.
   * Input: raw compiler output (potentially thousands of lines)
   * Output: "3 TypeScript errors in AuthModule.ts"
   */
  static summarizeBuildErrors(rawOutput: string): string {
    // Extract TypeScript error lines: "file.ts(10,5): error TS2345: ..."
    const tsErrors = rawOutput.match(/\S+\.\w+\(\d+,\d+\): error TS\d+: .+/g) ?? [];
    if (tsErrors.length === 0) {
      // Fall back to extracting "error" lines
      const errorLines = rawOutput.split('\n').filter(l => /error/i.test(l)).slice(0, 5);
      return errorLines.length > 0
        ? `Build errors:\n${errorLines.join('\n')}`
        : 'Build failed (no specific errors extracted)';
    }

    const summary = tsErrors.slice(0, 5).join('\n');
    const more = tsErrors.length > 5 ? `\n...and ${tsErrors.length - 5} more errors` : '';
    return `${tsErrors.length} TypeScript error(s):\n${summary}${more}`;
  }

  /**
   * Summarize test failures from Jest/Mocha/Vitest output.
   * Input: raw test runner output
   * Output: "3 tests failed in AuthModule: testLogin, testLogout, testRefresh"
   */
  static summarizeTestFailures(rawOutput: string): string {
    // Jest FAIL lines: "  ● TestSuite > testName"
    const failLines = rawOutput.match(/[●✕✗]\s+.+/g) ?? [];
    // Jest summary: "Tests: 3 failed, 12 passed"
    const summaryLine = rawOutput.match(/Tests:\s+\d+ failed.+/)?.[0] ?? '';

    if (failLines.length === 0 && !summaryLine) {
      return 'Tests failed (unable to extract specific failures)';
    }

    const tests = failLines.slice(0, 5).join('\n');
    const more = failLines.length > 5 ? `\n...and ${failLines.length - 5} more failures` : '';
    return [summaryLine, tests, more].filter(Boolean).join('\n');
  }

  /**
   * Summarize lint errors from ESLint output.
   * Input: raw ESLint output
   * Output: "5 ESLint errors in 2 files"
   */
  static summarizeLintErrors(rawOutput: string): string {
    // ESLint format: "  3:10  error  no-unused-vars  x"
    const errorLines = rawOutput.match(/\d+:\d+\s+error\s+.+/g) ?? [];
    const fileCount = new Set(rawOutput.match(/\S+\.(?:ts|js|tsx|jsx)/g) ?? []).size;

    if (errorLines.length === 0) {
      return 'Lint failed (unable to extract specific errors)';
    }

    const sample = errorLines.slice(0, 5).join('\n');
    const more = errorLines.length > 5 ? `\n...and ${errorLines.length - 5} more` : '';
    return `${errorLines.length} lint error(s) in ${fileCount} file(s):\n${sample}${more}`;
  }

  /**
   * Build a complete error digest from all verification results.
   * Caps total output at ~500 tokens to protect context window.
   */
  static buildDigest(verificationResults: VerificationResult[]): string {
    const sections: string[] = [];

    for (const result of verificationResults) {
      if (result.passed) continue;
      for (const error of result.errors) {
        sections.push(`[${error.type.toUpperCase()}] ${error.summary}`);
      }
    }

    // Hard cap: take first 2000 chars to stay well under 500 tokens
    const joined = sections.join('\n\n');
    if (joined.length > 2000) {
      return joined.slice(0, 2000) + '\n...(truncated, showing first 2000 chars)';
    }
    return joined;
  }
}
```

### Pattern 3: Verification Interface (Forward-Compatible Design)
**What:** A stable interface that Phase 5 verifiers will implement, designed now so Phase 4 retry logic is verifier-agnostic.
**When to use:** Phase 4 defines the interface; Phase 5 implements it.
**Why forward-compatible:** Phase 4 needs to build the retry infrastructure NOW, but verification (Phase 5) isn't built yet. The `RetryOrchestrator` accepts a `verifier?: (workspaceDir: string) => Promise<VerificationResult>` callback. Without a verifier, it treats session success as overall success. With a verifier (Phase 5), it runs verification and may retry.

```typescript
// src/types.ts additions
export interface VerificationError {
  type: 'build' | 'test' | 'lint' | 'custom';
  summary: string;       // LLM-digestible 1-line summary, max ~100 chars
  rawOutput?: string;    // Full output for logging, NOT sent to LLM
}

export interface VerificationResult {
  passed: boolean;
  errors: VerificationError[];
  durationMs: number;
}

// Phase 4 adds to SessionResult:
export interface RetryResult {
  finalStatus: 'success' | 'failed' | 'timeout' | 'turn_limit' | 'max_retries_exhausted';
  attempts: number;            // 1-indexed, always >= 1
  sessionResults: SessionResult[];
  verificationResults: VerificationResult[];
  error?: string;
}
```

### Anti-Patterns to Avoid
- **Anti-pattern: Inject errors into existing conversation history.** Do NOT append error messages to the in-progress `AgentSession`. Start a new session. Old conversation history accumulates and fills the context window, causing the model to "forget" the original task.
- **Anti-pattern: Pass raw build/test output to agent.** Raw output can be 5,000-50,000 tokens. Always summarize to under 500 tokens using regex extraction.
- **Anti-pattern: Retry on session-level failures (timeout/turn_limit).** Only retry on verification failures. If the session itself times out or hits the turn limit, those are capacity/complexity problems that retry won't fix — terminate and report.
- **Anti-pattern: Unlimited retries.** Hard cap at 3 (Spotify's production-validated number). After 3 attempts, the task is likely beyond the agent's current capability.
- **Anti-pattern: System prompt injection for error context.** System prompt is for stable behavioral instructions, not per-attempt error context. Use the initial user message for error context — it's part of the task description.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| API-level retry (429, 529) | Custom retry loop in new code | Existing `AgentClient.sendMessage()` already does this | Already implemented with exponential backoff in Phase 1 |
| Session-level retry with backoff | Exponential backoff library | Simple counter loop — no delay needed | Verification retries are caused by code quality, not transient failures; delay adds no value |
| Error summarization via LLM | Calling Claude to summarize build output | Regex-based extraction | Calling Claude for summarization: (a) costs tokens, (b) adds latency, (c) can fail; regex on structured build output is deterministic and free |
| Retry state machine | State machine library (XState) | Simple counter + loop | 3 retries is not complex enough to justify a state machine library; adds dependency for no benefit |
| Context compression between retries | Full conversation summarization | Pass digest in initial message only | Full conversation compression loses nuance; passing only error digest to fresh session is simpler and works |
| Retry monitoring/observability | Custom metrics system | Extend existing `MetricsCollector` | Phase 2 already built MetricsCollector; add retry count and verification failure count to it |

**Key insight:** The retry orchestrator is 50-100 lines of clean TypeScript. Any external library adds more complexity than the problem requires. The error summarizer is regex + string operations. The "complex" part is getting the context engineering right (what to include in the retry message), not the code.

## Common Pitfalls

### Pitfall 1: Context Window Exhaustion on Retry
**What goes wrong:** Team appends verification errors to the existing conversation as new messages and continues the same `AgentSession`. After 3 retries, the conversation history is 50,000+ tokens. The model "forgets" the original task and starts hallucinating solutions.
**Why it happens:** Seems efficient to continue existing conversation. In practice, accumulated tool call history + error messages + assistant responses consume all available context.
**How to avoid:** Always start a fresh `AgentSession` for each retry. Pass only the original task + summarized error digest as the initial message. The prior conversation history is discarded.
**Warning signs:** Agent responses become confused, repetitive, or ignore the original task description. Context usage approaching max_tokens.

### Pitfall 2: Retrying Session-Level Failures
**What goes wrong:** Agent session times out (5 min) or hits turn limit (10 turns). Code retries it 3 times. Each retry also times out. Total runtime: 15+ minutes with no progress.
**Why it happens:** Treating all failures as retryable without classifying the failure type.
**How to avoid:** Only retry when verification fails (`SessionResult.status === 'success'` AND `VerificationResult.passed === false`). If `status === 'timeout'` or `'turn_limit'`, terminate immediately — these indicate the task is too complex for current settings.
**Warning signs:** All retry attempts have identical durations. Session logs show same error type on each attempt.

### Pitfall 3: Raw Output Flooding Agent Context
**What goes wrong:** Verifier runs `npm test` and passes the full 10,000-line output directly to the agent on retry. Agent receives a token-heavy wall of text. It either truncates it internally or wastes context window on irrelevant passing-test output.
**Why it happens:** "More information is better" intuition. In practice, agents need signal, not noise.
**How to avoid:** Error summarizer MUST extract only failure lines using regex. Target: under 500 tokens for error digest. Spotify's rule: "return a very short success message otherwise."
**Warning signs:** Initial retry message is longer than the original task message. Token count for initial message > 1000.

### Pitfall 4: Infinite Loop on Non-Deterministic Verification Failures
**What goes wrong:** Verification fails due to a flaky test (sometimes passes, sometimes fails). Agent retries 3 times. All 3 fail due to test flakiness, not agent error. Session terminates as `max_retries_exhausted` when the agent's code was actually correct.
**Why it happens:** Retry loop assumes verification failures are always agent-caused.
**How to avoid:** Phase 5 verifiers should distinguish flaky failures from consistent failures. For Phase 4, this is an open question — log the pattern. The hard max-retry cap (3) bounds the damage.
**Warning signs:** Verification failures vary between retries with no code changes. Error messages differ between attempts for the same file.

### Pitfall 5: Losing Original Task Intent on Retry
**What goes wrong:** Retry message only includes error context, not the original task. Agent focuses on fixing the specific errors rather than completing the original objective. It fixes the test failures by deleting the failing tests.
**Why it happens:** Error context is what changes between retries, so it feels like that's all that needs to be in the message.
**How to avoid:** ALWAYS include the complete original task description first, followed by the error context. The original task is the primary directive; error context is secondary information.
**Warning signs:** Agent comments out tests or weakens assertions to make tests pass. Agent deviates from original task scope.

### Pitfall 6: Retry Counter Reset on Process Restart
**What goes wrong:** Orchestrator process crashes after 2 retries. On restart, counter resets to 0. Agent gets unlimited effective retries despite configured max of 3.
**Why it happens:** Retry state is in memory only.
**How to avoid:** For Phase 4, this is acceptable — the system is not yet durable. Document the limitation. Phase 4 uses in-memory retry counter tied to single process lifecycle. Durable retry state (via filesystem or DB) is a v2 concern.
**Warning signs:** Session appears to run more than 3 times for a single user request.

## Code Examples

Verified patterns from research and official sources:

### Example 1: Retry Orchestrator Run Method
```typescript
// Source: Spotify Part 2/3 pattern + Anthropic harness pattern synthesis
// Key: fresh AgentSession per attempt, error context in initial message

async run(originalTask: string, logger?: pino.Logger): Promise<RetryResult> {
  const maxRetries = this.retryConfig.maxRetries ?? 3;
  const sessionResults: SessionResult[] = [];
  const verificationResults: VerificationResult[] = [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logger?.info({ attempt, maxRetries }, 'Starting retry attempt');

    // Build context-aware initial message
    const message = attempt === 1
      ? originalTask
      : this.buildRetryMessage(originalTask, attempt, verificationResults);

    // Fresh session per attempt - prevents context accumulation
    const session = new AgentSession(this.config);
    await session.start();

    let sessionResult: SessionResult;
    try {
      sessionResult = await session.run(message, logger);
    } finally {
      await session.stop(); // Always clean up container
    }

    sessionResults.push(sessionResult);

    // Session-level failures: don't retry (not a verification failure)
    if (sessionResult.status !== 'success') {
      logger?.error({ attempt, status: sessionResult.status }, 'Session failed, not retrying');
      return {
        finalStatus: sessionResult.status,
        attempts: attempt,
        sessionResults,
        verificationResults,
        error: sessionResult.error
      };
    }

    // No verifier: session success = overall success
    if (!this.retryConfig.verifier) {
      return { finalStatus: 'success', attempts: attempt, sessionResults, verificationResults };
    }

    // Run verification
    const verification = await this.retryConfig.verifier(this.config.workspaceDir);
    verificationResults.push(verification);

    if (verification.passed) {
      logger?.info({ attempt }, 'Verification passed');
      return { finalStatus: 'success', attempts: attempt, sessionResults, verificationResults };
    }

    logger?.warn({ attempt, errors: verification.errors.length }, 'Verification failed');
    // Loop: will retry with error context if attempt < maxRetries
  }

  return {
    finalStatus: 'max_retries_exhausted',
    attempts: maxRetries,
    sessionResults,
    verificationResults,
    error: `Verification still failing after ${maxRetries} attempts`
  };
}
```

### Example 2: Retry Message Construction
```typescript
// Source: Anthropic context engineering guidance + Spotify Part 2
// Key: original task first, error digest second, keep total < 1000 tokens

private buildRetryMessage(
  originalTask: string,
  attempt: number,
  priorResults: VerificationResult[]
): string {
  const failedResults = priorResults.filter(r => !r.passed);
  const errorDigest = ErrorSummarizer.buildDigest(failedResults);

  return [
    // 1. Original task ALWAYS comes first — primary directive
    originalTask,
    '',
    // 2. Structured error context — secondary information
    '---',
    `PREVIOUS ATTEMPT ${attempt - 1} FAILED VERIFICATION:`,
    errorDigest,
    '---',
    // 3. Clear instruction for retry
    'Fix the issues above and complete the original task.'
  ].join('\n');
}
```

### Example 3: Error Summarizer - Build Errors
```typescript
// Source: Spotify Part 3 regex extraction principle
// Key: extract only failure lines, never pass raw output to agent

static summarizeBuildErrors(rawOutput: string): string {
  // TypeScript: "src/foo.ts(10,5): error TS2345: Argument of type..."
  const tsErrors = rawOutput.match(/\S+\.\w+\(\d+,\d+\): error TS\d+: [^\n]+/g) ?? [];

  // Generic: lines containing "error" (fallback)
  const genericErrors = tsErrors.length === 0
    ? rawOutput.split('\n').filter(l => /\berror\b/i.test(l)).slice(0, 5)
    : [];

  const errors = tsErrors.length > 0 ? tsErrors : genericErrors;

  if (errors.length === 0) {
    return 'Build failed (no specific error lines found in output)';
  }

  const shown = errors.slice(0, 5);
  const remaining = errors.length - shown.length;
  const more = remaining > 0 ? `\n(+ ${remaining} more errors)` : '';

  return `${errors.length} build error(s):\n${shown.join('\n')}${more}`;
}
```

### Example 4: Error Summarizer - Test Failures
```typescript
// Source: Spotify Part 3 regex extraction principle
// Handles Jest, Mocha, Vitest output formats

static summarizeTestFailures(rawOutput: string): string {
  // Jest/Vitest failure lines: "  ● TestSuite > testName"
  const bulletFailures = rawOutput.match(/[●✕✗]\s+[^\n]+/g) ?? [];

  // Jest summary line: "Tests: 3 failed, 12 passed, 15 total"
  const summaryLine = rawOutput.match(/Tests:\s+\d+ failed[^\n]*/)?.[0] ?? '';

  // Mocha: "failing" section count
  const mochaCount = rawOutput.match(/(\d+) failing/)?.[0] ?? '';

  if (bulletFailures.length === 0 && !summaryLine && !mochaCount) {
    // Last resort: lines with "FAIL" or "✗"
    const failLines = rawOutput.split('\n').filter(l => /FAIL|FAILED|✗/.test(l)).slice(0, 5);
    return failLines.length > 0
      ? `Test failures:\n${failLines.join('\n')}`
      : 'Tests failed (unable to extract specific test names)';
  }

  const parts: string[] = [];
  if (summaryLine) parts.push(summaryLine);
  if (mochaCount) parts.push(mochaCount);

  const shownFailures = bulletFailures.slice(0, 5);
  if (shownFailures.length > 0) parts.push(shownFailures.join('\n'));

  const remaining = bulletFailures.length - shownFailures.length;
  if (remaining > 0) parts.push(`(+ ${remaining} more test failures)`);

  return parts.join('\n');
}
```

### Example 5: Extending MetricsCollector for Retry Tracking
```typescript
// Source: Pattern from Phase 2 MetricsCollector + research recommendation
// Key: track retry-specific metrics using existing infrastructure

// In metrics.ts — add to existing MetricsCollector:
recordRetryAttempt(attempt: number, reason: 'verification_failed' | 'session_failed'): void {
  this.retryCount++;
  this.lastRetryReason = reason;
  this.log.info({ attempt, reason }, 'Retry attempt recorded');
}

recordFinalOutcome(outcome: RetryResult['finalStatus'], totalAttempts: number): void {
  this.log.info({ outcome, totalAttempts }, 'Session final outcome');
  // Update existing metrics: success rate, attempt distribution
}
```

## State of the Art

| Old Approach | Current Approach (2026) | When Changed | Impact |
|--------------|-------------------------|--------------|--------|
| Inject errors into existing conversation | Start fresh session with error digest in initial message | 2025 (Anthropic harness pattern) | Prevents context exhaustion; each retry has full context window |
| Raw tool output passed to agent | Regex extraction of key error lines only | 2025 (Spotify production) | Agent receives signal not noise; protects context window |
| No distinction between retry types | API retry (transient) vs session retry (verification) are separate layers | 2025 (production agents) | Prevents conflation; each layer has appropriate strategy |
| Unlimited/high retry counts | Max 3 session retries hard cap | 2025 (Spotify: 10 turns, 3 retries) | Bounds cost and compute; fails fast on intractable tasks |
| External retry orchestration library | Hand-coded retry loop (10-20 lines) | Established | Retry logic this simple doesn't need a library |
| System prompt injection for error context | User message injection | 2025 (context engineering) | System prompt is for stable instructions; user message for task-specific context |

**Deprecated/outdated:**
- **Continuing existing conversation on failure**: Leads to context window exhaustion within 2-3 retries. Start fresh.
- **Passing raw stdout/stderr to agent**: 10,000+ token walls of text. Regex extract first.
- **Per-attempt exponential backoff for verification retries**: Verification failures are not transient; delay adds nothing.

## Open Questions

1. **How should RetryOrchestrator integrate with the CLI run command?**
   - What we know: Current `run.ts` calls `AgentSession.run()` directly
   - What's unclear: Should `RetryOrchestrator` replace `AgentSession` at the call site, or wrap it transparently?
   - Recommendation: Replace `AgentSession.run()` call in `run.ts` with `RetryOrchestrator.run()`. `RetryOrchestrator` is the public API; `AgentSession` becomes an implementation detail.

2. **Should `RetryResult` be returned from CLI or just `SessionResult` of the final attempt?**
   - What we know: CLI currently expects `SessionResult`
   - What's unclear: Does CLI need per-attempt details or just final outcome?
   - Recommendation: Return `RetryResult` from orchestrator; CLI maps it to exit codes. The CLI doesn't need per-attempt session details, but logging should capture all attempts.

3. **What happens to workspace state between retries?**
   - What we know: Workspace is a bind-mounted directory; container is recreated per session
   - What's unclear: If agent makes partial changes in attempt 1 and verification fails, does attempt 2 start from dirty workspace?
   - Recommendation: For Phase 4, YES — attempt 2 sees the workspace as left by attempt 1. This is intentional: the agent should build on prior progress. Phase 4 does NOT implement rollback (that's a v2 concern documented in REQUIREMENTS.md).

4. **Should error summarizer be synchronous or async?**
   - What we know: Summarization is string manipulation (no I/O needed)
   - What's unclear: If future summarization involves calling an LLM, it would be async
   - Recommendation: Keep synchronous for Phase 4. The value of regex-based summarization is that it's free and instant. If LLM summarization is ever needed, make it async at that point.

## Sources

### Primary (HIGH confidence)
- Anthropic Engineering: "Effective Context Engineering for AI Agents" (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — compaction patterns, tool result clearing, selective retention, context window management
- Anthropic Engineering: "Effective Harnesses for Long-Running Agents" (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — new-session-per-attempt architecture, artifact-based context passing, session restart pattern
- Spotify Engineering Part 2: "Context Engineering" (https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2) — 10 turns/session, 3 total retries, context window exhaustion patterns
- Spotify Engineering Part 3: "Feedback Loops" (https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3) — regex extraction for verifier output, short success messages, verifier abstraction hiding build system complexity

### Secondary (MEDIUM confidence)
- Inngest Blog: "Building Durable AI Agents" (https://www.inngest.com/blog/building-durable-agents) — workflow-level observability, step-based retry, max attempts per step
- GoCodeo: "Error Recovery and Fallback Strategies in AI Agent Development" (https://www.gocodeo.com/post/error-recovery-and-fallback-strategies-in-ai-agent-development) — checkpoint pattern, 3-attempt cap with exponential backoff
- arXiv / ZenML: Spotify verification loop article (https://www.zenml.io/llmops-database/building-reliable-background-coding-agents-with-verification-loops) — confirmation of Spotify's production retry numbers
- APXML: "Error Handling for LLM Agent Tools" (https://apxml.com/courses/building-advanced-llm-agent-tools/chapter-1-llm-agent-tooling-foundations/tool-error-handling) — LLM-specific error message formatting, concise over verbose, structured messages

### Tertiary (LOW confidence - for awareness)
- SparkCo: "Mastering Retry Logic Agents 2025" (https://sparkco.ai/blog/mastering-retry-logic-agents-a-deep-dive-into-2025-best-practices) — context-aware retry strategies, observability integration
- Agents Arcade: "Error Handling in Agentic Systems" (https://agentsarcade.com/blog/error-handling-agentic-systems-retries-rollbacks-graceful-failure) — state summarization, failure state lifecycle

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — No new libraries required; pure TypeScript over existing infrastructure
- Architecture (outer retry loop): HIGH — Directly confirmed by Spotify production (10 turns, 3 retries) and Anthropic harness pattern (new session per attempt)
- Architecture (error summarization): HIGH — Directly confirmed by Spotify Part 3 ("use regular expressions to extract only the most relevant error messages")
- Architecture (context injection pattern): HIGH — Anthropic context engineering article + harness article both confirm user-message injection over system-prompt injection
- Pitfalls: HIGH — All pitfalls derived from first-hand production reports (Spotify, Anthropic) or first-principles analysis of existing codebase
- Open questions: MEDIUM — Reasoned from existing architecture, not externally verified

**Research date:** 2026-02-17
**Valid until:** March 2026 (30 days) — retry patterns are stable; Anthropic/Spotify articles are current production guidance
**Re-validate:** If Anthropic releases new Agent SDK features that handle retry natively, or if Claude API adds multi-session retry support

**Coverage verification:**
- [x] Retry architecture (outer loop pattern) investigated
- [x] Error summarization techniques investigated
- [x] Context engineering for retry messages investigated
- [x] Common pitfalls catalogued
- [x] What NOT to hand-roll documented
- [x] Code examples provided
- [x] No new libraries required (verified)
- [x] Forward-compatible with Phase 5 verifiers (VerificationResult interface)
- [x] Integration with existing AgentSession, SessionResult, MetricsCollector
- [x] State of the art vs deprecated approaches documented

**Dependencies on prior phases:**
- Phase 1-3: `AgentSession`, `AgentClient`, `ContainerManager`, `SessionResult`, `SessionConfig`
- Phase 2: `MetricsCollector` (extend for retry tracking), `pino` logger (inject into retry orchestrator)
- Phase 3: Tool implementations (unchanged)

**Impact on future phases:**
- Phase 5: Implements `VerificationResult`-returning verifiers that plug into `RetryOrchestrator.retryConfig.verifier`
- Phase 6: LLM Judge can be another verifier in the same interface
- Phase 10: Plugin verifiers use the same `VerificationResult` interface
