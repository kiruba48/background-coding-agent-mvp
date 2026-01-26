# Research Summary: Background Coding Agent Platform

**Domain:** AI-driven software maintenance automation
**Researched:** 2026-01-26
**Overall confidence:** MEDIUM-HIGH
- Stack recommendations: HIGH (Anthropic SDK verified)
- Architecture patterns: MEDIUM-HIGH (Spotify learnings + MCP verified)
- Features & Pitfalls: MEDIUM (training data + project context)

## Executive Summary

Background coding agent platforms represent a new category of software automation that combines LLM reasoning with deterministic verification. The architecture that has emerged from production systems (Spotify) and standardization efforts (MCP) follows a clear pattern: **controlled autonomy through layered verification**.

The technology landscape in 2026 favors:
1. **Direct SDK integration** over agent frameworks (LangChain, etc.)
2. **MCP tooling standard** for agent-tool communication
3. **Docker-based isolation** as non-negotiable security boundary
4. **Structured logging** over experiment tracking platforms (MLflow overkill)
5. **Type-safe Python** with async-first architecture

The key architectural insight from Spotify: **"Student driver with dual controls"** - the agent writes code, but verification layers (deterministic + LLM Judge) prevent bad changes from reaching production. This pattern, combined with turn limits, tool allowlists, and context engineering, makes agentic automation trustworthy.

**Critical success factors:**
- Verification loop is non-negotiable (build/test/lint + LLM Judge)
- Turn limits (~10) prevent cost runaway
- One change type per session prevents context exhaustion
- Human review remains essential (no auto-merge)

## Key Findings

**Stack:** Use Anthropic SDK directly with AsyncAnthropic, Docker SDK for containers, Typer CLI framework, and structlog for observability. Skip LangChain/MLflow - too much abstraction for this use case.

**Architecture:** Four-layer "sandwich" - Orchestrator → Agent Engine (Claude SDK) → Tool Layer (MCP) → Verification. Each layer has clear boundaries and minimal coupling.

**Critical pitfall:** Unbounded tool access is the #1 failure mode. Limited toolset (Read, Edit, Git-allowlist, Bash-restricted) is what makes agents predictable. Spotify learned this the hard way.

## Implications for Roadmap

Based on research, suggested phase structure aligns well with BRIEF.md, with stack-specific refinements:

### Phase 1: Foundation (3-5 days) - CRITICAL PATH
**Focus:** Security boundary + SDK integration

**Stack decisions:**
- **Docker**: Official `docker` SDK (>=7.0.0), not subprocess calls
- **Anthropic SDK**: AsyncAnthropic client with beta.messages.tool_runner
- **Logging**: structlog for structured JSON logs (NOT MLflow yet - overkill for Phase 1)
- **Config**: pydantic-settings for type-safe environment config

**Why this order:** Security boundary (Docker) must exist before any agent code runs. SDK integration proves connectivity.

