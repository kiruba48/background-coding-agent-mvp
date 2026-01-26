# Architecture Patterns

**Domain:** Background Coding Agent Platforms
**Researched:** 2026-01-26
**Confidence:** MEDIUM-HIGH

## Recommended Architecture

Background coding agent platforms follow a **layered "sandwich" architecture** that separates orchestration, agent execution, tool access, and verification into distinct, composable layers. This pattern emerged from production systems like Spotify's background coding agent and is now a recognized best practice.

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR LAYER                        │
│  (CLI, Job Queue, Session Management, Trace Collection)     │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     AGENT ENGINE LAYER                       │
│       (Claude SDK w/ Agentic Loop, Context Management)      │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       TOOL LAYER (MCP)                       │
│        (Limited, Safe Tools: Read, Edit, Git, Bash)         │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    VERIFICATION LAYER                        │
│  (Deterministic Verifiers + LLM Judge Quality Control)      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                       PR / Output System
```

### Component Boundaries

| Component | Responsibility | Communicates With | Stability |
|-----------|---------------|-------------------|-----------|
| **Orchestrator** | Session lifecycle, prompt loading, retry logic, trace collection | Agent Engine (spawn/monitor), Verification (results), PR System (create) | HIGH - Build first |
| **Agent Engine** | Agentic reasoning loop, multi-file context, task planning | Orchestrator (lifecycle), Tool Layer (invocations) | HIGH - Use SDK |
| **Tool Layer (MCP)** | Controlled access to filesystem, git, and shell via MCP protocol | Agent Engine (tool requests), Sandbox (execute) | MEDIUM - Constrain carefully |
| **Sandbox** | Isolated execution environment (Docker), security boundary | Tool Layer (commands), Orchestrator (monitoring) | HIGH - Non-negotiable |
| **Verification** | Run builds/tests/lints (deterministic), LLM Judge for scope validation | Orchestrator (results), Agent Engine (retry feedback) | MEDIUM - Iterative design |
| **PR System** | Create GitHub PRs with metadata, format descriptions | Orchestrator (approved changes), Git (repo API) | LOW - Standard integration |

### Data Flow

**Successful execution path:**

```
1. Orchestrator receives task (CLI input or queue message)
   ↓
2. Orchestrator loads prompt template + repo context
   ↓
3. Orchestrator spawns Agent Engine in Docker sandbox
   ↓
4. Agent Engine requests tools via MCP (Read, Edit, Bash, Git)
   ↓
5. Tool Layer validates requests against allowlist, executes safely
   ↓
6. Agent Engine completes changes, returns control to Orchestrator
   ↓
7. Verification Layer runs deterministic checks (build, test, lint)
   ↓
8. [PASS] LLM Judge evaluates diff against original prompt
   ↓
9. [APPROVE] Orchestrator creates PR with metadata
   ↓
10. Human reviews and merges
```

**Failure/retry path:**

```
7. Verification Layer detects failure (tests fail, build breaks)
   ↓
8. Orchestrator formats error summary (not full logs)
   ↓
9. Orchestrator respawns Agent Engine with error context
   ↓
10. Agent attempts fix (max 3 retries)
   ↓
11. If still failing: Log session, no PR created
```

**LLM Judge veto path:**

```
8. [PASS] Deterministic verifiers pass
   ↓
9. LLM Judge detects scope creep or quality issues
   ↓
10. [VETO] Orchestrator logs session, no PR created
   ↓
11. Track veto rate for monitoring (~25% is healthy)
```

## Patterns to Follow

### Pattern 1: End-State Prompting
**What:** Describe the desired outcome, not the steps to achieve it. Let the agent plan the approach.

**When:** All task type prompts (dependency updates, refactors, migrations)

**Why:** Spotify research shows end-state prompts outperform step-by-step instructions. The agent's planning capability is a strength, not a weakness.

**Example:**
```markdown
# Good (End-State)
Update the Maven dependency `com.example:library` from 1.x to 2.x.
The codebase should build and all tests should pass after the update.

