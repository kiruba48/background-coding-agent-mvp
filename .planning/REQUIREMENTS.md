# Requirements: Background Coding Agent

**Defined:** 2026-03-02
**Core Value:** The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes become PRs.

## v1.1 Requirements

Requirements for v1.1 End-to-End Pipeline. Each maps to roadmap phases.

### PR Creation

- [x] **PR-01**: Agent creates GitHub PR on target repo after successful verification (service built in 07-01; CLI wiring in 07-02)
- [x] **PR-02**: Agent auto-generates branch name from task context (e.g., `agent/update-spring-boot-3.2`)
- [x] **PR-03**: User can override branch name via CLI flag (07-02)
- [x] **PR-04**: PR body includes task prompt, summary of changes, diff stats
- [x] **PR-05**: PR body includes verification results (build/test/lint pass/fail)
- [x] **PR-06**: PR body includes LLM Judge verdict and reasoning
- [x] **PR-07**: PR body flags potential breaking changes for reviewer

### Maven Dependency Update

- [x] **MVN-01**: User specifies Maven dependency (groupId:artifactId) and target version via CLI
- [x] **MVN-02**: Agent locates and updates version in pom.xml
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
| PR-01 | Phase 7 | Complete (07-01 service + 07-02 CLI wiring) |
| PR-02 | Phase 7 | Complete (07-01) |
| PR-03 | Phase 7 | Complete (07-02) |
| PR-04 | Phase 7 | Complete (07-01) |
| PR-05 | Phase 7 | Complete (07-01) |
| PR-06 | Phase 7 | Complete (07-01) |
| PR-07 | Phase 7 | Complete (07-01) |
| MVN-01 | Phase 8 | Complete |
| MVN-02 | Phase 8 | Complete |
| MVN-03 | Phase 8 | Pending |
| MVN-04 | Phase 8 | Pending |
| MVN-05 | Phase 8 | Pending |
| NPM-01 | Phase 9 | Pending |
| NPM-02 | Phase 9 | Pending |
| NPM-03 | Phase 9 | Pending |
| NPM-04 | Phase 9 | Pending |
| NPM-05 | Phase 9 | Pending |

**Coverage:**
- v1.1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-02*
*Last updated: 2026-03-02 after gap audit (PR-01, PR-03 status fixed; Phase 7 tech debt folded into Phase 8)*
