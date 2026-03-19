---
phase: 13
slug: container-strategy
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 13 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.0.18 |
| **Config file** | `vitest.config.ts` (project root) |
| **Quick run command** | `npm test -- --reporter=verbose src/cli/docker/index.test.ts src/orchestrator/claude-code-session.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --reporter=verbose src/cli/docker/index.test.ts src/orchestrator/claude-code-session.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 13-01-01 | 01 | 1 | CTR-01 | smoke | `docker build -t background-agent:test docker/` | ❌ W0 | ⬜ pending |
| 13-01-02 | 01 | 1 | CTR-02 | unit | `npm test -- src/cli/docker/index.test.ts` | ❌ W0 | ⬜ pending |
| 13-01-03 | 01 | 1 | CTR-02 | unit | `npm test -- src/orchestrator/claude-code-session.test.ts` | ✅ extend | ⬜ pending |
| 13-01-04 | 01 | 1 | CTR-03 | manual | N/A — requires container runtime | manual | ⬜ pending |
| 13-01-05 | 01 | 1 | CTR-03 | manual | N/A — requires live Docker + API key | manual | ⬜ pending |
| 13-01-06 | 01 | 1 | CTR-04 | unit | `docker run --rm background-agent:test whoami` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/cli/docker/index.ts` — Docker helper module (buildImageIfNeeded, ensureNetworkExists, spawnDockerSession, assertDockerRunning)
- [ ] `src/cli/docker/index.test.ts` — Unit tests for docker helper functions using mocked `execFileAsync` and `spawn`
- [ ] `docker/entrypoint.sh` — Container entrypoint script (no test file, manual verification)
- [ ] Extend `src/orchestrator/claude-code-session.test.ts` — Add tests for `spawnClaudeCodeProcess` being wired into query() options

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| entrypoint.sh applies iptables rules | CTR-03 | Requires live Docker daemon with NET_ADMIN capability | `docker run --rm --cap-add NET_ADMIN background-agent:test iptables -L` — verify OUTPUT chain has ACCEPT for Anthropic IPs and DROP default |
| Agent can reach api.anthropic.com but not other hosts | CTR-03 | Requires live Docker + real API key + network | Start container, run `curl -s https://api.anthropic.com/v1/messages -o /dev/null -w '%{http_code}'` (expect 4xx auth error = reachable), then `curl --max-time 5 https://example.com` (expect timeout/fail) |
| Container runs as non-root user | CTR-04 | Requires Docker daemon | `docker run --rm --cap-add NET_ADMIN background-agent:test whoami` — expect `agent`, not `root` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
