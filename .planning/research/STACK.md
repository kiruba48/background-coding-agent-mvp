# Technology Stack

**Project:** Background Coding Agent Platform
**Researched:** 2026-01-26
**Overall Confidence:** MEDIUM (Anthropic SDK verified, other components based on training data)

## Recommended Stack

### Core Agent Framework

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| anthropic | latest (>=0.40.0) | Claude API client | **HIGH confidence.** Official SDK with native tool use, streaming, async support. Verified active development (2.7k stars). Supports Python 3.9+. Avoid raw API calls - SDK provides type safety, error handling, streaming helpers. |
| pydantic | >=2.0 | Data validation & settings | **MEDIUM confidence.** Industry standard for API response models, configuration validation. V2 brings major performance improvements. Anthropic SDK uses Pydantic response models. |

**Rationale:** Use Anthropic SDK directly, NOT wrapper frameworks. Wrappers add abstraction overhead and lag behind SDK updates. For background agents, you need:
- Control over conversation flow (SDK messages API)
- Tool execution control (SDK beta.messages.tool_runner)
- Token counting (SDK count_tokens) for cost control
- Async support (AsyncAnthropic) for concurrent operations

### Container Orchestration

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| docker | >=7.0.0 | Python Docker SDK | **MEDIUM confidence.** Official Docker SDK for Python. Provides programmatic container lifecycle management (create, start, stop, remove, logs). Required for isolated execution environments. |
| python-on-whales | >=0.70.0 | High-level Docker wrapper | **LOW confidence.** Alternative to docker-py with better API ergonomics. Consider if docker-py API is too verbose. Needs verification for stability. |

**Rationale:** Use `docker` SDK (docker-py), not subprocess calls to docker CLI. SDK provides:
- Container lifecycle management
- Volume mounting for code injection
- Network isolation
- Log streaming
- Resource limits (memory, CPU)

**Critical:** Don't use Docker-in-Docker. Run agent outside containers, spawn work containers.

### CLI Framework

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| typer | >=0.12.0 | CLI interface | **MEDIUM confidence.** Modern CLI framework built on Click with type hints. Better DX than Click or argparse. Auto-generates help text from type annotations. FastAPI-like syntax (same author). |
| rich | >=13.0.0 | Terminal formatting | **MEDIUM confidence.** Rich text and beautiful formatting in terminal. Progress bars for long operations, syntax highlighting for code diffs, tables for results. Pairs well with Typer. |

**Rationale:** Use Typer, not Click or argparse:
- **Typer over Click:** Type hints > decorators. Async command support. Better parameter validation.
- **Typer over argparse:** Less boilerplate, auto-completion, better help text.
- **Rich for output:** Agent operations are long-running - users need progress feedback, not silent execution.

### Configuration Management

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| pydantic-settings | >=2.0 | Environment config | **MEDIUM confidence.** Load config from env vars, .env files, with type validation. Part of Pydantic V2. Prevents runtime errors from misconfiguration. |
| python-dotenv | >=1.0.0 | .env file loading | **MEDIUM confidence.** Development convenience for local environment variables. Standard in Python ecosystem. |

**Rationale:** Use Pydantic Settings for all configuration:
- Type-safe config loading
- Validation at startup (fail fast)
- Multiple sources (env vars, .env, defaults)
- Auto-documentation of required config

### Observability & Tracking

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| structlog | >=24.0.0 | Structured logging | **MEDIUM confidence.** JSON-structured logs with context. Better than stdlib logging for debugging agent behavior. Machine-parseable for log aggregation. |
| prometheus-client | >=0.20.0 | Metrics collection | **LOW confidence.** If metrics needed. Standard for operational metrics (success rate, execution time, cost). May be overkill for MVP. |
| anthropic native tracking | built-in | Token usage, costs | **HIGH confidence.** Anthropic SDK includes token counting. Track per-operation, not just total. Critical for cost control with background agents. |

**Rationale:** Skip MLflow/LangSmith for MVP:
- **MLflow:** Overkill for non-ML model experimentation. You're not training models, just orchestrating Claude.
- **LangSmith:** Useful for debugging chains, but adds complexity. Use structured logs first.
- **Start simple:** structlog + Anthropic's token counting. Add experiment tracking later if needed.

**Critical tracking needs:**
- Tokens per operation (Anthropic SDK)
- Success/failure rate per change type
- Cost per change (tokens × pricing)
- Execution time (stdlib time)

