# Phase 13: Container Strategy - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Run Agent SDK (Claude Code) inside a Docker container with network isolation. Host orchestrator spawns a fresh container per agent session. API calls reach Anthropic, nothing else does. Spotify pattern: Claude Code runs inside a sandboxed container, surrounding infrastructure stays outside.

</domain>

<decisions>
## Implementation Decisions

### Process architecture
- **Host orchestrator, containerized agent** — RetryOrchestrator, compositeVerifier, llmJudge, and PR Creator run on the host. Only the Claude Code agent session runs inside Docker.
- `docker run --rm` per session — fresh container per retry attempt, matching the "fresh session per retry" principle. No state leaks between attempts.
- Host calls `query()` which spawns Docker via `spawnClaudeCodeProcess` override — SDK launches `docker run` instead of bare `claude` binary. Preserves SDK hooks, streaming, and result parsing.
- Workspace bind-mounted read-write (`-v /repo:/workspace`) — agent edits are immediately visible to host verifiers after session ends.
- **Docker is always-on** — every agent run goes through Docker, no escape hatch. If Docker isn't running, CLI errors out with a clear message.

### Host-to-container communication
- stdio pipes between host and container — prompt piped via stdin, agent output streamed back via stdout. Matches how `query()` already works with subprocess spawning.
- AbortController aborts `query()` which kills the spawned process. Docker kill fallback if container still alive after 5s. `--rm` flag auto-removes container after exit.

### API key isolation
- **MVP (v2.0):** Pass `ANTHROPIC_API_KEY` as runtime env var (`docker run -e ANTHROPIC_API_KEY=...`). Key is in container process env but NOT baked into image, NOT persisted after `--rm`.
- **Future (v2.1):** Host-side API proxy that injects auth header. Container never sees the key. True CTR-04 compliance. Aligned with conversational interface migration.
- CTR-04 success criteria needs rewording for MVP — key is in container process at runtime, just not in the image.

### Network isolation
- Custom Docker network (`agent-net`) with iptables rules.
- Entrypoint script resolves `api.anthropic.com` IPs at container start, sets iptables rules allowing only TCP 443 to those IPs + DNS (53). All other egress denied.
- Acceptable for short-lived containers (sessions are <5 min). If IPs change mid-session, session fails and retries.
- CLI auto-creates `agent-net` on first run — checks if network exists, creates if not. Zero manual setup.

### Dockerfile & image
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & Migration
- `BRIEF.md` — Full migration analysis: Spotify pattern, what to delete/keep/modify, target architecture
- `BRIEF.md` §Target Architecture — Architecture diagram showing host orchestrator + agent engine separation

### Requirements
- `.planning/REQUIREMENTS.md` §Container Strategy — CTR-01 through CTR-04 (note: CTR-04 needs rewording for MVP)
- `.planning/ROADMAP.md` §Phase 13 — Success criteria (4 must-be-TRUE statements)

### Prior phase decisions
- `.planning/phases/10-agent-sdk-integration/10-CONTEXT.md` — ClaudeCodeSession wrapper design, security hooks, query() options
- `.planning/STATE.md` §Accumulated Context — MVP network strategy decision, Unix proxy deferral to v2.1

### Existing code to modify
- `src/orchestrator/claude-code-session.ts` — ClaudeCodeSession.run() must spawn Docker instead of bare claude process
- `src/cli/commands/run.ts` — Add Docker image build/check, remove any --no-docker assumptions
- `docker/Dockerfile` — Complete rewrite for Claude Code as main process

### Spotify reference
- https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1 — Architecture overview
- https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3 — "Agent runs in container with limited permissions, few binaries, highly sandboxed"

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ClaudeCodeSession` (claude-code-session.ts): Already wraps `query()` with hooks — needs Docker spawning added, not rewritten
- `docker/Dockerfile`: Base structure (Alpine, multi-stage, non-root user) — rewrite but preserve multi-runtime approach
- AbortController pattern: Existing timeout/abort logic in ClaudeCodeSession — extend with docker kill fallback
- Security hooks (PreToolUse/PostToolUse): Unchanged — still run via SDK inside the container

### Established Patterns
- Fresh session per retry: `--rm` flag + new container per attempt preserves this
- compositeVerifier runs on host against bind-mounted workspace: Unchanged boundary
- Pino structured logging: Container stdout captured by host, fed into existing log pipeline

### Integration Points
- `ClaudeCodeSession.run()`: Key modification point — override how `query()` spawns the agent process
- `runAgent()` in run.ts: Add Docker image existence check and auto-build before creating orchestrator
- Docker network: Auto-create `agent-net` if not exists, pass `--network agent-net` to docker run

</code_context>

<specifics>
## Specific Ideas

- Emulate Spotify's pattern: "Claude Code runs inside a sandboxed container" with surrounding infrastructure (orchestrator, verifiers, judge, PR creator) outside
- v2.1 upgrade path: Host-side API proxy replaces runtime env var for true key isolation — aligned with conversational interface migration
- Container should feel like v1.1's security model (non-root, network-restricted, minimal binaries) but with Claude Code as the agent engine instead of custom agentic loop

</specifics>

<deferred>
## Deferred Ideas

- **Host-side API proxy** — Container never sees API key. Deferred to v2.1 when conversational interface is built. Currently using runtime env var as MVP.
- **Pre-built images on GHCR** — Publish to registry for faster first-run. Not needed for MVP, local build + cache is sufficient.
- **Multi-image strategy** — Base image + task-specific extensions (e.g., add Python runtime). Defer until new task types require it.
- **Unix proxy socket** — STATE.md already deferred this to v2.1.

</deferred>

---

*Phase: 13-container-strategy*
*Context gathered: 2026-03-19*