# Bad (Step-by-Step)
1. Find all pom.xml files
2. Update the version of com.example:library
3. Run mvn compile
4. If compilation fails, fix the errors
5. Run mvn test
```

**Anti-pattern:** Over-constraining the agent with detailed steps. This leads to brittleness when unexpected situations arise.

### Pattern 2: Limited Tool Access
**What:** Provide only the minimal toolset needed for the task. Use allowlists, not denylists.

**When:** Tool layer design and configuration

**Why:** Full terminal access creates unpredictability. Limited tools = predictable behavior. From Spotify: "Giving the agent full terminal access was a mistake."

**Example MCP Tool Configuration:**
```yaml
allowed_tools:
  - Read          # File reading with path restrictions
  - Edit          # File editing with validation
  - Bash          # Allowlist: [rg, cat, head, tail, find, wc]
  - Git           # Allowlist: [status, diff, add, commit]

blocked_tools:
  - Write         # Too permissive (Edit is safer)
  - Shell         # No arbitrary commands

tool_constraints:
  Git:
    blocked_operations: [push, reset --hard, checkout ., clean -f]
  Bash:
    no_network: true
    timeout_seconds: 30
```

**Anti-pattern:** Starting permissive and restricting later. Start minimal and expand deliberately.

### Pattern 3: Context Engineering (Log Abstraction)
**What:** Summarize verbose outputs (build logs, test failures) before returning to agent. Don't dump raw logs.

**When:** Verification layer output formatting, tool result processing

**Why:** Raw logs exhaust context window and confuse the agent. Abstracted summaries preserve signal, remove noise.

**Example:**
```python
# Good: Abstracted
def summarize_test_failure(test_output: str) -> str:
    """Extract only relevant failure information"""
    return {
        "failed_tests": 3,
        "failures": [
            {
                "test": "testUserLogin",
                "error": "NullPointerException at UserService.java:42",
                "relevant_code": "...",
            }
        ],
        "suggestion": "The UserService expects a non-null email field"
    }

# Bad: Raw dump
def get_test_output(test_output: str) -> str:
    """Return 10,000 lines of Maven output"""
    return test_output  # Context window exhausted
```

**Anti-pattern:** Assuming "more information = better debugging." The agent can't process 10K line logs effectively.

### Pattern 4: Sandbox Everything
**What:** Run agent in isolated Docker container with no external network access, minimal binaries, read-only filesystem.

**When:** Agent execution environment design (foundational)

**Why:** Security boundary. Agent has LLM-level reasoning but shouldn't access production systems, credentials, or the host.

**Docker Configuration:**
```dockerfile
# Security hardening
FROM python:3.12-slim
RUN useradd -m -u 1000 agent
USER agent
WORKDIR /workspace

# Read-only root, writable workspace
VOLUME /workspace

