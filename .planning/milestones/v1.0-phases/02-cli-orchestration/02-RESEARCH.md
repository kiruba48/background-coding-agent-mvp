# Phase 02: CLI & Orchestration - Research

**Researched:** 2026-02-06
**Domain:** Node.js CLI tools, Docker orchestration, structured logging, session lifecycle management
**Confidence:** HIGH

## Summary

This research investigates the standard stack and architecture patterns for building production-grade CLI tools with Docker container orchestration in Node.js/TypeScript. The domain is mature with well-established libraries and patterns.

**Key findings:**
- **Commander.js** is the de facto standard for CLI argument parsing (27.9k stars, first-class TypeScript support)
- **Pino** is the performance leader for structured JSON logging (5x faster than Winston, built for production)
- **Dockerode** provides the standard Node.js interface to Docker API (already in use in Phase 1)
- **Simple state tracking** with TypeScript enums/unions is recommended over state machine libraries for this scope
- **Exit codes and error handling** follow POSIX conventions with specific patterns for CLI tools

**Primary recommendation:** Use Commander.js for CLI, Pino for structured logging, and track session state with the existing SessionState interface. Avoid hand-rolling argument parsing, logging infrastructure, or timeout management.

## Standard Stack

The established libraries/tools for Node.js CLI + orchestration:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| commander | ^12.x | CLI argument parsing | 27.9k stars, complete solution for CLIs, TypeScript support, automatic help generation |
| pino | ^9.x | Structured JSON logging | 5x faster than alternatives, production-grade, worker thread support, zero overhead |
| dockerode | ^4.0.2 | Docker API client | Official Node.js Docker SDK, already in use (Phase 1), promise-based, entity management |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| picocolors | ^1.x | Terminal color output | Fastest/smallest (6.37 kB), CLI feedback and error styling |
| ora | ^8.x | Terminal spinners | Single progress indicator, user feedback during long operations |
| prom-client | ^15.x | Prometheus metrics | If metrics export needed (optional for Phase 2 scope) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Commander | Yargs | More features but heavier, declarative syntax vs imperative |
| Commander | oclif | Enterprise framework with plugins, overkill for single-command CLI |
| Pino | Winston | More transports/features but 5x slower, not optimized for JSON |
| Picocolors | Chalk | More features but 7x larger (44.2 kB vs 6.37 kB) |

**Installation:**
```bash
npm install commander pino picocolors ora
# Optional for metrics:
npm install prom-client
```

## Architecture Patterns

### Recommended Project Structure
```
background-coding-agent/
├── src/
│   ├── cli/
│   │   ├── index.ts              # CLI entry point (Commander config)
│   │   ├── commands/             # Command implementations
│   │   │   └── run.ts            # 'run' command handler
│   │   └── utils/
│   │       ├── logger.ts         # Pino logger setup
│   │       └── validation.ts     # Argument validation
│   ├── orchestrator/             # Existing from Phase 1
│   │   ├── container.ts          # ContainerManager
│   │   ├── agent.ts              # AgentClient
│   │   ├── session.ts            # AgentSession
│   │   └── index.ts
│   └── types.ts                  # Shared interfaces
├── bin/
│   └── cli.js                    # Executable entry (ESM shebang)
└── package.json
```

### Pattern 1: CLI Entry Point with Commander
**What:** Single-command CLI with options and validation
**When to use:** When building focused CLI tools (not multi-command suites)
**Example:**
```typescript
// src/cli/index.ts
// Source: https://github.com/tj/commander.js
import { Command } from 'commander';
import { createLogger } from './utils/logger.js';
import { runAgent } from './commands/run.js';

const program = new Command();
const logger = createLogger();

program
  .name('background-agent')
  .description('Run background coding agent in Docker sandbox')
  .version('1.0.0')
  .requiredOption('-t, --task-type <type>', 'Task type (e.g., test, refactor)')
  .requiredOption('-r, --repo <path>', 'Target repository path')
  .option('--turn-limit <number>', 'Maximum turns (default: 10)', '10')
  .option('--timeout <seconds>', 'Session timeout in seconds (default: 300)', '300')
  .action(async (options) => {
    try {
      await runAgent(options, logger);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Agent run failed');
      process.exit(1);
    }
  });

program.parse();
```

