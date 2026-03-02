---
phase: 02-cli-orchestration
plan: 02
type: summary
subsystem: cli
tags: [cli, commander, orchestration, signal-handling, exit-codes]
requires: [02-01, 02-03]
provides: [cli-entry-point, run-command, argument-validation, session-orchestration]
affects: [phase-3-agent-tool-access]

tech-stack:
  added: [commander@14.0.3, picocolors@1.1.1]
  patterns: [commander-cli, signal-handlers, posix-exit-codes, session-lifecycle-orchestration]

key-files:
  created:
    - src/cli/index.ts
    - src/cli/commands/run.ts
    - bin/cli.js
  modified:
    - package.json

decisions:
  - id: commander-for-cli
    choice: Commander.js for argument parsing
    rationale: Industry standard (27.9k stars), automatic help generation, TypeScript support, validation
    alternatives: [Yargs, oclif, manual argv parsing]
  - id: picocolors-for-output
    choice: Picocolors for terminal colors
    rationale: Smallest/fastest (6.37 kB), simple API, sufficient for error styling
    alternatives: [Chalk, manual ANSI codes]
  - id: posix-exit-codes
    choice: Semantic exit codes (0/1/2/124/130/143)
    rationale: POSIX standard, enables shell scripting and CI/CD integration
    alternatives: [Always exit 0, boolean success/failure]
  - id: signal-handlers
    choice: process.once() for SIGINT/SIGTERM
    rationale: Graceful container cleanup, prevents orphaned containers
    alternatives: [No signal handling, process.on() with manual deduplication]

metrics:
  duration: 311 seconds (5.2 minutes)
  completed: 2026-02-06
  tasks: 2
  commits: 2
---

# Phase 02 Plan 02: CLI Entry Point & Orchestration Summary

**Commander.js CLI with session lifecycle orchestration, signal handling, and POSIX exit codes**

## What Was Built

This plan created the user-facing CLI interface that brings together all Phase 2 components (logger, metrics, session lifecycle) into a usable command-line tool. Two core capabilities were delivered:

1. **CLI Entry Point with Commander.js**
   - Commander.js argument parsing with required options (--task-type, --repo) and optional flags (--turn-limit, --timeout)
   - Argument validation with clear error messages and exit code 2 for invalid inputs
   - Help text automatically generated from option definitions
   - Version command (-V, --version) showing 0.1.0
   - Validates repository path exists before starting session
   - Validates turn-limit (1-100) and timeout (30-3600 seconds) ranges

2. **Run Command Orchestration**
   - Creates Pino logger with task context (taskType, repo)
   - Instantiates AgentSession with validated config (workspaceDir, turnLimit, timeoutMs)
   - Registers signal handlers for SIGINT (Ctrl+C) and SIGTERM for graceful cleanup
   - Runs session lifecycle: start() → run() → stop() (in finally block)
   - Records session metrics via MetricsCollector
   - Logs structured JSON with session result and metrics
   - Returns semantic exit codes based on outcome