# Minimal binaries
RUN apt-get update && apt-get install -y \
    git ripgrep curl \
    && rm -rf /var/lib/apt/lists/*

# No external network (docker-compose)
# networks:
#   internal:
#     internal: true
```

**Anti-pattern:** Running agent on host system with subprocess. Security boundary is too weak.

### Pattern 5: Turn Limits + Retry Budget
**What:** Cap agent sessions at ~10 turns. Cap retries at 3 attempts.

**When:** Orchestrator session management

**Why:** Prevents runaway costs and infinite loops. If agent can't solve in 10 turns, human intervention needed.

**Implementation:**
```python
class AgentSession:
    MAX_TURNS = 10
    MAX_RETRIES = 3

    async def run(self, task: Task) -> Result:
        for attempt in range(self.MAX_RETRIES):
            turns = 0
            while turns < self.MAX_TURNS:
                response = await self.agent.step()
                turns += 1

                if response.is_complete():
                    return await self.verify(response)

            # Turn limit exceeded
            if attempt < self.MAX_RETRIES - 1:
                await self.reset_with_feedback("Turn limit exceeded")

        # Retry budget exhausted
        return Result.failure("Unable to complete task")
```

**Anti-pattern:** No limits = unpredictable costs. One broken prompt could burn through API budget.

### Pattern 6: Verification Before PR
**What:** Two-stage verification: (1) Deterministic checks (build, test, lint), (2) LLM Judge for scope/quality.

**When:** After agent completes changes, before PR creation

**Why:** "Student driver with dual controls." Agent writes code, verification prevents bad changes from reaching humans.

**Verification Pipeline:**
```python
async def verify_changes(session: AgentSession) -> VerificationResult:
    # Stage 1: Deterministic (MUST PASS)
    build_result = await run_build(session.workspace)
    if not build_result.success:
        return VerificationResult.fail("Build failed", build_result.errors)

    test_result = await run_tests(session.workspace)
    if not test_result.success:
        return VerificationResult.fail("Tests failed", test_result.failures)

    lint_result = await run_linter(session.workspace)
    if lint_result.has_errors:
        return VerificationResult.fail("Lint errors", lint_result.errors)

    # Stage 2: LLM Judge (CAN VETO)
    diff = await session.get_diff()
    judge_result = await llm_judge.evaluate(
        original_prompt=session.task.prompt,
        changes=diff,
        criteria=["in_scope", "safe", "quality"]
    )

    if judge_result.veto:
        return VerificationResult.veto(judge_result.reason)

    return VerificationResult.approve()
```

**Expected veto rate:** ~25% is healthy. Too low = judge is too lenient. Too high = prompts need refinement.

**Anti-pattern:** Skipping verification to "move faster." This destroys trust in the system.

### Pattern 7: One Change Type Per Session
**What:** Each agent session tackles one task type (dependency update OR refactor OR migration, not multiple).

**When:** Task design and prompt structure

**Why:** Context exhaustion. Combining unrelated changes leads to confusion and scope creep.

**Example:**
```python
# Good: Focused
task = Task(
    type="dependency_update",
    target="com.example:library:1.0.0 -> 2.0.0",
    scope="Maven POM files only"
)

# Bad: Unfocused
task = Task(
    type="multiple",  # RED FLAG
    changes=[
        "Update library dependency",
        "Refactor UserService",
        "Fix linting issues"
    ]
)
```

**Anti-pattern:** Trying to maximize "efficiency" by combining tasks. This backfires when agent loses focus.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Dynamic Tool Fetching
**What:** Fetching tool definitions from external sources mid-session based on agent requests.

**Why bad:** Unpredictability, security risk, dependency on external services during critical operations.

**Consequences:** Agent behavior becomes non-deterministic. Debugging is impossible. Security auditing fails.

**Instead:** Define static tool manifests at build time. Version them with code. Tools are part of the platform, not runtime dependencies.

### Anti-Pattern 2: Full Terminal Access
**What:** Giving agent unrestricted shell access via MCP.

**Why bad:** Agent can execute arbitrary commands, install packages, modify system, spawn processes. Unpredictable and unsafe.

**Consequences:** From Spotify: "Giving the agent full terminal access was a mistake." Leads to surprising behaviors that break production.

**Instead:** Use allowlist-based Bash tool with specific commands only (rg, cat, head, tail, find, wc). No package managers, no network tools.

### Anti-Pattern 3: No Observability
**What:** Running agent sessions without trace collection, metrics, or session logs.

**Why bad:** When things go wrong (and they will), you have no data to debug. Can't measure improvement over time.

**Consequences:** Black box system. Can't answer "why did this fail?" or "is the system getting better?"

**Instead:** Track everything via MLflow or equivalent:
- Full conversation history
- Tool invocation history
- Verification results
- Veto reasons from LLM Judge
- Time metrics, cost metrics
- Merge rate, veto rate

### Anti-Pattern 4: Step-by-Step Prompting
**What:** Giving agent detailed procedural instructions instead of desired outcomes.

**Why bad:** Brittle when unexpected situations arise. Agent can't adapt its approach.

**Consequences:** Agent follows steps blindly even when they don't make sense. Loses ability to reason about the task.

**Instead:** Use end-state prompting. Describe what success looks like, not how to achieve it.

### Anti-Pattern 5: Running on Host System
**What:** Executing agent via subprocess or direct Python import without containerization.

**Why bad:** No security boundary. Agent can access host filesystem, network, credentials. Blast radius is entire system.

**Consequences:** If agent goes rogue or is compromised, entire host is at risk.

**Instead:** Docker sandbox with network isolation, read-only filesystem, non-root user. Mandatory.

### Anti-Pattern 6: Skipping Verification for "Simple" Changes
**What:** Creating PRs directly for tasks deemed "low risk" without verification.

**Why bad:** Destroys trust model. No change is truly zero-risk. Inconsistent quality.

**Consequences:** One bad "simple" change makes humans distrust all agent output.

**Instead:** Verification is non-negotiable. It's the foundation of trust. Never skip it.

## Component Build Order

The architecture has clear dependency relationships that dictate build order:

### Phase 1: Foundation (Build First)
**Components:** Sandbox + Orchestrator skeleton
**Rationale:** Must establish security boundary before anything else. Orchestrator manages everything else.
**Deliverable:** Docker container runs, agent can be spawned and monitored.

### Phase 2: Agent Engine Integration
**Components:** Claude SDK integration, MCP client
**Rationale:** Need working agent before we can test tools or verification.
**Deliverable:** Agent can execute simple tasks with Read/Edit tools.

### Phase 3: Tool Layer
**Components:** MCP tool servers (Read, Edit, Git, Bash with allowlists)
**Rationale:** Agent needs tools to accomplish tasks. Build incrementally: Read → Edit → Git → Bash.
**Deliverable:** Agent can explore codebase, make changes, commit.

### Phase 4: Verification Loop
**Components:** Deterministic verifiers (build, test, lint) + LLM Judge
**Rationale:** Can't create PRs without verification. This is the trust boundary.
**Deliverable:** Changes are verified before PR creation.

### Phase 5: PR Integration
**Components:** GitHub API integration, PR templates
**Rationale:** Output mechanism. Depends on verification passing first.
**Deliverable:** Approved changes become PRs automatically.

### Phase 6: Task Implementation
**Components:** Specific task prompts (e.g., Maven dependency updater)
**Rationale:** Proves the architecture works end-to-end.
**Deliverable:** One working task type (dependency updates).

### Phase 7: Observability
**Components:** MLflow integration, metrics dashboard, session replay
**Rationale:** Production-ready system needs observability for debugging and improvement.
**Deliverable:** Can debug failed sessions, track metrics over time.

## Scalability Considerations

| Concern | Single Repo | Multi-Repo Fleet | Production Scale |
|---------|-------------|------------------|------------------|
| **Concurrency** | Sequential CLI runs | Job queue (Celery/BullMQ) | Distributed workers with rate limiting |
| **Session State** | In-memory | Redis/PostgreSQL | Distributed state store with TTL |
| **Trace Storage** | Local MLflow | Centralized MLflow server | S3/GCS + query layer |
| **Cost Control** | Per-session limits | Global budget tracking | Org-level quotas, priority queues |
| **PR Volume** | Manual review | Review assignment system | Auto-merge for verified low-risk changes |

## Architecture Decisions

### Decision 1: MCP vs Direct Tool Implementation
**Recommendation:** Use MCP Protocol

**Rationale:**
- **Standardization:** MCP is Anthropic's official standard for tool integration
- **Ecosystem:** Growing library of MCP servers (filesystem, git, databases)
- **Future-proof:** As MCP ecosystem grows, can add new tools without architecture changes
- **Built-in safety:** MCP's request/response structure enables allowlisting naturally

**Tradeoffs:**
- Additional layer of abstraction vs direct Python functions
- Need to run MCP servers alongside agent
- But: Cleaner separation of concerns, easier to test tools in isolation

### Decision 2: Claude Agent SDK vs Raw API
**Recommendation:** Use Claude Agent SDK (not raw Messages API)

**Rationale:**
- **Agentic Loop:** SDK provides `beta.messages.tool_runner` which handles tool use loop automatically
- **Type Safety:** Pydantic models for requests/responses reduce bugs
- **Streaming:** Built-in streaming support for responsiveness
- **Tool Helpers:** `@beta_tool` decorator simplifies tool definition

**Tradeoffs:**
- SDK is higher abstraction = less control over individual requests
- Beta APIs may change
- But: Significantly less boilerplate, focus on business logic not protocol

### Decision 3: Docker vs Process Isolation
**Recommendation:** Docker (non-negotiable)

**Rationale:**
- **Security:** Network isolation, filesystem isolation, non-root user enforcement
- **Reproducibility:** Consistent environment across dev/prod
- **Resource limits:** Can set memory/CPU limits per container
- **Cleanup:** Containers can be destroyed after use, no lingering state

**Tradeoffs:**
- Overhead of container startup (~1-2 seconds)
- Requires Docker/Podman on host
- But: Security boundary is non-negotiable

### Decision 4: Synchronous vs Async Orchestrator
**Recommendation:** Start Synchronous (CLI), evolve to Async (Queue)

**Rationale:**
- **MVP:** CLI with synchronous execution proves architecture works
- **Production:** Async job queue (Celery/BullMQ) enables concurrency and retries
- **Migration path:** Orchestrator code can be same, execution model changes

**Architecture allows:**
```python
# MVP: Synchronous CLI
def main():
    task = parse_cli_args()
    result = orchestrator.run_sync(task)
    print(result)

# Production: Async Queue
@celery.task
def process_task(task_id: str):
    task = load_task(task_id)
    result = await orchestrator.run_async(task)
    store_result(result)
```

## Confidence Assessment

| Aspect | Confidence | Source |
|--------|------------|--------|
| Layered "Sandwich" Architecture | HIGH | Spotify blog posts (BRIEF.md references), production-proven pattern |
| MCP Tool Layer Design | HIGH | Official MCP documentation (modelcontextprotocol.io) |
| Claude SDK Patterns | HIGH | Official Anthropic SDK documentation (github.com/anthropics/anthropic-sdk-python) |
| Verification Loop Pattern | MEDIUM-HIGH | Spotify blog posts + industry practice (test-before-commit is standard) |
| Docker Security Patterns | HIGH | Standard containerization best practices |
| LLM Judge Design | MEDIUM | Spotify blog (25% veto rate), but implementation details light |
| End-State Prompting | HIGH | Spotify blog explicitly recommends this pattern |
| Turn Limits | MEDIUM | Spotify mentions ~10 turns, but exact tuning is project-specific |

## Open Questions for Phase-Specific Research

1. **LLM Judge Implementation:** What specific criteria should Judge evaluate? How to structure Judge prompts? Need to experiment.

2. **Tool Allowlist Granularity:** How restrictive should Git tool be? (e.g., allow `git diff` but block `git diff --staged`?)

3. **Context Window Management:** What's the right balance of repo context vs conversation history? May need prompt compression.

4. **Retry Strategy:** Should retries use same model or fall back to Opus? Cost vs capability tradeoff.

5. **Multi-File Changes:** How to handle changes that span many files? Batch edits or incremental?

These questions are expected at this stage. Phase-specific research will address them as implementation progresses.

## Sources

**HIGH Confidence (Official Documentation):**
- Anthropic Python SDK: https://github.com/anthropics/anthropic-sdk-python (Agent SDK patterns, tool runner, streaming)
- MCP Architecture: https://modelcontextprotocol.io/docs/learn/architecture (Protocol design, client-server model)
- MCP Introduction: https://modelcontextprotocol.io/introduction (Core concepts, tool integration)

**MEDIUM Confidence (Project Artifacts):**
- BRIEF.md: Spotify background coding agent architecture, learnings, best practices
- PROJECT.md: Project requirements and constraints

**LOW Confidence (Inferred):**
- Exact LLM Judge implementation (not detailed in sources)
- Turn limit tuning (Spotify mentioned ~10, but context-dependent)

## Build Order Summary

```
1. Sandbox + Orchestrator → Security boundary established
2. Agent Engine (SDK) → Agentic reasoning available
3. Tool Layer (MCP) → Agent can accomplish tasks
4. Verification Loop → Trust boundary enforced
5. PR Integration → Output mechanism complete
6. Task Implementation → End-to-end validation
7. Observability → Production readiness
```

Each phase builds on previous phases. No skipping allowed.
