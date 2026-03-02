# Requirements: Background Coding Agent

**Defined:** 2026-03-02
**Core Value:** The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes become PRs.

## v1.1 Requirements

Requirements for v1.1 End-to-End Pipeline. Each maps to roadmap phases.

### PR Creation

- [ ] **PR-01**: Agent creates GitHub PR on target repo after successful verification
- [ ] **PR-02**: Agent auto-generates branch name from task context (e.g., `agent/update-spring-boot-3.2`)
- [ ] **PR-03**: User can override branch name via CLI flag
- [ ] **PR-04**: PR body includes task prompt, summary of changes, diff stats
- [ ] **PR-05**: PR body includes verification results (build/test/lint pass/fail)
- [ ] **PR-06**: PR body includes LLM Judge verdict and reasoning
- [ ] **PR-07**: PR body flags potential breaking changes for reviewer

### Maven Dependency Update

- [ ] **MVN-01**: User specifies Maven dependency (groupId:artifactId) and target version via CLI
- [ ] **MVN-02**: Agent locates and updates version in pom.xml
- [ ] **MVN-03**: Agent runs Maven build and tests to verify update
- [ ] **MVN-04**: Agent attempts code changes if new version has breaking API changes
- [ ] **MVN-05**: Agent includes dependency changelog/release notes link in PR body

### npm Dependency Update

- [ ] **NPM-01**: User specifies npm package name and target version via CLI
- [ ] **NPM-02**: Agent updates version in package.json and regenerates lockfile
- [ ] **NPM-03**: Agent runs build and tests to verify update
- [ ] **NPM-04**: Agent attempts code changes if new version has breaking API changes
- [ ] **NPM-05**: Agent includes dependency changelog/release notes link in PR body

## Future Requirements

Deferred to v1.2+. Tracked but not in current roadmap.

### Extensibility

- **EXT-01**: Custom verifiers can be added via plugin system
- **EXT-02**: Cost per run metric tracked per session

### Multi-Platform

- **PLT-01**: GitLab merge request creation support
- **PLT-02**: Bitbucket pull request creation support

### Batch Operations

- **BAT-01**: Agent scans for all outdated dependencies and updates them

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Custom verifier plugins | Deferred to v1.2+ — current verifiers sufficient |
| Cost per run metric | Deferred to v1.2+ — not blocking core pipeline |
| GitLab/Bitbucket support | GitHub only for v1.1 — prove pattern first |
| "Update all outdated" mode | User specifies dep for v1.1 — bulk mode later |
| Auto-merge PRs | Human approval required (trust model) |
| Queue/webhook triggers | CLI only for MVP |
| Real-time streaming UI | CLI output sufficient |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| PR-01 | — | Pending |
| PR-02 | — | Pending |
| PR-03 | — | Pending |
| PR-04 | — | Pending |
| PR-05 | — | Pending |
| PR-06 | — | Pending |
| PR-07 | — | Pending |
| MVN-01 | — | Pending |
| MVN-02 | — | Pending |
| MVN-03 | — | Pending |
| MVN-04 | — | Pending |
| MVN-05 | — | Pending |
| NPM-01 | — | Pending |
| NPM-02 | — | Pending |
| NPM-03 | — | Pending |
| NPM-04 | — | Pending |
| NPM-05 | — | Pending |

**Coverage:**
- v1.1 requirements: 17 total
- Mapped to phases: 0
- Unmapped: 17 ⚠️

---
*Requirements defined: 2026-03-02*
*Last updated: 2026-03-02 after initial definition*