3. **ESM Executable Entry Point**
   - bin/cli.js with shebang (#!/usr/bin/env node) for npm link/global install
   - Imports compiled dist/cli/index.js after build
   - Executable permissions set (chmod +x)
   - Package.json bin field points to ./bin/cli.js

## Task Commits

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Create CLI entry point with Commander.js and run command | e786b37 | src/cli/index.ts, src/cli/commands/run.ts, package.json |
| 2 | Create ESM executable entry point | dbbfa5d | bin/cli.js |

## Files Created/Modified

- `src/cli/index.ts` - Commander.js entry point with argument parsing and validation
- `src/cli/commands/run.ts` - Run command handler orchestrating AgentSession lifecycle
- `bin/cli.js` - ESM executable entry point with shebang
- `package.json` - Added bin field and start:cli script, added commander and picocolors dependencies

## Deviations from Plan

None - plan executed exactly as written.

## Decisions Made

**1. Commander.js for CLI Framework**
- **Decision:** Use Commander.js instead of manual argv parsing or alternatives
- **Rationale:** Research showed it's the industry standard with 27.9k stars, automatic help generation, TypeScript support, and built-in validation
- **Impact:** Clean argument parsing with minimal code, automatic --help generation, consistent error messages

**2. Picocolors for Terminal Output**
- **Decision:** Use Picocolors for colored error messages
- **Rationale:** Smallest (6.37 kB) and fastest color library, sufficient for simple error styling
- **Impact:** Red error messages for clarity, minimal bundle size overhead

**3. POSIX Exit Codes**
- **Decision:** Implement semantic exit codes (0=success, 1=failure, 2=invalid args, 124=timeout, 130=SIGINT, 143=SIGTERM)
- **Rationale:** Standard for CLI tools, enables shell scripting and CI/CD integration
- **Impact:** Scripts can detect specific failure modes, e.g., `if [ $? -eq 124 ]; then echo "timeout"; fi`

**4. Signal Handlers for Graceful Cleanup**
- **Decision:** Use process.once() to register SIGINT/SIGTERM handlers that call session.stop()
- **Rationale:** Prevents orphaned Docker containers when user Ctrl+C or system kills process
- **Impact:** Containers always cleaned up, even on interrupt; uses `once()` to prevent double cleanup

**5. Logger Injection Pattern**
- **Decision:** Create logger in run command, pass as parameter to session.run()
- **Rationale:** Enables child logger with task context, matches Plan 02-01 optional logger design
- **Impact:** All session logs automatically include taskType and repo fields for filtering

## Dependencies

**Required by this plan:**
- Plan 02-01 (Structured logging) - createLogger(), Logger type, session.run() logger parameter
- Plan 02-03 (Metrics) - MetricsCollector class, recordSession() method

**Enables future plans:**
- Phase 3 (Agent tool access) - CLI provides entry point to trigger agent runs with tool execution
- Phase 8/9 (Task implementations) - Users can run `background-agent -t maven-dependency-update -r /path`

## Technical Notes

### Exit Code Semantics

The CLI returns different exit codes based on outcome:

- **0**: Session completed successfully (status='success')
- **1**: General failure (status='failed' or 'turn_limit')
- **2**: Invalid arguments (turn-limit out of range, timeout out of range, repo path not found)
- **124**: Session timeout (status='timeout')
- **130**: SIGINT received (Ctrl+C)
- **143**: SIGTERM received (system kill)

This follows POSIX conventions and enables robust shell scripting:
```bash
background-agent -t test -r /repo
if [ $? -eq 124 ]; then
  echo "Session timed out, retrying with longer timeout..."
  background-agent -t test -r /repo --timeout 600
fi
```

### Signal Handler Implementation

Signal handlers use `process.once()` not `process.on()` to prevent double cleanup:
```typescript
process.once('SIGINT', async () => {
  childLogger.info('Received SIGINT, cleaning up...');
  await cleanup();
  process.exit(130);
});
```

The cleanup function checks a `cleanedUp` flag to prevent calling `session.stop()` multiple times.

### Prompt Construction

The CLI constructs a simple prompt from task type:
```typescript
const prompt = `You are a coding agent. Your task: ${options.taskType}. Work in the current directory.`;
```

This is intentionally basic for Phase 2. Phase 8/9 will enhance prompts with end-state format and task-specific context.

### Development vs Production Entry Points

Two ways to run the CLI:

**Development (no build step):**
```bash
npx tsx src/cli/index.ts -t test -r /path
# OR
npm run start:cli -- -t test -r /path
```

**Production (after build):**
```bash
npm run build
node bin/cli.js -t test -r /path
# OR (after npm link)
background-agent -t test -r /path
```

## Known Issues

None. All success criteria met.

## Next Phase Readiness

**Phase 3 can proceed:** This plan delivered the CLI entry point that triggers agent runs. Phase 3 will add tool implementations (Read, Edit, Git, Bash) that the agent can invoke.

**Blockers:** None

**Concerns:**
- Current prompt is basic ("Your task: {taskType}"). Phase 8/9 should enhance with end-state prompting per Spotify research.
- No repo validation beyond path existence - Phase 3 could add Git repo detection, .gitignore checks, etc.

## Success Criteria Verification

- [x] CLI parses and validates --task-type, --repo, --turn-limit, --timeout
- [x] Run command creates AgentSession with validated options
- [x] Signal handlers clean up Docker containers on SIGINT/SIGTERM
- [x] Session result logged as structured JSON with metrics
- [x] POSIX exit codes: 0 (success), 1 (failure), 2 (invalid args), 124 (timeout), 130 (SIGINT)
- [x] bin/cli.js works as ESM executable after build

**Verification commands:**
```bash
npx tsc --noEmit  # ✓ Full project compiles
npx tsx src/cli/index.ts --help  # ✓ Shows usage text
npx tsx src/cli/index.ts -t test -r . --turn-limit 0  # ✓ Exits code 2 (invalid)
npx tsx src/cli/index.ts  # ✓ Exits non-zero (missing args)
npm run build && node bin/cli.js --help  # ✓ Built executable works
```

## Self-Check: PASSED

All created files exist:
```bash
✓ src/cli/index.ts
✓ src/cli/commands/run.ts
✓ bin/cli.js
```

All commits exist:
```bash
✓ e786b37 (Task 1: CLI entry point and run command)
✓ dbbfa5d (Task 2: ESM executable entry point)
```