### Pattern 2: Structured JSON Logging with Pino
**What:** Production-grade logging with child loggers for context
**When to use:** Always - structured logs enable debugging and observability
**Example:**
```typescript
// src/cli/utils/logger.ts
// Source: https://github.com/pinojs/pino
import pino from 'pino';

export function createLogger() {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  });
}

// Usage in session:
const sessionLogger = logger.child({
  sessionId: session.id,
  containerId: session.containerId
});

sessionLogger.info({ taskType: 'test', repo: '/path' }, 'Starting agent session');
sessionLogger.error({ err, turnCount: 5 }, 'Session failed');
```

### Pattern 3: Session Lifecycle Management
**What:** State tracking with existing SessionState interface
**When to use:** Managing Docker container + agent sessions with safety limits
**Example:**
```typescript
// src/cli/commands/run.ts
import { AgentSession } from '../../orchestrator/session.js';

interface RunOptions {
  taskType: string;
  repo: string;
  turnLimit: string;
  timeout: string;
}

export async function runAgent(options: RunOptions, logger: any) {
  const turnLimit = parseInt(options.turnLimit, 10);
  const timeout = parseInt(options.timeout, 10) * 1000; // convert to ms

  const session = new AgentSession({
    workspaceDir: options.repo,
    turnLimit,
    timeout
  });

  // State: pending -> running
  logger.info({ state: 'pending' }, 'Creating session');

  try {
    await session.start();
    logger.info({ state: 'running' }, 'Session started');

    const result = await session.run(options.taskType);

    // State: running -> success/failed/vetoed
    logger.info({
      state: result.state,
      turns: result.turnCount,
      duration: result.duration
    }, 'Session completed');

  } finally {
    await session.cleanup();
  }
}
```

### Pattern 4: Timeout and Turn Limit Enforcement
**What:** Safety limits with clear error handling
**When to use:** Preventing runaway agent sessions
**Example:**
```typescript
// In AgentSession.run() method
async run(taskType: string): Promise<SessionResult> {
  const startTime = Date.now();
  let turnCount = 0;

  // Timeout enforcement
  const timeoutHandle = setTimeout(() => {
    this.logger.warn({ turnCount }, 'Session timeout reached');
    throw new Error('SESSION_TIMEOUT');
  }, this.config.timeout);

  try {
    while (!this.isComplete()) {
      // Turn limit enforcement
      if (turnCount >= this.config.turnLimit) {
        this.logger.warn('Turn limit reached');
        throw new Error('TURN_LIMIT_EXCEEDED');
      }

      await this.executeTurn();
      turnCount++;
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  return {
    state: this.state.status,
    turnCount,
    duration: Date.now() - startTime
  };
}
```

### Pattern 5: CLI Exit Codes (POSIX Standard)
**What:** Semantic exit codes for shell scripting and CI/CD
**When to use:** Always - enables proper error handling in scripts
**Example:**
```typescript
// Source: https://github.com/lirantal/nodejs-cli-apps-best-practices
// Standard exit codes:
// 0   - Success
// 1   - General error (catch-all)
// 2   - Misuse of shell command (invalid arguments)
// 124 - Timeout
// 130 - Terminated by Ctrl+C (SIGINT)

try {
  await runAgent(options, logger);
  process.exit(0);
} catch (error) {
  if (error.message === 'SESSION_TIMEOUT') {
    logger.error('Session exceeded timeout limit');
    process.exit(124);
  } else if (error.message === 'TURN_LIMIT_EXCEEDED') {
    logger.error('Session exceeded turn limit');
    process.exit(1);
  } else if (error.message === 'INVALID_ARGUMENTS') {
    logger.error('Invalid command arguments');
    process.exit(2);
  } else {
    logger.error({ err: error }, 'Unexpected error');
    process.exit(1);
  }
}
```

### Pattern 6: ESM Executable Configuration
**What:** Package.json bin field with ESM entry point
**When to use:** Making CLI globally installable via npm
**Example:**
```json
// package.json
{
  "name": "background-coding-agent",
  "type": "module",
  "bin": {
    "background-agent": "./bin/cli.js"
  }
}
```

```javascript
// bin/cli.js
#!/usr/bin/env node
// Shebang required for executable
import '../dist/cli/index.js';
```

