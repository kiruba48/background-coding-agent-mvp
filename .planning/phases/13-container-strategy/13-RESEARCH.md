# Phase 13: Container Strategy - Research

**Researched:** 2026-03-19
**Domain:** Docker container spawning via Claude Agent SDK, iptables network isolation, non-root privilege drop, Alpine Linux entrypoint patterns
**Confidence:** HIGH (SDK types confirmed from local node_modules; Docker patterns verified from official docs)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Process architecture**
- Host orchestrator, containerized agent — RetryOrchestrator, compositeVerifier, llmJudge, and PR Creator run on the host. Only the Claude Code agent session runs inside Docker.
- `docker run --rm` per session — fresh container per retry attempt, matching the "fresh session per retry" principle. No state leaks between attempts.
- Host calls `query()` which spawns Docker via `spawnClaudeCodeProcess` override — SDK launches `docker run` instead of bare `claude` binary. Preserves SDK hooks, streaming, and result parsing.
- Workspace bind-mounted read-write (`-v /repo:/workspace`) — agent edits are immediately visible to host verifiers after session ends.
- **Docker is always-on** — every agent run goes through Docker, no escape hatch. If Docker isn't running, CLI errors out with a clear message.

**Host-to-container communication**
- stdio pipes between host and container — prompt piped via stdin, agent output streamed back via stdout. Matches how `query()` already works with subprocess spawning.
- AbortController aborts `query()` which kills the spawned process. Docker kill fallback if container still alive after 5s. `--rm` flag auto-removes container after exit.

**API key isolation**
- **MVP (v2.0):** Pass `ANTHROPIC_API_KEY` as runtime env var (`docker run -e ANTHROPIC_API_KEY=...`). Key is in container process env but NOT baked into image, NOT persisted after `--rm`.
- **Future (v2.1):** Host-side API proxy that injects auth header. Container never sees the key. True CTR-04 compliance. Aligned with conversational interface migration.
- CTR-04 success criteria needs rewording for MVP — key is in container process at runtime, just not in the image.

**Network isolation**
- Custom Docker network (`agent-net`) with iptables rules.
- Entrypoint script resolves `api.anthropic.com` IPs at container start, sets iptables rules allowing only TCP 443 to those IPs + DNS (53). All other egress denied.
- Acceptable for short-lived containers (sessions are <5 min). If IPs change mid-session, session fails and retries.
- CLI auto-creates `agent-net` on first run — checks if network exists, creates if not. Zero manual setup.

**Dockerfile & image**
- Rewrite existing `docker/Dockerfile` — replace `CMD ["sleep", "infinity"]` with proper entrypoint.
- Keep multi-runtime: Node.js 20 + Java 17 + Maven (supports both maven-dependency-update and npm-dependency-update task types).
- Install Claude Code CLI globally: `npm install -g @anthropic-ai/claude-code` (pinned version for reproducibility).
- Entrypoint starts as root (for iptables setup), then drops to `agent` user (UID 1001) via `su-exec`. Standard Docker setup-then-drop-privileges pattern.
- Additional packages needed: `iptables`, `bind-tools` (for `dig`), `su-exec`.
- Build locally, cache aggressively — `docker build` on first run, layer caching for fast rebuilds. No registry dependency.

