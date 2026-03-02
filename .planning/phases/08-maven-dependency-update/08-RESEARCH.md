# Phase 8: Maven Dependency Update - Research

**Researched:** 2026-03-02
**Domain:** Maven dependency management, pom.xml XML parsing, Java build verification, Docker host-side execution
**Confidence:** HIGH

## Summary

Phase 8 implements the full Maven dependency update flow: user specifies `groupId:artifactId` and target version via CLI, agent finds and updates the version in `pom.xml`, Maven build and tests run to verify, agent attempts code fixes if breaking changes exist, and the PR body includes a changelog link.

The primary architectural insight is that Maven verification **must run on the host machine** (not inside the isolated Docker container), because the container runs with `NetworkMode: 'none'` and Maven requires network access to resolve dependencies. This matches the existing pattern: `verifier.ts` already uses `execFileAsync` on the host for `tsc` and `vitest`. A new `mavenVerifier` function will follow this exact same pattern.

The second critical insight is that `pom.xml` stores versions in **three distinct locations** and the agent must search all three: inline `<version>` in `<dependency>`, a property reference like `${spring.version}` in `<properties>`, and a `<version>` inside `<dependencyManagement>`. Claude (running inside the container with workspace access) handles this search and edit using its existing `read_file`, `grep`, and `edit_file` tools — no new tools are needed. The agent's prompt must explicitly enumerate all three patterns.

**Primary recommendation:** Wire a `mavenVerifier` (host-side `mvn verify`, analogous to `buildVerifier`/`testVerifier`) into a new `RunOptions.taskKind` discriminator in `run.ts`, and craft a structured prompt that instructs the agent to find all three version locations, update the correct one, then run the build to confirm. The changelog link is derived from the POM's `<scm><url>` element fetched on the host before the agent runs.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MVN-01 | User specifies Maven dependency (groupId:artifactId) and target version via CLI | New CLI flags `--group-id`, `--artifact-id`, `--dep-version`; or single `--maven-dep` coordinate flag |
| MVN-02 | Agent locates and updates version in pom.xml | Agent uses `grep` + `edit_file` tools; prompt must cover all three version storage patterns |
| MVN-03 | Agent runs Maven build and tests to verify update | `mavenVerifier` runs `mvn verify` on host via `execFileAsync`; wired into existing retry loop |
| MVN-04 | Agent attempts code changes if new version has breaking API changes | Retry loop already handles this — build failure from `mavenVerifier` feeds error context back to Claude |
| MVN-05 | Agent includes dependency changelog/release notes link in PR body | Fetch POM from Maven Central repo URL, extract `<scm><url>`, append `/releases/tag/v{version}` |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `mvn` (system) | 3.9.x (Alpine apk) | Build and test runner | Already installed in Docker image; must run on host, not container |
| Node.js `child_process.execFile` | Node 20 (project stdlib) | Run `mvn verify` on host | Matches `buildVerifier`/`testVerifier` pattern exactly; already imported |
| `node:http`/`node:https` (stdlib) | Node 20 | Fetch POM from Maven Central | No extra dep needed; or use `fetch()` (native in Node 18+) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `xml2js` or `fast-xml-parser` | n/a | Parse Maven Central POM XML for `<scm><url>` | Use `fast-xml-parser` if XML parsing needed; avoid hand-rolling regex on XML |
| DOMParser / regex on simple fields | n/a | Extract `<scm><url>` from POM text | For a single field extraction, targeted regex on well-known POM structure is acceptable |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Host-side `mvn verify` | Docker exec `mvn verify` inside container | Container has `NetworkMode: none` — Maven can't download deps. Host-side is the only option unless Dockerfile pre-downloads all deps (impractical per-project). |
| Direct `<version>` regex update | `versions-maven-plugin` CLI | Plugin requires Maven to run, downloads internet artifacts even for property updates. Regex via agent `edit_file` is simpler and already in the tool suite. |
| Fetching POM for changelog URL | Hardcoded GitHub URL patterns | POM `<scm><url>` is authoritative. Many libraries don't follow `github.com/org/repo` pattern. |

**Installation:** No new npm packages required. `mvn` is already in the Alpine Docker image (used on host, not in container for this phase).

## Architecture Patterns