### Anti-Patterns to Avoid
- **Manual process.argv parsing:** Fragile, no validation, no help text - use Commander
- **console.log for logging:** Not structured, no levels, can't disable - use Pino
- **Ignoring exit codes:** Breaks CI/CD and shell scripts - always exit with semantic codes
- **No timeout enforcement:** Can run forever, waste resources - implement abort mechanisms
- **Synchronous operations in CLI:** Blocks event loop - use async/await patterns
- **Hardcoded configuration:** Not testable, not flexible - accept options via CLI args

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Argument parsing | Custom argv parser | Commander.js | Validation, help text, type coercion, subcommands, error messages |
| Structured logging | Custom logger | Pino | Performance, child loggers, serialization, log levels, transport support |
| Terminal colors | ANSI escape sequences | Picocolors | Cross-platform, color support detection, 256-color/truecolor, performance |
| Progress indicators | Custom spinner | Ora | Multiple spinner styles, promise integration, color support |
| Docker container lifecycle | Direct Docker API calls | Dockerode | Promise-based, entity management, stream handling, error handling |
| Timeout management | setTimeout + manual cleanup | AbortController + timeout | Standard API, cleanup handling, promise cancellation |
| Metrics collection | Custom metrics | prom-client (if needed) | Standard format, exporters, metric types (counter/gauge/histogram) |
| State machines | Custom state logic | Simple enums for this scope | XState is overkill for 5 states; use TypeScript unions |

**Key insight:** CLI tools have decades of established patterns. Hand-rolling basic functionality wastes time and introduces bugs. The ecosystem has battle-tested libraries that handle edge cases you haven't considered (signal handling, terminal capabilities, streaming output, etc.).

## Common Pitfalls

### Pitfall 1: Orphaned Docker Containers
**What goes wrong:** CLI crashes without cleaning up containers, leaving zombies
**Why it happens:** No cleanup in error paths, no signal handlers, process killed forcefully
**How to avoid:**
- Always use try/finally for container cleanup
- Register signal handlers (SIGINT, SIGTERM) to gracefully stop containers
- Use `docker ps -a --filter "label=agent-session"` to track and clean up orphaned containers
- Consider using `AutoRemove: true` in container config for ephemeral containers

**Warning signs:**
```bash
# Check for orphaned containers
docker ps -a --filter "status=exited" --filter "label=app=background-agent"
```

**Prevention pattern:**
```typescript
// Source: https://github.com/apocas/dockerode
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, cleaning up...');
  await session.cleanup();
  process.exit(130); // Standard exit code for SIGINT
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, cleaning up...');
  await session.cleanup();
  process.exit(143); // Standard exit code for SIGTERM
});
```

### Pitfall 2: PII in Structured Logs
**What goes wrong:** Sensitive data (API keys, repo contents, user paths) logged to JSON
**Why it happens:** Logging objects without sanitization, verbose debug mode in production
**How to avoid:**
- Use Pino's built-in redaction feature for sensitive fields
- Never log full command arguments (may contain tokens)
- Filter environment variables before logging
- Use log levels correctly (debug vs info vs error)

**Warning signs:** Searching logs for patterns like `apiKey`, `token`, `secret`, `/Users/`

**Prevention pattern:**
```typescript
// Source: https://betterstack.com/community/guides/logging/sensitive-data/
const logger = pino({
  redact: {
    paths: [
      'apiKey',
      'config.anthropicApiKey',
      'env.ANTHROPIC_API_KEY',
      'password',
      'token',
      '*.password',
      '*.token'
    ],
    censor: '[REDACTED]'
  }
});
```

### Pitfall 3: No Timeout Cleanup
**What goes wrong:** Timeout fires but container keeps running, resources leak
**Why it happens:** setTimeout doesn't stop async operations, only rejects promise
**How to avoid:**
- Use AbortController to propagate cancellation
- Ensure timeout handler stops container AND cleans up
- Clear timeout in finally block

**Warning signs:** Containers running past timeout limit, memory/CPU usage grows

**Prevention pattern:**
```typescript
const abortController = new AbortController();
const timeoutHandle = setTimeout(() => {
  logger.warn('Timeout reached, aborting session');
  abortController.abort();
}, this.config.timeout);

try {
  await this.agent.run({ signal: abortController.signal });
} finally {
  clearTimeout(timeoutHandle);
  await this.container.stop();
  await this.container.remove();
}
```