### Claude's Discretion
- Exact `spawnClaudeCodeProcess` override implementation (how to wire Docker spawning into SDK's query() options)
- Container security hardening flags (--cap-drop, --read-only, --pids-limit) — carry forward from v1.1 where applicable
- Image tagging and versioning strategy
- Exact entrypoint.sh implementation details
- How to handle DNS resolution edge cases (dig failures, no results)

### Deferred Ideas (OUT OF SCOPE)
- **Host-side API proxy** — Container never sees API key. Deferred to v2.1 when conversational interface is built. Currently using runtime env var as MVP.
- **Pre-built images on GHCR** — Publish to registry for faster first-run. Not needed for MVP, local build + cache is sufficient.
- **Multi-image strategy** — Base image + task-specific extensions (e.g., add Python runtime). Defer until new task types require it.
- **Unix proxy socket** — STATE.md already deferred this to v2.1.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CTR-01 | Dockerfile runs Claude Agent SDK (Claude Code) inside Docker container | SDK needs Claude Code CLI installed globally; entrypoint must exec `claude` with stdio mode; verified SDK version 0.2.79, Claude Code CLI 2.1.79 |
| CTR-02 | `spawnClaudeCodeProcess` pipes stdio between host orchestrator and container | Confirmed: SDK `Options.spawnClaudeCodeProcess` accepts `(SpawnOptions) => SpawnedProcess`; `ChildProcess` from `child_process.spawn` directly satisfies `SpawnedProcess`; we spawn `docker run` and return the ChildProcess |
| CTR-03 | Container maintains network isolation equivalent to v1.x `NetworkMode: none` | Confirmed: iptables-in-entrypoint pattern on `agent-net` bridge network; entrypoint resolves IPs via `dig`, allows ESTABLISHED+TCP 443 to those IPs, blocks all other OUTPUT/FORWARD; requires `--cap-add NET_ADMIN` |
| CTR-04 | Container runs as non-root user with minimal capabilities | Confirmed: entrypoint runs as root for iptables setup, then `exec su-exec agent "$@"` drops to UID 1001; `--cap-drop ALL --cap-add NET_ADMIN` during setup only; `--security-opt no-new-privileges` prevents re-escalation |
</phase_requirements>

---

## Summary

Phase 13 uses the Claude Agent SDK's `spawnClaudeCodeProcess` option to launch Claude Code inside a Docker container instead of as a bare local process. The host orchestrator retains all existing SDK hooks, streaming, and result parsing — only the process spawning is overridden. The SDK's `SpawnedProcess` interface is a subset of Node.js `ChildProcess`, so `child_process.spawn('docker', ['run', '--rm', ...flags, imageTag])` can be returned directly.

Network isolation is achieved via iptables rules set in an entrypoint script that runs before privilege drop. The entrypoint resolves `api.anthropic.com` to IP addresses at container startup using `dig`, allows outbound TCP 443 to those IPs plus DNS (UDP 53), and blocks all other egress. This is more permissive than v1.x `NetworkMode: none` but correctly allows API calls while blocking everything else.

The one known pitfall is the `pathToClaudeCodeExecutable` option which has documented spawn ENOENT failures in Docker (GitHub issues #14464 and #865). The `spawnClaudeCodeProcess` override is the correct bypass — it replaces the SDK's internal spawn logic entirely rather than trying to guide it.

**Primary recommendation:** Implement `spawnClaudeCodeProcess` in `ClaudeCodeSession` to return `spawnSync`-derived `docker run` as a `ChildProcess`. Write entrypoint.sh with root-level iptables setup followed by `exec su-exec agent "$@"`. The Dockerfile rewrite installs Claude Code CLI at a pinned version and stores the entrypoint as the image ENTRYPOINT.

---

## Standard Stack

### Core

| Library / Tool | Version | Purpose | Why Standard |
|----------------|---------|---------|--------------|
| `@anthropic-ai/claude-agent-sdk` | 0.2.79 (current) | SDK's `query()` with `spawnClaudeCodeProcess` override | Already in use; `spawnClaudeCodeProcess` is the official extension point for containers |
| `@anthropic-ai/claude-code` | 2.1.79 (current) | CLI installed inside container; SDK spawns it | Required inside container; SDK bundles its own CLI but `npm install -g` is the containerization path |
| `node:child_process` | Node 20 built-in | Spawn `docker run` and return as `SpawnedProcess` | `ChildProcess` already satisfies `SpawnedProcess` interface |
| `su-exec` | Alpine apk | Drop from root to `agent` user after iptables setup | Minimal (10KB), purpose-built for containers, standard Alpine privilege drop tool |
| `iptables` | Alpine apk | Block/allow egress inside container | Standard Linux firewall; requires `--cap-add NET_ADMIN` to use inside container |
| `bind-tools` | Alpine apk | `dig` for resolving `api.anthropic.com` at startup | Provides `dig` on Alpine; lightweight DNS lookup tool |

### Supporting

| Library / Tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| `execFileAsync` (node:child_process) | Node built-in | CLI: run `docker network inspect`/`docker network create` | Auto-creating `agent-net` before first run |
| Docker `--cap-add NET_ADMIN` | Docker CE | Allow iptables inside container | Only needed for network isolation entrypoint setup |
| Docker `--security-opt no-new-privileges` | Docker CE | Block setuid escalation after entrypoint drops privileges | Always apply on production containers |
| Docker `--cap-drop ALL` combined with `--cap-add NET_ADMIN` | Docker CE | Minimal capabilities: NET_ADMIN for iptables, nothing else | Post-privilege-drop; combined with `--security-opt no-new-privileges` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| iptables in entrypoint | `--network none` + proxy socket | Proxy socket deferred to v2.1; iptables is the simpler MVP path |
| iptables in entrypoint | Host-level nftables rules | Requires Docker host admin access; entrypoint is self-contained and portable |
| `su-exec` | `gosu` | Both work; su-exec is smaller (10KB vs 1.8MB); standard choice on Alpine |
| `dig` (bind-tools) | `nslookup` | dig provides structured IP output easier to parse in shell; bind-tools is the Alpine package |
| Runtime `ANTHROPIC_API_KEY` env var | Proxy pattern | Proxy pattern is v2.1; runtime env var is the MVP pattern decided in CONTEXT.md |

**Installation (inside Dockerfile):**
```bash
apk add --no-cache bash git ca-certificates ripgrep iptables bind-tools su-exec openjdk17-jre-headless maven
npm install -g @anthropic-ai/claude-code@2.1.79
```

**Version verification:**
- `npm view @anthropic-ai/claude-code version` → `2.1.79` (verified 2026-03-19)
- `npm view @anthropic-ai/claude-agent-sdk version` → `0.2.79` (verified 2026-03-19)

---

## Architecture Patterns

### Recommended Project Structure

```
docker/
├── Dockerfile          # Rewrite: multi-stage, Claude Code CLI, entrypoint
└── entrypoint.sh       # NEW: iptables setup as root, exec su-exec agent

src/
├── orchestrator/
│   └── claude-code-session.ts   # Modify: add spawnClaudeCodeProcess + docker kill fallback
├── cli/
│   ├── commands/
│   │   └── run.ts               # Modify: add ensureDockerReady() before orchestrator
│   └── docker/
│       └── index.ts             # NEW: buildImageIfNeeded(), ensureNetworkExists(), spawnDockerSession()
```

### Pattern 1: spawnClaudeCodeProcess Override

**What:** Replace SDK's internal spawn with `child_process.spawn('docker', ['run', '--rm', ...])` and return the resulting `ChildProcess` directly. The SDK treats it exactly like a local Claude Code process.

**When to use:** Every session — Docker is always-on per locked decision.

**Example:**
```typescript
// Source: sdk.d.ts SpawnedProcess interface (verified in node_modules)
import { spawn } from 'node:child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

function spawnDockerSession(
  image: string,
  workspaceDir: string,
  apiKey: string,
  networkName: string,
): (sdkOptions: SpawnOptions) => SpawnedProcess {
  return (sdkOptions: SpawnOptions) => {
    const dockerArgs = [
      'run', '--rm', '--interactive',
      '--network', networkName,
      '--cap-drop', 'ALL',
      '--cap-add', 'NET_ADMIN',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '200',
      '-e', `ANTHROPIC_API_KEY=${apiKey}`,
      '-v', `${workspaceDir}:/workspace:rw`,
      '--workdir', '/workspace',
      image,
      // Pass through SDK's command/args (the `claude` binary invocation)
      sdkOptions.command,
      ...sdkOptions.args,
    ];

    // ChildProcess satisfies SpawnedProcess interface
    return spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'inherit'],
      signal: sdkOptions.signal,
      env: {}, // Docker container has its own env
    });
  };
}
```

**Wire it into query():**
```typescript
queryGen = query({
  prompt: userMessage,
  options: {
    // ... existing options ...
    spawnClaudeCodeProcess: spawnDockerSession(imageName, workspaceDir, apiKey, 'agent-net'),
  },
});
```

### Pattern 2: Docker Kill Fallback on Abort

**What:** When AbortController fires (timeout or SIGINT), the Docker container may survive after the `query()` generator exits. Track the container ID and `docker kill` it as a fallback.

**When to use:** Always — ensures no zombie containers consume resources.

**Example:**
```typescript
// Track container name for cleanup
const containerName = `agent-${sessionId}`;
// Add --name flag to docker run args:
'--name', containerName,

// In finally block:
try {
  await execFileAsync('docker', ['kill', containerName], { timeout: 5000 });
} catch {
  // Container may have already exited — ignore errors
}
```

### Pattern 3: entrypoint.sh — Root Setup then Drop

**What:** Container ENTRYPOINT runs as root to configure iptables, resolves Anthropic API IPs, then drops to the `agent` user via `su-exec` before executing the actual command.

**When to use:** Every container start — enables network isolation without requiring a privileged container.

**Example:**
```bash
#!/bin/bash
set -e

# --- Network isolation (runs as root) ---
# Resolve api.anthropic.com to IPs
ANTHROPIC_IPS=$(dig +short api.anthropic.com A 2>/dev/null || echo "")

# Allow established connections (for responses)
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS (UDP 53) for further lookups
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT

# Allow TCP 443 to Anthropic IPs
if [ -n "$ANTHROPIC_IPS" ]; then
  for IP in $ANTHROPIC_IPS; do
    iptables -A OUTPUT -p tcp --dport 443 -d "$IP" -j ACCEPT
  done
fi

# Block all other outbound traffic
iptables -A OUTPUT -j DROP

# --- Drop to non-root user ---
exec su-exec agent "$@"
```

### Pattern 4: Docker Network Auto-Setup

**What:** CLI checks for `agent-net` before creating the orchestrator; creates it if absent. Zero manual setup for the user.

**Example:**
```typescript
async function ensureNetworkExists(networkName: string): Promise<void> {
  try {
    await execFileAsync('docker', ['network', 'inspect', networkName]);
  } catch {
    // Network doesn't exist — create it
    await execFileAsync('docker', ['network', 'create', networkName]);
  }
}
```

### Pattern 5: Docker Readiness Check

**What:** CLI checks if Docker daemon is running before proceeding, giving a clear error if not.

**Example:**
```typescript
async function assertDockerRunning(): Promise<void> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 5000 });
  } catch {
    throw new Error(
      'Docker is not running. Start Docker Desktop or the Docker daemon before running background-agent.'
    );
  }
}
```

### Anti-Patterns to Avoid

- **Using `pathToClaudeCodeExecutable` for Docker:** Known spawn ENOENT failures in containers (GitHub issues #14464, #865). Use `spawnClaudeCodeProcess` instead — it bypasses internal spawn logic entirely.
- **Baking `ANTHROPIC_API_KEY` into the image:** Key would persist in image layers. Always pass as `-e` at runtime; use `--rm` to clear container env on exit.
- **Running iptables rules as the `agent` user:** `iptables` requires root/NET_ADMIN. Always set rules in entrypoint before `su-exec` drop.
- **Using `--network none` with API calls:** Blocks everything including Anthropic API. Use `agent-net` bridge + iptables instead.
- **Forgetting `--interactive` flag on `docker run`:** Without `-i`, stdin is closed immediately and Claude Code won't receive the prompt from the SDK.
- **Hardcoding iptables rules with static IPs:** Anthropic may change CDN IPs. Always resolve at container startup via `dig`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Privilege drop after root setup | Custom setuid binary | `su-exec` (Alpine apk) | Purpose-built, 10KB, no shell overhead |
| Process spawn returning streams | Custom process wrapper | Return `ChildProcess` directly from `child_process.spawn` | Already satisfies `SpawnedProcess` — no adapter needed |
| DNS resolution in entrypoint | Custom resolver | `dig +short` (bind-tools) | Standard, available on Alpine, outputs clean IPs |
| Container readiness check | `docker ps` parsing | `docker info` exit code | `docker info` fails fast and cleanly if daemon is down |

**Key insight:** The `SpawnedProcess` interface was designed so `ChildProcess` satisfies it directly. No adapter class, no wrapping, no monkey-patching.

---

## Common Pitfalls

### Pitfall 1: `pathToClaudeCodeExecutable` Fails Inside Docker

**What goes wrong:** `spawn /usr/local/bin/claude ENOENT` even when the binary is installed and `pathToClaudeCodeExecutable` is set.

**Why it happens:** The SDK's internal spawn logic has environment inheritance issues in containers. The option is read but the spawn path hits a different code branch in some SDK versions.

**How to avoid:** Use `spawnClaudeCodeProcess` to provide your own spawn function. This bypasses internal spawn logic entirely. The option was designed for exactly this use case ("Use this to run Claude Code in VMs, containers, or remote environments").

**Warning signs:** ENOENT errors referencing the claude binary path even though `which claude` works inside the container.

### Pitfall 2: Missing `--interactive` Flag

**What goes wrong:** The `query()` SDK writes the prompt to stdin of the spawned process. Without `-i`, Docker closes stdin immediately and Claude Code exits without receiving input.

**Why it happens:** `docker run` by default does not allocate a stdin pipe unless `-i` is specified.

**How to avoid:** Always include `--interactive` (or `-i`) in the docker run args. Do NOT use `-t` (pseudo-TTY) — that would break stdio pipe format.

**Warning signs:** Session returns immediately with no output; container exits with code 0 before any tool calls.

### Pitfall 3: NET_ADMIN Capability Required for iptables

**What goes wrong:** `iptables: Operation not permitted` in entrypoint — iptables setup fails silently or loudly, container starts without network isolation.

**Why it happens:** By default `--cap-drop ALL` removes `NET_ADMIN`. Iptables requires this Linux capability to modify netfilter rules.

**How to avoid:** Pair `--cap-drop ALL` with `--cap-add NET_ADMIN` in docker run args. After `su-exec` drops to the `agent` user, `NET_ADMIN` is still present but `no-new-privileges` prevents the agent from using it to escalate.

**Warning signs:** Container starts successfully but `dig api.anthropic.com` from within the container returns results for arbitrary domains (rules didn't apply).

### Pitfall 4: dig Fallback When DNS Resolution Fails

**What goes wrong:** `dig +short api.anthropic.com` returns empty string (DNS unavailable at container start). Entrypoint sets zero ACCEPT rules, then blocks everything — API calls fail immediately.

**Why it happens:** Container networking may not be fully initialized when entrypoint runs, or the custom `agent-net` DNS resolver isn't ready yet.

**How to avoid:** Retry `dig` up to 3 times with a short sleep. If all retries fail, log a warning and continue without IP-specific rules (fall back to allowing TCP 443 to any destination, which is less restrictive but still blocks non-HTTPS traffic). Document this as a known edge case.

**Warning signs:** Session fails with "connection refused" on the first API call.

### Pitfall 5: AbortController Kills Query but Container Keeps Running

**What goes wrong:** After timeout, the SDK generator is closed but the `docker run` process (already started) keeps running — a zombie container that consumes resources and holds the bind-mounted workspace.

**Why it happens:** Node.js `child_process.spawn` with `signal` option sends SIGTERM/SIGKILL to the process, but Docker containers may not forward signals to PID 1 correctly depending on the ENTRYPOINT form.

**How to avoid:** Track container name (`--name agent-${sessionId}`), and in the `finally` block of `ClaudeCodeSession.run()`, call `docker kill <name>` after the AbortController fires. The `--rm` flag handles cleanup after kill.

**Warning signs:** `docker ps` shows containers running after orchestrator loop has completed.

### Pitfall 6: MCP Verifier Server Conflicts with Docker Entrypoint

**What goes wrong:** The MCP verifier server created in `ClaudeCodeSession` is an in-process SDK server. With Docker spawning, the agent runs in a container and may not be able to call the host's in-process MCP server.

**Why it happens:** The verifier MCP server uses `createSdkMcpServer()` which is an in-process server. When the SDK spawns Docker instead of a local process, the MCP server communication mechanism needs to work across the spawn boundary.

**How to avoid:** The SDK handles this transparently — `mcpServers` config with an SDK instance type is passed via the SDK's own IPC mechanism to the spawned process. This should work with `spawnClaudeCodeProcess` since the SDK manages MCP server initialization before spawning. Verify by checking that the `mcp__verifier__verify` tool is available in the container session.

**Warning signs:** Agent logs show MCP tool calls failing with "tool not found" or connection errors.

---

## Code Examples

Verified patterns from SDK type definitions in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

### spawnClaudeCodeProcess Signature (verified from sdk.d.ts)
```typescript
// Source: node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts line 1245
spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;

// SpawnOptions (line 3395)
interface SpawnOptions {
  command: string;      // The claude binary path
  args: string[];       // Args SDK would pass to claude
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

// SpawnedProcess (line 3354) — ChildProcess already satisfies this
interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', ...): void;
  once(event: 'error', ...): void;
  off(event: 'exit', ...): void;
  off(event: 'error', ...): void;
}
```

### Docker Run Command Structure
```typescript
// Source: architecture decisions in 13-CONTEXT.md + official Anthropic secure deployment docs
const dockerArgs = [
  'run',
  '--rm',
  '--interactive',                    // Keep stdin open — required for SDK stdio
  '--name', containerName,            // Named for docker kill fallback
  '--network', 'agent-net',           // Custom network with iptables
  '--cap-drop', 'ALL',                // Drop all Linux caps
  '--cap-add', 'NET_ADMIN',           // Needed for iptables in entrypoint
  '--security-opt', 'no-new-privileges',
  '--pids-limit', '200',
  '-e', `ANTHROPIC_API_KEY=${apiKey}`, // Runtime env, not baked into image
  '-v', `${workspaceDir}:/workspace:rw`,
  '--workdir', '/workspace',
  imageTag,
  sdkOptions.command,                 // claude binary (e.g., /usr/local/bin/claude)
  ...sdkOptions.args,                 // SDK-provided args
];
```

### Dockerfile Pattern (rewrite of docker/Dockerfile)
```dockerfile
# Stage 1: Node.js + runtime base
FROM node:20-alpine AS nodejs-base
RUN apk add --no-cache bash git ca-certificates ripgrep iptables bind-tools su-exec

# Stage 2: Add Java + Maven
FROM nodejs-base AS multi-runtime
RUN apk add --no-cache openjdk17-jre-headless maven

# Stage 3: Install Claude Code CLI
FROM multi-runtime AS agent
RUN npm install -g @anthropic-ai/claude-code@2.1.79

# Create non-root user
RUN addgroup -g 1001 -S agent && \
    adduser -u 1001 -S agent -G agent -h /home/agent

# Workspace
WORKDIR /workspace
RUN chown agent:agent /workspace

# Entrypoint script
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Run entrypoint as root (for iptables), drops to agent inside
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

### entrypoint.sh Pattern
```bash
#!/bin/bash
# Source: official Anthropic secure deployment docs + iptables container pattern
set -e

# Resolve Anthropic API IPs for allowlist
ANTHROPIC_IPS=""
for i in 1 2 3; do
  ANTHROPIC_IPS=$(dig +short api.anthropic.com A 2>/dev/null)
  [ -n "$ANTHROPIC_IPS" ] && break
  sleep 1
done

# Allow established/related connections (responses to our requests)
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS for lookups
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

if [ -n "$ANTHROPIC_IPS" ]; then
  for IP in $ANTHROPIC_IPS; do
    iptables -A OUTPUT -p tcp --dport 443 -d "$IP" -j ACCEPT
  done
  # Block everything else
  iptables -A OUTPUT -j DROP
else
  # DNS fallback: allow all TCP 443 if resolution failed (warn but proceed)
  echo "WARNING: Failed to resolve api.anthropic.com — allowing all TCP 443" >&2
  iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
  iptables -A OUTPUT -j DROP
fi

# Drop from root to agent user
exec su-exec agent "$@"
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom `ContainerManager` with dockerode | `spawnClaudeCodeProcess` override returning ChildProcess | Phase 11 deleted ContainerManager | Massively simpler; no Docker API library needed |
| `docker exec` into persistent container | `docker run --rm` per session | v1.x to v2.0 | Cleaner isolation; no state leaks between retries |
| `NetworkMode: none` (blocks everything) | `agent-net` + iptables (allows Anthropic only) | Phase 13 (this phase) | API calls now work inside container |
| Agent ran directly as local process | Agent runs in container via `spawnClaudeCodeProcess` | Phase 13 (this phase) | Network and filesystem isolation restored |

**Deprecated/outdated:**
- `dockerode`: Removed in Phase 11 (DEL-04). Do NOT add back — `child_process.spawn` is sufficient.
- `pathToClaudeCodeExecutable`: Works in some scenarios but has documented ENOENT failures in Docker. Prefer `spawnClaudeCodeProcess`.

---

## Open Questions

1. **MCP verifier server cross-spawn communication**
   - What we know: `createVerifierMcpServer()` is in-process SDK server type; SDK passes MCP config to spawned process via its own IPC mechanism
   - What's unclear: Whether SDK in-process MCP servers work transparently when `spawnClaudeCodeProcess` is used vs bare local spawn
   - Recommendation: Implement and test early. If MCP server doesn't work through Docker spawn, consider running the MCP verifier as a separate stdio subprocess (`StdioMcpServer` type) that Docker can communicate with via a mounted socket, or simplify to host-side-only verification for Phase 13.

2. **SDK command/args format when spawning Docker**
   - What we know: `SpawnOptions.command` is the `claude` binary path; `SpawnOptions.args` are the SDK-generated args for Claude Code
   - What's unclear: Whether the SDK's generated args are compatible when passed to a container-internal `claude` binary (e.g., session IDs, config paths that reference host filesystem)
   - Recommendation: Log `sdkOptions.command` and `sdkOptions.args` in the spawn function during development to inspect what the SDK passes. The `--workdir /workspace` ensures Claude Code uses the container's workspace path.

3. **Session persistence paths**
   - What we know: SDK uses `persistSession: true` by default, which writes session state to disk
   - What's unclear: Where the SDK writes session files in the container; whether `--rm` container exit correctly cleans these up or if tmpfs is needed for `/home/agent`
   - Recommendation: Add `--tmpfs /home/agent:rw,size=500m` to docker run args to ensure Claude Code's session cache doesn't persist on host. Alternatively set `persistSession: false` in query options.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.0.18 |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `npm test -- --reporter=verbose src/cli/docker/index.test.ts src/orchestrator/claude-code-session.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CTR-01 | Dockerfile builds successfully with Claude Code CLI installed | smoke | `docker build -t background-agent:test docker/` (manual verification in plan) | ❌ Wave 0 |
| CTR-02 | `spawnClaudeCodeProcess` returns ChildProcess from `docker run` with correct args | unit | `npm test -- src/cli/docker/index.test.ts` | ❌ Wave 0 |
| CTR-02 | ClaudeCodeSession passes `spawnClaudeCodeProcess` to `query()` when docker mode enabled | unit | `npm test -- src/orchestrator/claude-code-session.test.ts` | ✅ (extend existing) |
| CTR-03 | entrypoint.sh applies iptables rules (iptables -L shows expected rules) | manual-only | N/A — requires container runtime | manual |
| CTR-03 | Agent can reach api.anthropic.com but not other hosts (integration) | manual-only | N/A — requires live Docker + API key | manual |
| CTR-04 | Container process runs as UID 1001, not 0 | unit | `docker run --rm background-agent:test whoami` (manual in plan) | ❌ Wave 0 |

**Manual-only justification for CTR-03:** Network isolation testing requires a live Docker daemon and real iptables; cannot be mocked in Vitest unit tests.

### Sampling Rate

- **Per task commit:** `npm test -- src/cli/docker/index.test.ts src/orchestrator/claude-code-session.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/cli/docker/index.ts` — Docker helper module (buildImageIfNeeded, ensureNetworkExists, spawnDockerSession, assertDockerRunning)
- [ ] `src/cli/docker/index.test.ts` — Unit tests for docker helper functions using mocked `execFileAsync` and `spawn`
- [ ] `docker/entrypoint.sh` — Container entrypoint script (no test file, manual verification)
- [ ] Extend `src/orchestrator/claude-code-session.test.ts` — Add tests for `spawnClaudeCodeProcess` being wired into query() options

---

## Sources

### Primary (HIGH confidence)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — `SpawnedProcess`, `SpawnOptions`, `spawnClaudeCodeProcess` interface verified directly
- https://platform.claude.com/docs/en/agent-sdk/typescript — Official SDK reference for Options table, spawnClaudeCodeProcess documentation
- https://platform.claude.com/docs/en/agent-sdk/secure-deployment — Official secure deployment guide: Docker hardening flags, iptables pattern, credential proxy pattern
- https://platform.claude.com/docs/en/agent-sdk/hosting — Official hosting guide: container patterns, system requirements, Claude Code CLI install

### Secondary (MEDIUM confidence)
- https://docs.docker.com/engine/network/packet-filtering-firewalls/ — Docker iptables documentation
- https://docs.docker.com/engine/network/firewall-iptables/ — Docker firewall docs
- https://dev.to/andre/docker-restricting-in--and-outbound-network-traffic-67p — Entrypoint iptables + su-exec privilege drop pattern (multiple sources cross-verified)

### Tertiary (LOW confidence — flag for validation)
- https://github.com/anthropics/claude-code/issues/14464 — ENOENT spawn issue in Docker (closed, not planned — status as of 2026-02-25)
- https://github.com/anthropics/anthropic-sdk-typescript/issues/865 — Related ENOENT issue

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions confirmed via `npm view`; interfaces verified in local node_modules
- Architecture (spawnClaudeCodeProcess): HIGH — interface confirmed in sdk.d.ts; ChildProcess compatibility stated in official docs
- Architecture (iptables/entrypoint): MEDIUM — pattern well-documented in Docker docs and multiple community sources; specific iptables commands need container validation
- Pitfalls: HIGH for ENOENT/pathToClaudeCodeExecutable (documented GitHub issues); MEDIUM for DNS edge cases (deduced from general iptables timing behavior)

**Research date:** 2026-03-19
**Valid until:** 2026-04-19 (SDK is actively developed; pin the Claude Code CLI version in Dockerfile to avoid drift)