### Testing

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| pytest | >=8.0.0 | Test runner | **MEDIUM confidence.** Industry standard. Excellent plugin ecosystem (pytest-asyncio, pytest-docker, pytest-mock). |
| pytest-asyncio | >=0.23.0 | Async test support | **MEDIUM confidence.** Required for testing AsyncAnthropic client and async container operations. |
| pytest-docker | >=3.0.0 | Docker fixtures | **LOW confidence.** Provides Docker container fixtures for integration tests. Verify stability. |
| respx | >=0.21.0 | HTTP mocking | **MEDIUM confidence.** Mock Anthropic API calls in unit tests. Built on httpx (what Anthropic SDK uses). Better than responses library for async. |
| testcontainers-python | >=4.0.0 | Integration testing | **LOW confidence.** Alternative to pytest-docker for spinning up real containers in tests. More feature-rich but heavier. |

**Rationale:** Testing strategy for agent platforms:
1. **Unit tests:** Mock Anthropic API (respx), test logic without containers
2. **Integration tests:** Real Docker containers, mocked Anthropic API
3. **E2E tests:** Real containers + real Anthropic API (expensive, run sparingly)

**Don't test:**
- Claude's correctness (trust the model)
- Docker's reliability (trust the platform)

**Do test:**
- Your prompt construction
- Tool execution logic
- Container lifecycle management
- Verification loop logic

### Version Control & Git

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| gitpython | >=3.1.0 | Git operations | **MEDIUM confidence.** Programmatic Git operations (clone, checkout, commit, push). More reliable than subprocess git commands. Required for PR creation workflow. |
| PyGithub | >=2.0.0 | GitHub API client | **MEDIUM confidence.** Create PRs, add comments, manage labels. Official Python client for GitHub API. Alternative: gh CLI via subprocess. |

**Rationale:** Use GitPython for local operations, PyGithub for GitHub API:
- Clone repo into container
- Make changes
- Commit with verified changes
- Push to branch
- Create PR via GitHub API

**Alternative:** gh CLI via subprocess. Simpler but less control, harder to test.

### Development Tools

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| ruff | >=0.6.0 | Linting & formatting | **MEDIUM confidence.** Replaces Black, isort, flake8. 10-100x faster than existing tools. Written in Rust. Increasingly standard in Python projects. |
| mypy | >=1.11.0 | Type checking | **MEDIUM confidence.** Static type checking. Critical for agent platforms where runtime errors are expensive (API calls cost money). |
| pre-commit | >=3.0.0 | Git hooks | **MEDIUM confidence.** Run ruff + mypy before commits. Prevents broken code from entering history. |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Agent Framework | Raw Anthropic SDK | LangChain | **MEDIUM confidence.** LangChain adds abstraction overhead, frequent breaking changes, opinionated patterns. You need control over conversation flow for verification loops. Direct SDK is simpler and more maintainable. |
| Agent Framework | Raw Anthropic SDK | LlamaIndex | **MEDIUM confidence.** LlamaIndex optimized for RAG, not agentic workflows. Doesn't fit coding agent use case. |
| Agent Framework | Raw Anthropic SDK | CrewAI / AutoGPT | **LOW confidence.** Multi-agent frameworks are overkill. You need single agent with verification, not agent swarms. |
| CLI Framework | Typer | Click | Click is mature but more verbose. Typer provides better DX with type hints. Same maintainer as FastAPI. |
| CLI Framework | Typer | argparse | Too much boilerplate. No auto-completion. Manual help text. Typer automates this. |
| Docker Control | docker SDK | subprocess docker CLI | Subprocess is brittle (parsing output), harder to test, no type safety. SDK provides programmatic control. |
| Observability | structlog + token tracking | MLflow | MLflow is for ML experiment tracking. You're not tuning models, just orchestrating API calls. Overkill. |
| Observability | structlog + token tracking | LangSmith | Useful for debugging chains but adds complexity and cost. Start simple with logs. |
| Observability | structlog + token tracking | Weights & Biases | ML experiment tracking. Not needed for API orchestration. |
| Testing | pytest + respx | unittest + responses | pytest has better fixtures, plugin ecosystem. respx handles async better than responses. |
| Git Operations | GitPython | subprocess git | GitPython more reliable, testable. subprocess brittle (output parsing). |
| GitHub API | PyGithub | gh CLI subprocess | PyGithub more testable, better error handling. gh CLI simpler but harder to mock in tests. |

## Anti-Patterns to Avoid