### Recommended Project Structure
```
src/
├── orchestrator/
│   ├── verifier.ts          # Add mavenVerifier() here (follows existing pattern)
│   └── maven-changelog.ts   # New: fetchMavenChangelog(groupId, artifactId, version)
├── cli/
│   ├── index.ts             # Add --maven-dep, --dep-version flags
│   └── commands/
│       └── run.ts           # Add RunOptions.mavenDep, RunOptions.depVersion; build Maven prompt
```

### Pattern 1: Host-Side Maven Verifier (mirrors buildVerifier)
**What:** Run `mvn verify` in the workspace directory on the host using `execFileAsync`. Skip gracefully if no `pom.xml` exists.
**When to use:** After any agent session that modified a Maven project.

```typescript
// Source: mirrors src/orchestrator/verifier.ts buildVerifier pattern (HIGH confidence)
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { VerificationResult } from '../types.js';

const execFileAsync = promisify(execFile);

export async function mavenVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  // Skip if no pom.xml
  try {
    await access(join(workspaceDir, 'pom.xml'));
  } catch {
    console.info('[Maven] No pom.xml found — skipping Maven verification');
    return { passed: true, errors: [], durationMs: 0 };
  }

  try {
    // mvn verify: compile + test + package + verify phases
    // -B: batch mode (no interactive prompts)
    // -ntp: no transfer progress (cleaner output)
    await execFileAsync('mvn', ['-B', '-ntp', 'verify'], {
      cwd: workspaceDir,
      timeout: 300_000,  // 5 minutes — Maven can be slow on first run
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    const durationMs = Date.now() - start;
    return { passed: true, errors: [], durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const error = err as { stdout?: string; stderr?: string };
    const rawOutput = [error.stdout ?? '', error.stderr ?? ''].join('\n').trim();
    // Extract compilation errors or test failures from Maven output
    const summary = summarizeMavenErrors(rawOutput);
    return {
      passed: false,
      errors: [{ type: 'build', summary, rawOutput }],
      durationMs,
    };
  }
}
```

### Pattern 2: Agent Prompt for pom.xml Version Update
**What:** Structured prompt that explicitly instructs the agent to handle all three version storage patterns.
**When to use:** In `run.ts` when `taskKind === 'maven'`.

```typescript
// Source: based on pom.xml spec (maven.apache.org/pom.html, HIGH confidence)
// and LADU paper approach (arxiv.org/html/2510.03480, MEDIUM confidence)
function buildMavenPrompt(groupId: string, artifactId: string, targetVersion: string): string {
  return `You are a coding agent. Update the Maven dependency ${groupId}:${artifactId} to version ${targetVersion} in this project.

STEP 1 — Find the current version. Search pom.xml for ALL three patterns:
  a) Inline version: <dependency> with <groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>X.Y.Z</version>
  b) Property reference: <dependency> uses <version>\${some.property}</version> — find the property name, then find it in <properties>
  c) DependencyManagement: <dependencyManagement> section containing this groupId:artifactId with a <version>

Use the grep tool to search: grep pattern '${groupId}' in pom.xml, then inspect surrounding lines.

STEP 2 — Update the version to ${targetVersion}. Edit only the version value — do not change any other part of the file.
  - For pattern (a): replace the <version>OLD</version> directly
  - For pattern (b): update the property value in <properties>, NOT the ${...} reference
  - For pattern (c): update the version in <dependencyManagement>

STEP 3 — Commit the change with: git add pom.xml && git commit -m "chore: update ${artifactId} to ${targetVersion}"

If the build fails after your change (you will be told), read the error output carefully:
  - COMPILATION ERROR means breaking API changes — find the failing import or method, then fix the Java source files
  - Fix only files that reference ${artifactId} API — do not change unrelated code
  - Re-commit after each fix

Work in the current directory.`;
}
```

### Pattern 3: Maven Central POM Fetch for Changelog URL
**What:** Fetch the POM from Maven Central, extract the `<scm><url>` element, and construct a GitHub releases URL.
**When to use:** Before creating the PR (in `run.ts`), to populate `MVN-05`.