**Addresses:**
- Sandbox isolation (PITFALLS: #4 Sandbox Escape)
- Secure configuration (PITFALLS: #12 Credential Leakage)

**Avoids:**
- Running agent on host (anti-pattern from ARCHITECTURE.md)
- Subprocess docker CLI calls (brittle, hard to test)

### Phase 2: CLI + Orchestrator (5-7 days) - ARCHITECTURE FOUNDATION
**Focus:** Session management + prompt templates

**Stack decisions:**
- **CLI**: Typer (>=0.12.0) + Rich for terminal output (NOT Click from BRIEF - Typer better DX)
- **Session limits**: Hard-coded turn limit (10), timeout (5min), retry budget (3)
- **Prompts**: End-state templates (NOT step-by-step)

**Why this order:** Orchestrator manages everything else. Must establish turn limits NOW or cost runaway will happen.

**Addresses:**
- Cost control (PITFALLS: #3 Cost Runaway)
- End-state prompting (PITFALLS: #8 Step-by-Step)

**Avoids:**
- Unbounded agent loops
- Click's decorator-heavy syntax (Typer's type hints cleaner)

### Phase 3: MCP Tools (5-7 days) - CONTROL LAYER
**Focus:** Limited, safe tool access

**Stack decisions:**
- **MCP Client**: Part of Anthropic SDK (beta.messages.tool_runner)
- **Tool allowlist**: Read, Edit, Git (status/diff/add/commit only), Bash (rg/cat/head/tail/find only)
- **Output summarization**: Custom verification wrappers (don't dump raw logs)

**Why this order:** Tools are useless without orchestrator. Must be minimal or agent becomes unpredictable.

**Addresses:**
- Tool access control (PITFALLS: #1 Unbounded Tool Access)
- Context engineering (PITFALLS: #10 Log Dumping)

**Avoids:**
- Full terminal access (Spotify mistake)
- Dynamic tool fetching (PITFALLS: #9)

### Phase 4: Verification Loop (5-7 days) - TRUST BOUNDARY
**Focus:** Deterministic checks + LLM Judge

**Stack decisions:**
- **Build detection**: Auto-detect Maven vs npm via file presence
- **Verifiers**: Subprocess to build tools (mvn, npm), parse output
- **LLM Judge**: Second Claude call with diff + original prompt
- **Target veto rate**: ~25% (Spotify finding)

**Why this order:** Must have working tools before verification can test changes. This is THE critical phase.

**Addresses:**
- Quality gate (PITFALLS: #2 Verification Theater)
- Scope creep detection (FEATURES: LLM Judge differentiator)

**Avoids:**
- Skipping verification for "simple" changes (anti-pattern)
- Verification that doesn't actually catch bad changes

### Phase 5: PR Integration (3-5 days) - OUTPUT MECHANISM
**Focus:** GitHub API + PR templates

**Stack decisions:**
- **Git operations**: GitPython (>=3.1.0) for local ops
- **GitHub API**: PyGithub (>=2.0.0) for PR creation (NOT gh CLI - harder to test)
- **PR template**: Standardized with metadata (agent session ID, verification results)

**Why this order:** PR creation depends on verification passing. Simple GitHub API integration.

**Addresses:**
- Human review loop (FEATURES: Table stakes)
- PR visibility (FEATURES: Table stakes)

**Avoids:**
- Auto-merge (PITFALLS: #13 Over-Automation)
- Missing context in PRs

### Phase 6: MVP Use Case (5-7 days) - VALUE VALIDATION
**Focus:** Maven + npm dependency bumpers

**Stack decisions:**
- **Maven**: Parse pom.xml, run mvn commands, handle multi-module
- **npm**: Parse package.json, handle lockfiles, peer dependencies
- **Prompt templates**: End-state ("Update X to Y, ensure tests pass")

**Why this order:** Proves entire stack works end-to-end. Real value delivery.

**Addresses:**
- Concrete use case (FEATURES: Dependency updates table stakes)
- Breaking change handling (FEATURES: Differentiator)

**Avoids:**
- Prompt injection from dependency docs (PITFALLS: #5)
- Version constraint violations (PITFALLS: #16)

### Phase 7: Observability (3-5 days) - PRODUCTION READINESS
**Focus:** Metrics, session replay, debugging

**Stack decisions:**
- **Keep structlog**: Already in place, sufficient
- **Add metrics**: Track merge rate, veto rate, cost per run
- **Session storage**: Store full conversation + tool history for replay
- **SKIP MLflow**: Overkill for this use case (see STACK.md rationale)

**Why this order:** Need MVP working before optimizing observability. But needed before scale.

**Addresses:**
- Debugging capability (PITFALLS: #17 Silent Failures)
- Metric tracking (FEATURES: Cost Dashboard, Observability)

**Avoids:**
- MLflow complexity (STACK: Anti-pattern for non-ML)
- Black box system (ARCHITECTURE: Anti-pattern #3)

### Phase 8: Testing & Docs (5-7 days) - PRODUCTION HARDENING
**Focus:** Comprehensive test suite + documentation

**Stack decisions:**
- **pytest** (>=8.0.0) + pytest-asyncio for async tests
- **respx** (>=0.21.0) for mocking Anthropic API calls
- **pytest-docker** or testcontainers for integration tests
- **Test strategy**: Unit (mock API) → Integration (real Docker) → E2E (real API, sparingly)

**Why this order:** Last phase ensures system is production-ready and maintainable.

**Addresses:**
- Test coverage (PITFALLS: #6 False Positives)
- Flaky test handling (PITFALLS: #18)

**Avoids:**
- Testing Claude's correctness (trust the model)
- Untestable subprocess calls (why we use SDKs)

## Phase Ordering Rationale

**Sequential dependencies:**
```
Foundation (Docker + SDK)
    ↓ [Must have security boundary first]
CLI + Orchestrator (Session management)
    ↓ [Must manage sessions before spawning agents]
MCP Tools (Limited tool access)
    ↓ [Must have tools before verification can test them]
Verification Loop (Build/test + LLM Judge)
    ↓ [Must verify before creating PRs]
PR Integration (GitHub API)
    ↓ [Must have output mechanism before use cases]
MVP Use Case (Dependency bumpers)
    ↓ [Must prove value before optimizing]
Observability (Metrics, replay)
    ↓ [Must have data before scaling]
Testing & Docs (Production hardening)
```

**Critical path:** Foundation → CLI → Tools → Verification (Phases 1-4)
- These MUST be done in order
- Each phase depends on previous
- Shortcuts here create technical debt or security issues

**Value delivery:** Phases 5-6 (PR Integration + MVP Use Case)
- Can iterate quickly once foundation solid
- This is where user value appears

**Production readiness:** Phases 7-8 (Observability + Testing)
- Can be done in parallel with new feature work
- Critical before fleet-wide deployment

**DO NOT:** Try to parallelize foundation phases. Security shortcuts compound.

## Research Flags for Phases

**Phase 1: Foundation** - Standard patterns, unlikely to need additional research
- Docker security best practices are well-established
- Anthropic SDK documentation is comprehensive

**Phase 2: CLI + Orchestrator** - Standard patterns, but monitor Spotify blog for new insights
- End-state prompting examples may need experimentation
- Turn limit tuning is project-specific (start with 10)

**Phase 3: MCP Tools** - Likely needs deeper research
- **FLAG:** MCP ecosystem evolving. Check modelcontextprotocol.io for updated tool servers
- **FLAG:** Output summarization strategies need experimentation (how much to abstract?)
- **FLAG:** Bash allowlist - may need to expand based on build systems encountered

**Phase 4: Verification Loop** - Likely needs MUCH deeper research
- **FLAG:** LLM Judge prompt engineering is critical and under-documented
- **FLAG:** Target veto rate (25%) needs calibration per use case
- **FLAG:** Build system auto-detection may require heuristics research
- **FLAG:** Breaking change detection requires semantic diff analysis (very hard)

**Phase 5: PR Integration** - Standard patterns, unlikely to need research
- GitHub API well-documented
- GitPython mature library

**Phase 6: MVP Use Case** - Moderate research needs
- **FLAG:** Dependency version constraints (semver, peer deps) need research
- **FLAG:** Prompt injection defenses need threat modeling
- **FLAG:** Maven multi-module projects may have edge cases

**Phase 7: Observability** - Standard patterns, but consider alternatives
- **FLAG:** Verify MLflow truly not needed (may reconsider if debugging is painful)
- **FLAG:** Research session replay storage strategies (S3, local, PostgreSQL?)

**Phase 8: Testing & Docs** - Standard patterns
- pytest ecosystem well-established

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| **Stack** | **HIGH** | Anthropic SDK verified from GitHub. Other libraries from training data but versions need checking. |
| **Agent Framework Choice** | **HIGH** | Direct SDK > LangChain is clear from Spotify learnings + training data. |
| **CLI Framework** | **MEDIUM** | Typer recommendation strong (type hints, async), but BRIEF suggests Click. Worth the upgrade. |
| **Container Stack** | **MEDIUM** | Docker SDK standard, but version >=7.0.0 needs PyPI verification. |
| **Observability** | **MEDIUM-HIGH** | Skip MLflow is correct call, but needs validation in Phase 7. |
| **Testing Stack** | **MEDIUM** | pytest ecosystem standard, but pytest-docker vs testcontainers needs evaluation. |
| **Features** | **MEDIUM** | Based on Spotify learnings + training data. Table stakes clear, differentiators need validation. |
| **Architecture** | **MEDIUM-HIGH** | Layered "sandwich" pattern verified from Spotify + MCP docs. Clear best practice. |
| **Pitfalls** | **MEDIUM** | Top pitfalls (tool access, verification, cost) HIGH confidence from Spotify. Others from training data. |

## Gaps to Address

### Immediate Gaps (Before Phase 1)

1. **Version verification needed:**
   - Run `pip index versions docker` to confirm >=7.0.0 is correct
   - Run `pip index versions typer` to confirm >=0.12.0 is correct
   - Run `pip index versions pytest` to confirm >=8.0.0 is correct
   - All other non-Anthropic dependencies need version checks

2. **Docker security checklist:**
   - Verify non-root user pattern for Python containers
   - Confirm network isolation flags (--network none)
   - Review AppArmor/SELinux requirements

3. **MCP tooling research:**
   - Check modelcontextprotocol.io for current tool server implementations
   - Verify MCP client integration patterns with Anthropic SDK

### Phase-Specific Gaps

**Phase 3 (MCP Tools):**
- Research output summarization strategies (what level of detail?)
- Build allowlist of safe Bash commands (beyond rg/cat/head/tail/find)
- Edge cases for Git tool restrictions

**Phase 4 (Verification Loop):**
- **CRITICAL:** LLM Judge prompt engineering
  - What criteria to evaluate? (in_scope, safe, quality)
  - How to calibrate veto rate to target 25%?
  - How to handle Judge disagreeing with deterministic verifiers?
- Breaking change detection patterns (if attempting advanced feature)

**Phase 6 (MVP Use Case):**
- Dependency version constraint parsing (semver, ^, ~, exact)
- Prompt injection attack surface (dependency docs, error messages)
- Maven multi-module project patterns

**Phase 7 (Observability):**
- Session replay storage strategy (filesystem, S3, database?)
- Metrics dashboard technology (Grafana, custom, etc.)
- Consider LangSmith or similar if structured logs insufficient

### Research Methodology Limitations

**Tools unavailable during research:**
- WebSearch blocked (couldn't verify 2026 ecosystem trends)
- WebFetch mostly blocked (couldn't access official docs beyond Anthropic)
- Context7 not applicable to non-library research

**Impact on confidence:**
- Stack recommendations: MEDIUM confidence for non-Anthropic libraries (versions from training data)
- Features/Pitfalls: MEDIUM confidence (based on Spotify learnings + training data, not verified externally)
- Architecture: MEDIUM-HIGH confidence (Spotify + MCP docs accessible)

**Mitigation:**
- Verify versions against PyPI before implementation (Phase 0)
- Cross-reference Spotify blog posts directly (links in BRIEF.md)
- Check MCP documentation for updates (modelcontextprotocol.io)
- Monitor Anthropic SDK changelog for beta API changes

## Stack Summary for Quick Reference

### Core (Must Have - Phase 1)
```bash
pip install anthropic>=0.40.0          # HIGH confidence
pip install docker>=7.0.0              # MEDIUM confidence - verify version
pip install pydantic>=2.0              # HIGH confidence
pip install pydantic-settings>=2.0     # HIGH confidence
pip install structlog>=24.0.0          # MEDIUM confidence
pip install python-dotenv>=1.0.0       # MEDIUM confidence
```

### CLI (Phase 2)
```bash
pip install typer>=0.12.0              # MEDIUM confidence - verify version
pip install rich>=13.0.0               # MEDIUM confidence
```

### Git Operations (Phase 5)
```bash
pip install gitpython>=3.1.0           # MEDIUM confidence
pip install PyGithub>=2.0.0            # MEDIUM confidence
```

### Testing (Phase 8)
```bash
pip install pytest>=8.0.0              # MEDIUM confidence - verify version
pip install pytest-asyncio>=0.23.0     # MEDIUM confidence
pip install respx>=0.21.0              # MEDIUM confidence
```

### Development
```bash
pip install ruff>=0.6.0                # MEDIUM confidence
pip install mypy>=1.11.0               # MEDIUM confidence
pip install pre-commit>=3.0.0          # MEDIUM confidence
```

**Python version:** 3.11 or 3.12 recommended (3.9 minimum per Anthropic SDK)

## Key Recommendations

### Do These Things (High Confidence)

1. **Use Anthropic SDK directly** - Skip LangChain/LlamaIndex. Direct SDK gives control needed for verification loops.

2. **Docker isolation is non-negotiable** - No subprocess, no host execution. Security boundary must be absolute.

3. **Implement turn limits immediately (Phase 2)** - Hard limit of 10 turns. Cost runaway will happen without this.

4. **Use end-state prompting** - Describe outcomes, not steps. Spotify finding: this works better.

5. **Limit tool access from day 1** - Start with minimal tools (Read, Edit), expand deliberately. Don't give full terminal.

6. **LLM Judge is not optional** - Deterministic verifiers catch "does it run?", Judge catches "did it do what I asked?"

7. **One change type per session** - Don't combine dependency update + refactor. Context exhaustion is real.

8. **Always require human approval** - No auto-merge, even if all verifiers pass. Non-negotiable.

### Don't Do These Things (High Confidence)

1. **Don't use LangChain** - Abstraction overhead, breaking changes, opinionated patterns conflict with verification needs.

2. **Don't skip verification** - Not even for "simple" changes. Consistency builds trust.

3. **Don't use MLflow for Phase 1-6** - Overkill for orchestrating API calls. Use structlog, add MLflow later if truly needed.

4. **Don't allow dynamic tool fetching** - Static tool manifest at spawn time. Predictability > flexibility.

5. **Don't dump raw logs to agent** - Summarize verification output. "3 tests failed: NullPointerException" not 10K lines.

6. **Don't run agent on host** - Security boundary must be container. No exceptions.

7. **Don't use Click** - Typer provides better DX with type hints. Worth the deviation from BRIEF.md.

### Validate These Decisions (Medium Confidence)

1. **Typer over Click** - BRIEF.md suggests Click, but Typer's type-hint approach is cleaner. Validate with team.

2. **Skip MLflow entirely** - Strong rationale in STACK.md, but may reconsider in Phase 7 if debugging painful.

3. **Docker SDK version >=7.0.0** - Verify against PyPI. Training data may be outdated.

4. **pytest-docker vs testcontainers** - Both options exist. Evaluate based on integration test needs in Phase 8.

5. **GitPython vs gh CLI** - GitPython recommended for testability, but gh CLI simpler. Re-evaluate in Phase 5.

## Ready for Roadmap

Research complete. Sufficient confidence to proceed with roadmap creation:

- **Stack decisions:** Clear recommendations with rationale
- **Phase structure:** Validated against research findings
- **Critical path identified:** Foundation → CLI → Tools → Verification
- **Risk areas flagged:** LLM Judge prompt engineering (Phase 4), version verification (Phase 0)
- **Anti-patterns documented:** 6 major anti-patterns to avoid
- **Success metrics defined:** Merge rate, veto rate (~25%), cost per run

**Next steps:**
1. Verify library versions against PyPI (Phase 0)
2. Create detailed roadmap from phase structure above
3. Establish metrics baseline in Phase 1
4. Build security checklist for Phase 1 (Docker hardening)
5. Design LLM Judge evaluation criteria for Phase 4

**Open questions for implementation:**
- Exact LLM Judge prompt structure (needs experimentation)
- Output summarization verbosity (needs tuning)
- Bash command allowlist completeness (may need expansion)

These are expected gaps at research stage. Phase-specific implementation will address them.

## Sources

**HIGH Confidence:**
- Anthropic Python SDK: https://github.com/anthropics/anthropic-sdk-python (verified 2026-01-26)
- MCP Architecture: https://modelcontextprotocol.io (referenced in project)
- Spotify Learnings: Via BRIEF.md project context (engineering blog references)

**MEDIUM Confidence:**
- Python libraries: Training data (January 2025 cutoff) - versions need PyPI verification
- Agent platform patterns: Training data + Spotify learnings synthesis
- Docker/testing best practices: Training data (established patterns)

**LOW Confidence (Flagged for Validation):**
- LLM Judge implementation details (not documented in available sources)
- Exact turn limit tuning (Spotify mentioned ~10, but project-specific)
- Breaking change detection feasibility (very hard, may need scope reduction)

**Research Limitations:**
- WebSearch unavailable (couldn't verify 2026 ecosystem trends)
- WebFetch mostly blocked (limited official doc access)
- No external validation of Spotify claims (couldn't access engineering blogs directly)
- Recommendations based on synthesis of available sources, not comprehensive survey

**Recommendation:** Treat HIGH confidence items as decisions, MEDIUM confidence as defaults (validate in implementation), LOW confidence as research flags for relevant phases.