### Pitfall 4: Assuming Docker Daemon is Running
**What goes wrong:** CLI crashes with cryptic errors when Docker isn't available
**Why it happens:** No health check before attempting container operations
**How to avoid:**
- Ping Docker daemon before starting
- Provide clear error message with troubleshooting steps
- Use non-zero exit code (1 for general error)

**Warning signs:** User reports "ENOENT" or "connect EACCES" errors

**Prevention pattern:**
```typescript
// Source: https://github.com/apocas/dockerode
async function checkDockerAvailable(docker: Docker, logger: any) {
  try {
    await docker.ping();
  } catch (error) {
    logger.error('Docker daemon is not running or not accessible');
    logger.error('Please ensure Docker is installed and running');
    logger.error('Try: docker ps');
    process.exit(1);
  }
}
```

### Pitfall 5: Invalid Exit Code Usage
**What goes wrong:** CLI always exits with 0, even on errors; breaks CI/CD pipelines
**Why it happens:** Not calling process.exit() with proper codes, or catching all errors
**How to avoid:**
- Exit 0 ONLY on success
- Exit 1 for general errors
- Exit 2 for invalid arguments
- Exit 124 for timeouts
- Exit 130 for SIGINT (Ctrl+C)

**Warning signs:** CI builds passing when they should fail, scripts continuing after errors

**Prevention pattern:**
```typescript
// Source: https://github.com/lirantal/nodejs-cli-apps-best-practices
// NEVER do this:
try {
  await run();
} catch (error) {
  logger.error(error);
  // Missing process.exit(1) - exits with 0!
}

// DO this instead:
try {
  await run();
  process.exit(0); // Explicit success
} catch (error) {
  logger.error(error);
  process.exit(1); // Explicit failure
}
```

### Pitfall 6: Zombie Processes in Containers
**What goes wrong:** Container PID 1 doesn't reap zombie child processes
**Why it happens:** Shell (sh) or Node.js doesn't handle SIGCHLD, zombies accumulate
**How to avoid:**
- Use tini or dumb-init as container entrypoint
- Configure in Dockerfile: `ENTRYPOINT ["/sbin/tini", "--"]`
- OR use Docker's built-in init: `docker run --init`

**Warning signs:** `ps aux` in container shows `<defunct>` processes

**Prevention pattern:**
```dockerfile
# Source: https://blog.phusion.nl/2015/01/20/docker-and-the-pid-1-zombie-reaping-problem/
FROM node:20-alpine
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "app.js"]
```

Or in dockerode:
```typescript
const container = await docker.createContainer({
  Image: 'agent-sandbox',
  HostConfig: {
    Init: true, // Use Docker's built-in tini
    // ... other config
  }
});
```

### Pitfall 7: Not Validating Parsed Arguments
**What goes wrong:** Invalid values (negative numbers, missing paths) cause runtime errors
**Why it happens:** Commander parses but doesn't validate business logic
**How to avoid:**
- Add custom validation after parsing
- Use Commander's `.argParser()` for type conversion
- Fail fast with clear error messages

**Warning signs:** Crashes deep in execution with "invalid value" errors

**Prevention pattern:**
```typescript
program
  .requiredOption('-t, --turn-limit <number>', 'Maximum turns')
  .action((options) => {
    const turnLimit = parseInt(options.turnLimit, 10);
    if (isNaN(turnLimit) || turnLimit < 1 || turnLimit > 100) {
      logger.error('Turn limit must be between 1 and 100');
      process.exit(2); // Invalid argument
    }
    // Continue with validated value
  });
```

## Code Examples

Verified patterns from official sources:

### Complete CLI Entry Point
```typescript
// src/cli/index.ts
// Sources: Commander.js, Pino, best practices
import { Command } from 'commander';
import pino from 'pino';
import { AgentSession } from '../orchestrator/session.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['apiKey', 'env.ANTHROPIC_API_KEY']
});

const program = new Command();

program
  .name('background-agent')
  .description('Run background coding agent in Docker sandbox')
  .version('1.0.0')
  .requiredOption('-t, --task-type <type>', 'Task type (e.g., test, refactor)')
  .requiredOption('-r, --repo <path>', 'Target repository path')
  .option('--turn-limit <number>', 'Maximum turns (default: 10)', '10')
  .option('--timeout <seconds>', 'Session timeout in seconds (default: 300)', '300')
  .action(async (options) => {
    // Validate arguments
    const turnLimit = parseInt(options.turnLimit, 10);
    const timeout = parseInt(options.timeout, 10);

    if (isNaN(turnLimit) || turnLimit < 1 || turnLimit > 100) {
      logger.error('Turn limit must be between 1 and 100');
      process.exit(2);
    }

    if (isNaN(timeout) || timeout < 30 || timeout > 3600) {
      logger.error('Timeout must be between 30 and 3600 seconds');
      process.exit(2);
    }

    const sessionLogger = logger.child({ taskType: options.taskType });

    try {
      sessionLogger.info('Starting agent session');

      const session = new AgentSession({
        workspaceDir: options.repo,
        turnLimit,
        timeout: timeout * 1000
      });

      // Register cleanup handlers
      const cleanup = async () => {
        sessionLogger.info('Cleaning up session');
        await session.cleanup();
      };

      process.on('SIGINT', async () => {
        await cleanup();
        process.exit(130);
      });

      process.on('SIGTERM', async () => {
        await cleanup();
        process.exit(143);
      });

      const result = await session.run(options.taskType);

      sessionLogger.info({
        state: result.state,
        turns: result.turnCount,
        duration: result.duration
      }, 'Session completed');

      process.exit(result.state === 'success' ? 0 : 1);

    } catch (error) {
      if (error.message === 'SESSION_TIMEOUT') {
        sessionLogger.error('Session exceeded timeout');
        process.exit(124);
      } else {
        sessionLogger.error({ err: error }, 'Session failed');
        process.exit(1);
      }
    }
  });

program.parse();
```

### Session Metrics Tracking (In-Memory)
```typescript
// src/orchestrator/metrics.ts
// Simple in-memory metrics (no Prometheus dependency initially)
export interface SessionMetrics {
  totalSessions: number;
  successCount: number;
  failureCount: number;
  vetoCount: number;
  totalTurns: number;
  totalDuration: number; // milliseconds
}

export class MetricsCollector {
  private metrics: SessionMetrics = {
    totalSessions: 0,
    successCount: 0,
    failureCount: 0,
    vetoCount: 0,
    totalTurns: 0,
    totalDuration: 0
  };

  recordSession(result: SessionResult) {
    this.metrics.totalSessions++;
    this.metrics.totalTurns += result.turnCount;
    this.metrics.totalDuration += result.duration;

    switch (result.state) {
      case 'success':
        this.metrics.successCount++;
        break;
      case 'failed':
        this.metrics.failureCount++;
        break;
      case 'vetoed':
        this.metrics.vetoCount++;
        break;
    }
  }

  getMetrics() {
    const { totalSessions, successCount, failureCount, vetoCount } = this.metrics;

    return {
      ...this.metrics,
      mergeRate: totalSessions > 0 ? successCount / totalSessions : 0,
      vetoRate: totalSessions > 0 ? vetoCount / totalSessions : 0,
      avgTurnsPerSession: totalSessions > 0 ? this.metrics.totalTurns / totalSessions : 0,
      avgDurationPerSession: totalSessions > 0 ? this.metrics.totalDuration / totalSessions : 0
    };
  }
}
```