```typescript
// Source: Maven Central repo URL pattern (repo1.maven.org), HIGH confidence
// POM <scm><url> observed from spring-boot POM fetch, HIGH confidence
export async function fetchMavenChangelogUrl(
  groupId: string,
  artifactId: string,
  version: string
): Promise<string | null> {
  // Maven Central POM URL: replace dots in groupId with slashes
  const groupPath = groupId.replace(/\./g, '/');
  const pomUrl = `https://repo1.maven.org/maven2/${groupPath}/${artifactId}/${version}/${artifactId}-${version}.pom`;

  try {
    const response = await fetch(pomUrl);
    if (!response.ok) return null;
    const pomText = await response.text();

    // Extract <scm><url> — well-known POM structure, targeted regex is acceptable
    const scmUrlMatch = pomText.match(/<scm>[\s\S]*?<url>(.*?)<\/url>[\s\S]*?<\/scm>/);
    if (!scmUrlMatch) return null;

    const repoUrl = scmUrlMatch[1].trim();
    // For GitHub repos, link to releases page for the specific version
    if (repoUrl.includes('github.com')) {
      // Attempt standard GitHub releases tag format
      return `${repoUrl}/releases/tag/v${version}`;
    }
    return repoUrl;
  } catch {
    return null;
  }
}
```

### Pattern 4: Wiring Maven into RunOptions
**What:** Extend `RunOptions` with Maven-specific fields and switch verifier based on task kind.
**When to use:** In `run.ts` when handling Maven dependency update tasks.

```typescript
// Extend RunOptions in run.ts:
export interface RunOptions {
  taskType: string;
  repo: string;
  turnLimit: number;
  timeout: number;
  maxRetries: number;
  noJudge?: boolean;
  createPr?: boolean;
  branchOverride?: string;
  // Phase 8 additions:
  mavenDep?: string;      // "groupId:artifactId"
  depVersion?: string;    // target version string
}