### 1. LangChain / Agent Framework Wrappers
**Why:** Abstraction overhead, frequent breaking changes, opinionated patterns that conflict with verification loop requirements.
**Instead:** Use Anthropic SDK directly. Build thin abstractions only where needed.

### 2. Docker-in-Docker
**Why:** Security risks, complexity, nested container issues.
**Instead:** Run agent outside containers, spawn work containers via Docker SDK.

### 3. Synchronous-only code
**Why:** Background agents need concurrency (multiple repos, parallel verifiers).
**Instead:** Use AsyncAnthropic, asyncio for I/O-bound operations.

### 4. Missing token tracking
**Why:** Costs can explode with background agents running frequently.
**Instead:** Track tokens per operation using Anthropic SDK's count_tokens. Set budgets.

### 5. subprocess.run() for git/docker
**Why:** Brittle (output parsing), hard to test, no type safety.
**Instead:** Use GitPython and docker SDK.

## Installation

```bash
# Core dependencies
pip install anthropic>=0.40.0 pydantic>=2.0 pydantic-settings>=2.0

# Container orchestration
pip install docker>=7.0.0

# CLI
pip install typer>=0.12.0 rich>=13.0.0

# Configuration
pip install python-dotenv>=1.0.0

# Observability
pip install structlog>=24.0.0

# Version control
pip install gitpython>=3.1.0 PyGithub>=2.0.0

# Development
pip install ruff>=0.6.0 mypy>=1.11.0 pre-commit>=3.0.0

# Testing
pip install pytest>=8.0.0 pytest-asyncio>=0.23.0 respx>=0.21.0
```

## Python Version

**Minimum:** Python 3.9 (Anthropic SDK requirement)
**Recommended:** Python 3.11 or 3.12

**Why 3.11/3.12:**
- Better async performance
- Improved error messages
- typing improvements (Self, TypeVarTuple)
- 3.11 has 10-60% performance improvements over 3.10

## Architecture Implications

This stack supports:

1. **Isolated execution:** Docker SDK for container lifecycle
2. **Cost control:** Anthropic token counting, configurable limits
3. **Async operations:** AsyncAnthropic for concurrent repo processing
4. **Type safety:** Pydantic, mypy for catching errors before runtime
5. **Observability:** structlog for debugging agent behavior
6. **CLI-first:** Typer for intuitive command interface
7. **Testability:** pytest + respx for mocking, pytest-docker for integration tests

## Confidence Assessment

| Component | Confidence | Source | Notes |
|-----------|------------|--------|-------|
| Anthropic SDK | HIGH | GitHub verified | Confirmed version, features, API |
| Pydantic | HIGH | Training data | Industry standard, stable V2 |
| docker SDK | MEDIUM | Training data | Standard but couldn't verify latest version |
| Typer | MEDIUM | Training data | Stable library but version unverified |
| Rich | MEDIUM | Training data | Well-established but version unverified |
| structlog | MEDIUM | Training data | Known library but version unverified |
| pytest ecosystem | MEDIUM | Training data | Standard tools but versions unverified |
| GitPython / PyGithub | MEDIUM | Training data | Established but versions unverified |
| prometheus-client | LOW | Training data | Not critical for MVP, may not be needed |
| python-on-whales | LOW | Training data | Alternative to docker-py, needs validation |
| testcontainers-python | LOW | Training data | Integration testing option, needs validation |

## Version Verification Needed

The following should be verified against official sources before finalizing:
- docker SDK current version (listed >=7.0.0 from training)
- Typer current version (listed >=0.12.0 from training)
- pytest current version (listed >=8.0.0 from training)
- All other non-Anthropic dependencies

**Action:** Run `pip index versions <package>` to confirm latest stable versions before implementation.

## Sources

- **HIGH confidence:** Anthropic SDK - https://github.com/anthropics/anthropic-sdk-python (verified 2026-01-26)
- **MEDIUM confidence:** Other libraries based on training data (January 2025 cutoff)
- **Verification needed:** Run version checks against PyPI before implementation

## Notes for Roadmap

1. **Phase 1 (MVP):** Focus on Anthropic SDK + docker + basic CLI (Typer) + structlog. Skip observability beyond logging.
2. **Phase 2:** Add comprehensive testing (pytest suite with respx mocking)
3. **Phase 3:** Add Git operations (GitPython) and PR creation (PyGithub)
4. **Phase 4:** Add advanced observability (metrics, cost tracking dashboard)

**Critical path:** Anthropic SDK → Docker SDK → Typer CLI → GitPython/PyGithub
**Optional/later:** prometheus-client, advanced testing tools