### Docker Health Check Before Operations
```typescript
// src/orchestrator/container.ts enhancement
import Docker from 'dockerode';

export class ContainerManager {
  private docker: Docker;

  constructor() {
    this.docker = new Docker();
  }

  async checkHealth(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (error) {
      throw new Error(
        'Docker daemon is not running or not accessible. ' +
        'Please ensure Docker is installed and running. ' +
        'Try: docker ps'
      );
    }
  }

  async create(config: ContainerConfig) {
    await this.checkHealth(); // Always check before operations
    // ... existing container creation logic
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| console.log | Pino structured logging | 2020+ | 5x performance, machine-readable logs, child loggers |
| Manual argv parsing | Commander.js | 2015+ | Validation, help text, type safety |
| Chalk for colors | Picocolors | 2021+ | 7x smaller, faster, same API |
| Winston logging | Pino | 2018+ | Low overhead, JSON-first, worker threads |
| XState for simple state | TypeScript unions | 2023+ | Less overhead for < 10 states |
| Manual timeout tracking | AbortController | 2022+ (Node 16+) | Standard API, better cancellation |
| Docker CLI calls via exec | Dockerode SDK | 2014+ | Type safety, promise-based, error handling |

**Deprecated/outdated:**
- **minimist**: Prototype pollution vulnerability (CVE-2021-44906) - use Commander instead
- **colors.js**: Supply chain attack in 2022 - use Picocolors instead
- **Chalk < v5**: ESM migration issues - use Picocolors for better compatibility
- **Manual process.argv parsing**: No validation, no help, fragile - use Commander

## Open Questions

Things that couldn't be fully resolved:

1. **Metrics Export Format**
   - What we know: prom-client supports Prometheus format, in-memory tracking is sufficient initially
   - What's unclear: Whether metrics should be exported to external system or stored locally
   - Recommendation: Start with in-memory MetricsCollector, add Prometheus export if needed later

2. **Log Persistence Strategy**
   - What we know: Pino supports transport to files/streams, JSON format enables log aggregation
   - What's unclear: Whether logs should be persisted per-session or centralized
   - Recommendation: Log to stdout (structured JSON), let user redirect to file if needed

3. **Container Image Versioning**
   - What we know: Agent sandbox image built in Phase 1, needs versioning strategy
   - What's unclear: How to handle image updates without breaking running sessions
   - Recommendation: Tag images with version, allow CLI to specify image tag

4. **Turn vs Time Budget**
   - What we know: Both turn limit (10) and timeout (5 min) are specified
   - What's unclear: Which limit should take precedence, how to handle race conditions
   - Recommendation: Enforce both independently, first to trigger wins, log which limit was hit

## Sources

### Primary (HIGH confidence)
- [Commander.js GitHub](https://github.com/tj/commander.js) - CLI argument parsing official docs
- [Pino GitHub](https://github.com/pinojs/pino) - Structured logging official docs
- [Dockerode GitHub](https://github.com/apocas/dockerode) - Docker API client documentation
- [Node.js Exit Codes - GeeksforGeeks](https://www.geeksforgeeks.org/node-js/node-js-exit-codes/) - Official Node.js exit code documentation
- [Docker PID 1 Zombie Problem - Phusion](https://blog.phusion.nl/2015/01/20/docker-and-the-pid-1-zombie-reaping-problem/) - Authoritative source on container init

### Secondary (MEDIUM confidence)
- [Node.js CLI Apps Best Practices - Liran Tal](https://github.com/lirantal/nodejs-cli-apps-best-practices) - Comprehensive best practices guide (37 practices)
- [Pino vs Winston Comparison - Better Stack](https://betterstack.com/community/comparisons/pino-vs-winston/) - Performance benchmarks verified
- [CLI Telemetry Best Practices](https://marcon.me/articles/cli-telemetry-best-practices/) - Industry patterns for metrics
- [Sensitive Data in Logs - Better Stack](https://betterstack.com/community/guides/logging/sensitive-data/) - PII redaction patterns
- [Picocolors vs Chalk Benchmarks](https://github.com/alexeyraspopov/picocolors) - Performance comparison verified

### Tertiary (LOW confidence)
- [CLI Session Management - DeepWiki](https://deepwiki.com/FlorianBruniaux/claude-code-ultimate-guide/16.1-session-management-commands) - Example patterns, not authoritative
- [State Management Patterns for AI Agents](https://dev.to/inboryn_99399f96579fcd705/state-management-patterns-for-long-running-ai-agents-redis-vs-statefulsets-vs-external-databases-39c5) - Community discussion, not verified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Commander, Pino, Dockerode are industry standards with official docs verified
- Architecture: HIGH - Patterns verified from official sources and best practices guides
- Pitfalls: HIGH - Docker zombie processes, PII logging, exit codes verified from authoritative sources
- Metrics: MEDIUM - In-memory pattern is standard, but export format depends on future requirements
- State management: HIGH - Simple union types confirmed as best practice for < 10 states

**Research date:** 2026-02-06
**Valid until:** 2026-03-06 (30 days - stable ecosystem, Node.js LTS patterns)