// In runAgent(), detect Maven task and use mavenVerifier:
const isMavenTask = !!options.mavenDep && !!options.depVersion;
const verifier = isMavenTask ? mavenVerifier : compositeVerifier;
```

### Anti-Patterns to Avoid
- **Running `mvn` inside the container:** Container has `NetworkMode: 'none'` — Maven will fail to resolve dependencies from Maven Central. Always run `mvn` on the host.
- **Regex on entire pom.xml without checking all three version patterns:** Version in `<properties>` is the most common pattern in modern projects (Spring Boot, Quarkus, etc.) but inline `<version>` is also common. The agent must check all three.
- **Using `versions-maven-plugin` for targeted update:** Plugin needs network access and downloads its own dependencies. Overkill for a single-dep update; agent's `edit_file` tool is sufficient.
- **Assuming `github.com/org/repo/releases/tag/v{version}` always works:** Some projects use `{version}` without `v` prefix (e.g., `3.4.0` not `v3.4.0`). Return both the POM's `<url>` and the attempted releases URL; let the PR body include both.
- **Hardcoding `mvn` path:** Use `which mvn` or rely on PATH. On the host machine (developer's Mac), Maven may be at `/usr/local/bin/mvn` or `/opt/homebrew/bin/mvn`. `execFileAsync('mvn', ...)` respects PATH.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| XML parsing of `<scm><url>` | Full XML DOM parser | Targeted regex on well-known POM structure | POM `<scm>` section is predictable XML; adding xml2js adds a dep and complexity for one field extraction. If multiple fields needed, use `fast-xml-parser`. |
| Maven dependency resolution | Custom version lookup | `mvn verify` on host (existing pattern) | Maven already knows where its deps are; don't replicate its classpath logic |
| Retry on build failure | New retry mechanism | Existing `RetryOrchestrator` (already built) | Phase 4/5 retry loop handles `mavenVerifier` failures exactly like `buildVerifier` failures — error context injected into next attempt |
| Changelog URL guessing | Hardcoded URL templates per library | POM `<scm><url>` + `/releases` pattern | POM is the authoritative source; guessing `github.com/groupId/artifactId` fails for libraries with different GitHub org names |
| Breaking change detection | Static analysis (Clirr, japicmp) | Maven compile errors surfaced to agent via retry | COMPILATION ERROR in `mvn verify` output is the ground truth; agent reads error and fixes imports/method calls |

**Key insight:** The existing RetryOrchestrator + verifier architecture already handles the breaking-changes retry loop (MVN-04). A failed `mavenVerifier` produces a `VerificationError` with the Maven output, which `ErrorSummarizer.buildDigest` condenses for the retry prompt. No new retry infrastructure is needed.

## Common Pitfalls

### Pitfall 1: Maven Running with NetworkMode None (CRITICAL)
**What goes wrong:** If `mvn verify` runs inside the Docker container, it fails immediately with `Cannot access central (https://repo1.maven.org/maven2)` because the container has `NetworkMode: 'none'`.
**Why it happens:** The existing container is deliberately network-isolated for security. Maven needs to download plugins and dependencies from Maven Central.
**How to avoid:** Run `mvn verify` via `execFileAsync` on the host machine, using `cwd: workspaceDir`. This is the same approach as `buildVerifier` (which runs `tsc` on the host).
**Warning signs:** Maven output containing `Cannot access central` or `offline mode` errors.

### Pitfall 2: Version Stored in `<properties>` Not `<version>` Tag
**What goes wrong:** Agent finds `<artifactId>spring-boot-starter</artifactId>` with no `<version>` tag in `<dependency>`, assumes no version, and reports success without updating anything.
**Why it happens:** Spring Boot, Quarkus, and most modern Maven projects define versions as `${spring.version}` in `<properties>`. The actual version is in `<properties>`, not the `<dependency>` block.
**How to avoid:** Prompt must explicitly tell the agent to search for `${` patterns in `<dependency>` blocks, resolve the property name, then update `<properties>`.
**Warning signs:** Agent commits with "no version found" or edits the `${...}` reference text instead of the property value.

### Pitfall 3: Multiple pom.xml Files in Multi-Module Projects
**What goes wrong:** Agent updates version in the root `pom.xml` but the dependency is declared in a child module's `pom.xml` (or vice versa).
**Why it happens:** Multi-module Maven projects have a parent `pom.xml` and child `pom.xml` files in subdirectories. `<dependencyManagement>` is typically in the parent, while actual `<dependency>` declarations are in children.
**How to avoid:** Prompt must instruct agent to `find` all `pom.xml` files and grep all of them. Grep first, update the file where the version is actually defined.
**Warning signs:** Build fails with "could not resolve artifact" after agent reports success.

### Pitfall 4: Maven Build Timeout Too Short
**What goes wrong:** `mvn verify` exceeds the timeout (particularly on first run when `.m2` cache is cold). The verifier reports failure, triggering unnecessary retries.
**Why it happens:** Maven must download all plugins and dependencies on the first run. For a Spring Boot project with 50+ dependencies, this can take 2-3 minutes.
**How to avoid:** Set `timeout` for `mavenVerifier` to 300,000ms (5 minutes). The existing `testVerifier` uses 120,000ms; Maven needs longer. Log a warning if approaching timeout.
**Warning signs:** Verifier shows `Process killed after timeout` but Maven output shows download progress.

### Pitfall 5: Changelog URL Does Not Match GitHub Release Tag Format
**What goes wrong:** PR body contains `https://github.com/org/repo/releases/tag/v3.4.0` but the actual release is tagged `3.4.0` (no `v` prefix). The link 404s.
**Why it happens:** No universal standard for GitHub release tag format — Spring uses `v3.4.0`, some projects use `3.4.0`, others use `release-3.4.0`.
**How to avoid:** Include both the base GitHub URL and the attempted releases URL in the PR body. Label it "Release notes (may require version prefix adjustment)". Don't fail PR creation over a bad changelog URL.
**Warning signs:** Any time the target version does not start with `v`.

### Pitfall 6: `mvn` Not Found on Host PATH
**What goes wrong:** `execFileAsync('mvn', ...)` throws `ENOENT: no such file or directory, spawn mvn`.
**Why it happens:** Developer may have Maven installed via `sdkman`, `brew`, or other tools with a non-standard PATH not inherited by Node's `execFile`.
**How to avoid:** Catch `ENOENT` specifically in `mavenVerifier` and return a descriptive `VerificationError` with message "Maven (mvn) not found on host PATH. Install Maven or add to PATH." Do not throw.
**Warning signs:** ENOENT error on the first `mvn` invocation.

### Pitfall 7: Agent Edits `${property.name}` Reference Instead of Property Value
**What goes wrong:** Agent changes `<version>${spring.version}</version>` to `<version>3.4.0</version>` directly, hardcoding the version in the dependency rather than updating the property. This breaks other dependencies that also use `${spring.version}`.
**Why it happens:** The agent sees the dependency block and makes the simplest edit without understanding the properties indirection.
**How to avoid:** Prompt must explicitly state: "If the version uses `${property.name}`, update the property in `<properties>` — do NOT replace the `${...}` placeholder with a literal version."
**Warning signs:** Diff shows `<version>${...}</version>` replaced with a literal version string.

## Code Examples

Verified patterns from official sources:

### pom.xml Version Storage Patterns (Three Variants)
```xml
<!-- Source: maven.apache.org/pom.html, HIGH confidence -->

<!-- Pattern A: Inline version in <dependencies> -->
<dependency>
  <groupId>com.example</groupId>
  <artifactId>mylib</artifactId>
  <version>2.1.0</version>  <!-- Update this directly -->
</dependency>

<!-- Pattern B: Property reference (most common in modern projects) -->
<properties>
  <mylib.version>2.0.0</mylib.version>  <!-- Update THIS value -->
</properties>
<dependency>
  <groupId>com.example</groupId>
  <artifactId>mylib</artifactId>
  <version>${mylib.version}</version>  <!-- Do NOT touch this -->
</dependency>

<!-- Pattern C: DependencyManagement (parent POM or multi-module) -->
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>mylib</artifactId>
      <version>2.0.0</version>  <!-- Update this in dependencyManagement -->
    </dependency>
  </dependencies>
</dependencyManagement>
```

### Maven Central POM URL Pattern
```
# Source: repo1.maven.org direct observation, HIGH confidence
# Pattern: https://repo1.maven.org/maven2/{groupId-with-dots-as-slashes}/{artifactId}/{version}/{artifactId}-{version}.pom
# Example:
https://repo1.maven.org/maven2/org/springframework/boot/spring-boot/3.4.0/spring-boot-3.4.0.pom
```

### Maven Central SCM URL Pattern (from POM)
```xml
<!-- Source: Spring Boot POM fetch (spring-boot-3.4.0.pom), HIGH confidence -->
<scm>
  <url>https://github.com/spring-projects/spring-boot</url>
</scm>
<!-- Changelog URL: {scm.url}/releases/tag/v{version} -->
<!-- e.g.: https://github.com/spring-projects/spring-boot/releases/tag/v3.4.0 -->
```

### Host-Side Maven Execution with Error Capture
```typescript
// Source: mirrors verifier.ts buildVerifier pattern, HIGH confidence
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

// mvn verify: compile + test + package + integration-test phases
// -B: batch/non-interactive
// -ntp: suppress transfer-progress spam
// cwd: workspace on HOST filesystem (not container exec)
await execFileAsync('mvn', ['-B', '-ntp', 'verify'], {
  cwd: workspaceDir,   // host path — Maven has network access
  timeout: 300_000,    // 5min — cold .m2 cache can be slow
  maxBuffer: 10 * 1024 * 1024,
  killSignal: 'SIGKILL',
});
```

### Maven Error Pattern Detection
```typescript
// Source: maven build output analysis, MEDIUM confidence (community consensus)
function summarizeMavenErrors(rawOutput: string): string {
  // Maven marks compilation errors with [ERROR] and BUILD FAILURE
  const lines = rawOutput.split('\n');
  const errorLines = lines.filter(l =>
    l.includes('[ERROR]') ||
    l.includes('COMPILATION ERROR') ||
    l.includes('BUILD FAILURE') ||
    l.includes('Tests run:') && l.includes('Failures:')
  );
  return errorLines.slice(0, 10).join('\n') || 'Maven build failed — see rawOutput';
}
```

### PR Body Enhancement for Changelog (MVN-05)
```typescript
// Source: derived from pom.xml SCM pattern, HIGH confidence
// In run.ts, after successful retryResult:
if (options.mavenDep && options.depVersion) {
  const [groupId, artifactId] = options.mavenDep.split(':');
  const changelogUrl = await fetchMavenChangelogUrl(groupId, artifactId, options.depVersion);
  // Pass to buildPRBody as additional context, or append to task string
}

// In buildPRBody or PR body construction:
const changelogSection = changelogUrl
  ? `\n## Changelog\n\n[Release notes for ${artifactId} ${version}](${changelogUrl})\n`
  : `\n## Changelog\n\nCould not determine changelog URL. Check: https://search.maven.org/artifact/${groupId}/${artifactId}\n`;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Mend Renovate / Dependabot (external tools) | LLM agent that understands context (LADU paper 2025) | 2024-2025 | Agent can fix breaking changes, not just update version numbers |
| `versions-maven-plugin` for targeted updates | Direct `edit_file` on `pom.xml` by agent | N/A for this project | Plugin needs Maven network access; agent tool approach is simpler |
| Maven 3.x (3.8, 3.9) | Maven 4.x (4.0.0 RC5 as of March 2026) | March 2026 | Maven 4 has backwards-compatible POM changes; `mvn verify` command unchanged |
| `mvn test` (unit tests only) | `mvn verify` (unit + integration tests) | N/A | `verify` runs the full lifecycle including integration test phase — more thorough |

**Deprecated/outdated:**
- `adoptopenjdk` Docker images: Use `eclipse-temurin` (already in Dockerfile) — adoptopenjdk EOL'd
- `search.maven.org` REST API for changelog info: Use direct POM fetch from `repo1.maven.org` instead — POM has SCM URL directly

## Open Questions

1. **Maven not on host PATH**
   - What we know: `execFileAsync('mvn', ...)` requires `mvn` in PATH. Developer Macs typically have Maven via Homebrew or SDKMAN.
   - What's unclear: CI/CD environments may not have Maven installed on the host.
   - Recommendation: Add ENOENT check with clear error message. Document requirement: "Host machine must have Maven installed for Maven tasks."

2. **Multi-module projects with version in child POM**
   - What we know: Agent has `find` and `grep` tools to discover multiple `pom.xml` files.
   - What's unclear: Whether the agent will reliably identify the correct `pom.xml` to edit when parent uses `<dependencyManagement>` and child references without version.
   - Recommendation: Prompt must explicitly instruct: "Run `find . -name 'pom.xml'` to find all POM files, then grep all of them."

3. **Changelog URL version prefix (`v` vs no `v`)**
   - What we know: GitHub release tags vary (`v3.4.0` vs `3.4.0`). Maven Central search API does not return tag names.
   - What's unclear: Whether to attempt a HEAD request to validate the URL before including it.
   - Recommendation: Include the constructed URL in the PR body with a note that the `v` prefix may need adjustment. A broken link is better than no link.

4. **Maven Wrapper (`mvnw`) vs system `mvn`**
   - What we know: Many modern Maven projects include `mvnw` (Maven Wrapper) that downloads the correct Maven version.
   - What's unclear: Should `mavenVerifier` prefer `./mvnw` over system `mvn` if `mvnw` exists?
   - Recommendation: Check for `mvnw` first (`access(join(workspaceDir, 'mvnw'))`), fall back to `mvn`. This ensures project-specified Maven version is used.

## Sources

### Primary (HIGH confidence)
- `maven.apache.org/pom.html` — POM structure, dependency patterns (three version storage variants), dependencyManagement, properties
- `repo1.maven.org/maven2/org/springframework/boot/spring-boot/3.4.0/spring-boot-3.4.0.pom` — Direct POM fetch confirming `<scm><url>` structure and GitHub releases URL pattern
- `central.sonatype.org/search/rest-api-guide/` — Maven Central search API endpoints and response field structure
- `src/orchestrator/verifier.ts` (project codebase) — Established host-side `execFileAsync` verifier pattern to mirror
- `docker/Dockerfile` (project codebase) — Confirmed `openjdk17-jre-headless` + `maven` already in image; `NetworkMode: 'none'` in container.ts confirmed network isolation

### Secondary (MEDIUM confidence)
- `arxiv.org/html/2510.03480` — LADU paper: LLM agent approach to Maven pom.xml updates; confirms pom files get special handling separate from code summarization; apply changes → compile → test cycle
- `www.mojohaus.org/versions/versions-maven-plugin/usage.html` — Versions Maven Plugin confirmed not suitable for targeted single-dep update via CLI without network
- `www.baeldung.com/maven-offline` — Maven offline mode (`-o` flag) and `dependency:go-offline` pre-caching strategy; confirmed impractical for dynamic project deps

### Tertiary (LOW confidence)
- Web search consensus on Maven `COMPILATION ERROR` pattern as primary signal for breaking changes
- Web search consensus on `mvn verify` as preferred command over `mvn test` for integration test coverage

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — confirmed from project codebase (Dockerfile, verifier.ts pattern) and Maven official docs
- Architecture: HIGH — host-side exec pattern is established in codebase; network isolation is a hard constraint confirmed in container.ts
- Pitfalls: HIGH for network/version-location pitfalls (confirmed from code + Maven docs); MEDIUM for changelog URL format (community pattern)

**Research date:** 2026-03-02
**Valid until:** 2026-09-01 (Maven is stable; 30-day estimate is conservative for this domain)
