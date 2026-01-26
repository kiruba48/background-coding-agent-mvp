# Phase 1: Foundation & Security - Research

**Researched:** 2026-01-26
**Domain:** Docker container isolation + Anthropic SDK integration
**Confidence:** HIGH

## Summary

This phase establishes a sandboxed execution environment for AI coding agents using Docker containers with network isolation and Anthropic SDK communication. The standard approach combines Docker's microVM-based sandboxes (2026 best practice) with programmatic container management via dockerode (Node.js) and the Anthropic TypeScript SDK for streaming agent communication.

The architecture follows a three-layer isolation model: (1) Docker containers provide filesystem and process isolation, (2) network mode "none" prevents external access, and (3) non-root user execution limits privilege escalation. The orchestrator process runs on the host, managing container lifecycle via Docker API while communicating with Claude via the Messages API streaming protocol.

Docker's 2026 sandbox architecture uses lightweight microVMs with private Docker daemons, providing stronger isolation than traditional containers. For this phase, container-based isolation with network restrictions provides sufficient security while maintaining simpler implementation.

**Primary recommendation:** Use dockerode for container lifecycle management with Alpine Linux base images, network mode "none" for complete network isolation, and Anthropic TypeScript SDK streaming for real-time agent communication.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| dockerode | 4.x | Docker API client for Node.js | Official Docker Remote API wrapper, battle-tested with stream support and promise-based API |
| @anthropic-ai/sdk | Latest | Anthropic SDK for Messages API | Official TypeScript SDK with streaming helpers, type safety, and tool use support |
| alpine | 3.18+ | Docker base image | Minimal attack surface (~5MB), security-focused with PIE and stack protection |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/dockerode | Latest | TypeScript definitions | Type safety for dockerode API |
| zod | Latest | Schema validation | Tool use input validation with betaZodTool helper |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| dockerode | docker CLI via exec | Less control, harder error handling, no stream management |
| Alpine | Ubuntu/Debian | 10x larger images, more attack surface, slower startup |
| Container isolation | Docker Sandbox (microVM) | Stronger isolation but requires Docker Desktop 4.57+, macOS/Windows only |

**Installation:**
```bash
npm install dockerode @anthropic-ai/sdk
npm install --save-dev @types/dockerode
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── orchestrator/       # Host process managing containers & SDK
│   ├── container.ts    # Docker lifecycle management
│   ├── agent.ts        # Anthropic SDK integration
│   └── types.ts        # Shared types
├── agent/              # Code running inside container
│   └── executor.ts     # Agent execution logic
└── docker/             # Dockerfile and config
    └── Dockerfile      # Agent container image
```

### Pattern 1: Isolated Orchestrator Architecture
**What:** Orchestrator runs on host, agent executes in isolated container, communication via Messages API streaming
**When to use:** When agent needs external API access (Claude API) but no other network access
**Example:**
```typescript
// Source: Docker Sandboxes pattern + Anthropic SDK streaming
import Docker from 'dockerode';
import Anthropic from '@anthropic-ai/sdk';

class AgentOrchestrator {
  private docker: Docker;
  private anthropic: Anthropic;

  constructor() {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  async createIsolatedContainer(): Promise<Docker.Container> {
    const container = await this.docker.createContainer({
      Image: 'agent-sandbox:latest',
      User: 'agent:agent', // Non-root execution
      NetworkMode: 'none', // Complete network isolation
      HostConfig: {
        Memory: 512 * 1024 * 1024, // 512MB limit
        NanoCpus: 1000000000, // 1 CPU
        ReadonlyRootfs: true, // Read-only filesystem
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=100m' }
      },
      WorkingDir: '/workspace',
      Cmd: ['/bin/sh']
    });

    return container;
  }

  async streamAgentResponse(userMessage: string) {
    await this.anthropic.messages.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{ role: 'user', content: userMessage }]
    }).on('text', (text) => {
      console.log(text);
    }).on('error', (error) => {
      console.error('Stream error:', error);
    });
  }
}
```

### Pattern 2: Container Lifecycle Management
**What:** Create, start, execute, cleanup pattern with proper signal handling
**When to use:** All container operations to ensure clean teardown
**Example:**
```typescript
// Source: dockerode GitHub + Docker cleanup best practices
async executeInContainer(
  container: Docker.Container,
  command: string[]
): Promise<void> {
  try {
    await container.start();

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    // Demux stdout/stderr streams
    this.docker.modem.demuxStream(
      stream,
      process.stdout,
      process.stderr
    );

    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  } finally {
    // Graceful shutdown: SIGTERM first, then SIGKILL after 10s
    await container.stop({ t: 10 });
    await container.remove({ force: true });
  }
}
```

### Pattern 3: Streaming Event Handler
**What:** Handle Messages API streaming events with error recovery
**When to use:** All agent communication to provide real-time responses
**Example:**
```typescript
// Source: https://platform.claude.com/docs/en/api/messages-streaming
async streamWithErrorRecovery(messages: Message[]) {
  const partialResponse: ContentBlock[] = [];

  try {
    const stream = this.anthropic.messages.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages
    });

    stream.on('message_start', (event) => {
      console.log('Started:', event.message.id);
    });

    stream.on('content_block_delta', (event) => {
      if (event.delta.type === 'text_delta') {
        partialResponse.push(event.delta);
        process.stdout.write(event.delta.text);
      }
    });

    stream.on('message_stop', () => {
      console.log('\nCompleted');
    });

    stream.on('error', async (error) => {
      if (error.status === 529) { // overloaded_error
        console.log('Retrying after overload...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        // Retry with partial response
        return this.streamWithErrorRecovery([
          ...messages,
          { role: 'assistant', content: partialResponse }
        ]);
      }
      throw error;
    });

    await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`API Error ${err.status}: ${err.name}`);
    }
    throw err;
  }
}
```

### Anti-Patterns to Avoid
- **Exposing Docker socket to containers:** Equivalent to root access on host
- **Using :latest image tags:** Moving target that bypasses security scanning
- **Shell-form CMD/ENTRYPOINT:** Prevents signal propagation, breaks graceful shutdown
- **Running as root user:** Container breakout becomes host compromise
- **Default network mode:** Allows external network access and lateral movement

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Docker API communication | Custom HTTP client for /var/run/docker.sock | dockerode | Stream demuxing, promise/callback APIs, comprehensive error handling |
| Container stream handling | Manual stdout/stderr splitting | docker.modem.demuxStream() | Handles Docker's multiplexed stream protocol correctly |
| Messages API streaming | Custom SSE parser | @anthropic-ai/sdk stream helpers | Handles event types, token counting, error recovery, partial JSON accumulation |
| Signal propagation | Custom PID 1 wrapper | Exec-form CMD in Dockerfile | Docker handles SIGTERM/SIGKILL correctly with exec form |
| Container cleanup | Manual stop/remove | docker container prune + graceful stop pattern | Proper SIGTERM→SIGKILL sequence, orphan cleanup |

**Key insight:** Docker's stream protocol multiplexes stdout/stderr into a single stream with length-prefixed frames. Hand-rolling this leads to corrupted output. Similarly, Messages API streaming uses server-sent events with complex event sequences (message_start, content_block_delta, message_stop) that require careful state management.

## Common Pitfalls

### Pitfall 1: Network Isolation Without Orchestrator Access
**What goes wrong:** Setting NetworkMode: 'none' blocks ALL network, including Claude API access from within container
**Why it happens:** Confusion about where SDK calls should originate
**How to avoid:** Orchestrator (host process) makes Claude API calls, container only executes tool results
**Warning signs:** Container logs show "network unreachable" errors when calling Anthropic SDK

### Pitfall 2: Exposed Docker Socket
**What goes wrong:** Mounting /var/run/docker.sock into container for "convenience" grants full host root access
**Why it happens:** Attempting to manage containers from within containers
**How to avoid:** Never mount Docker socket. Orchestrator manages all containers from host.
**Warning signs:** Security scans flag Docker socket mount, container has docker CLI installed

### Pitfall 3: Root User Execution
**What goes wrong:** Container runs as root, breakout becomes full system compromise
**Why it happens:** Dockerfile missing USER directive, or using UID 0
**How to avoid:** Create non-root user in Dockerfile, set User: 'agent:agent' in container config
**Warning signs:** whoami in container returns 'root', security scans flag root execution

### Pitfall 4: Hardcoded API Keys in Images
**What goes wrong:** API keys baked into image via ENV/ARG appear in image layers, leak in registries
**Why it happens:** ENV ANTHROPIC_API_KEY=sk-... in Dockerfile for "testing"
**How to avoid:** Pass secrets at runtime via environment variables in createContainer()
**Warning signs:** docker history shows API keys, registry scans detect secrets

### Pitfall 5: Shell-Form CMD Breaking Signals
**What goes wrong:** CMD python app.py runs as child of /bin/sh, doesn't receive SIGTERM, container takes full timeout to stop
**Why it happens:** Shell form (no brackets) wraps command in /bin/sh -c
**How to avoid:** Use exec form: CMD ["python", "app.py"]
**Warning signs:** Container stop takes exactly 10 seconds (default timeout), no graceful shutdown

### Pitfall 6: Using :latest Image Tag
**What goes wrong:** Image that passed security scan yesterday fails today due to upstream changes
**Why it happens:** :latest is mutable, points to different content over time
**How to avoid:** Pin specific versions: alpine:3.18, node:20.11-alpine
**Warning signs:** Builds break unexpectedly, security scans show new vulnerabilities in "unchanged" images

### Pitfall 7: Inadequate Resource Limits
**What goes wrong:** Runaway agent process consumes all host memory/CPU, impacts other services
**Why it happens:** Missing Memory/NanoCpus in HostConfig
**How to avoid:** Set explicit limits: Memory (bytes), NanoCpus (1e9 = 1 CPU), PidsLimit
**Warning signs:** Host becomes unresponsive, OOMKiller terminates processes

## Code Examples

Verified patterns from official sources:

### Complete Dockerfile for Agent Container
```dockerfile
# Source: Alpine Docker best practices + OWASP Docker Security
FROM node:20.11-alpine3.18

# Install only required packages, no cache
RUN apk add --no-cache \
    bash \
    git \
    ca-certificates

# Create non-root user
RUN addgroup -g 1001 -S agent && \
    adduser -u 1001 -S agent -G agent

# Set up workspace
WORKDIR /workspace
RUN chown agent:agent /workspace

# Copy application files
COPY --chown=agent:agent package*.json ./
RUN npm ci --only=production

COPY --chown=agent:agent . .

# Switch to non-root user
USER agent

# Use exec form for proper signal handling
CMD ["node", "executor.js"]
```

### Container Creation with Security Hardening
```typescript
// Source: OWASP Docker Security + Docker Docs
async createSecureContainer(
  image: string,
  workspaceDir: string
): Promise<Docker.Container> {
  return await this.docker.createContainer({
    Image: image,
    User: 'agent:agent', // Non-root execution

    // Complete network isolation
    NetworkMode: 'none',

    HostConfig: {
      // Resource limits
      Memory: 512 * 1024 * 1024, // 512MB
      MemorySwap: 512 * 1024 * 1024, // No swap
      NanoCpus: 1000000000, // 1 CPU
      PidsLimit: 100, // Max processes

      // Filesystem security
      ReadonlyRootfs: true,
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,size=100m'
      },

      // Mount workspace (read-write for agent)
      Binds: [
        `${workspaceDir}:/workspace:rw`
      ],

      // Security options
      SecurityOpt: [
        'no-new-privileges:true' // Prevent privilege escalation
      ],

      // Drop all capabilities, add only needed ones
      CapDrop: ['ALL'],
      CapAdd: [], // Add specific caps if needed
    },

    WorkingDir: '/workspace',

    // Use exec form for signal handling
    Cmd: ['node', 'executor.js']
  });
}
```

### Anthropic SDK Streaming Integration
```typescript
// Source: https://github.com/anthropics/anthropic-sdk-typescript
import Anthropic from '@anthropic-ai/sdk';

class AgentCommunication {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  async streamAgentExecution(
    userMessage: string,
    onChunk: (text: string) => void
  ): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: userMessage }
      ]
    });

    // Real-time text streaming
    stream.on('text', (text) => {
      onChunk(text);
    });

    // Handle errors
    stream.on('error', (error) => {
      console.error('Stream error:', error);
    });

    // Get final message with usage stats
    const finalMessage = await stream.finalMessage();
    console.log('Tokens used:', finalMessage.usage);

    return finalMessage;
  }
}
```

### Graceful Container Teardown
```typescript
// Source: Docker cleanup best practices 2026
async teardownContainer(
  container: Docker.Container,
  timeoutSeconds: number = 10
): Promise<void> {
  try {
    // Send SIGTERM for graceful shutdown
    await container.stop({ t: timeoutSeconds });
    console.log('Container stopped gracefully');
  } catch (error) {
    if (error.statusCode === 304) {
      // Already stopped
      console.log('Container already stopped');
    } else {
      // Force kill on error
      console.warn('Forcing container kill:', error.message);
      await container.kill({ signal: 'SIGKILL' });
    }
  } finally {
    // Remove container
    try {
      await container.remove({ force: true });
      console.log('Container removed');
    } catch (error) {
      console.error('Failed to remove container:', error.message);
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Traditional containers with iptables rules | Docker Sandboxes with microVMs | 2025 | Stronger isolation, private Docker daemons per sandbox |
| Devcontainer with firewall whitelist | Network mode: none + orchestrator API | 2024-2025 | Simpler, complete isolation vs partial firewall |
| Callback-based Docker API | Promise/async-await with dockerode 4.x | 2023 | Cleaner code, better error handling |
| Claude API v1 completion | Messages API with streaming | 2023 | Real-time responses, tool use support |
| Alpine 3.14 | Alpine 3.18+ | 2023 | Security updates, CVE patches |

**Deprecated/outdated:**
- **Docker Swarm for orchestration:** Kubernetes won, Swarm maintenance mode since 2019
- **Mounting /var/run/docker.sock for "Docker-in-Docker":** Security anti-pattern, use proper orchestrator
- **Ubuntu base images for agents:** 10x larger than Alpine, unnecessary attack surface
- **Non-streaming Messages API:** Streaming is standard for real-time agent UX
- **docker-compose for single-container lifecycle:** Overkill, use dockerode programmatically

## Open Questions

Things that couldn't be fully resolved:

1. **Docker Sandbox vs Container Isolation**
   - What we know: Docker Sandboxes (microVMs) provide stronger isolation with private Docker daemons
   - What's unclear: Whether the added complexity of microVMs is justified for this phase vs standard containers with network: none
   - Recommendation: Start with standard containers + network isolation (simpler). Revisit if threat model requires microVM isolation.

2. **Optimal Resource Limits**
   - What we know: Memory, CPU, PidsLimit should be set to prevent DoS
   - What's unclear: Exact values depend on workload (unknown at this phase)
   - Recommendation: Conservative defaults (512MB RAM, 1 CPU, 100 pids). Monitor and adjust in later phases.

3. **Container Image Caching Strategy**
   - What we know: Pre-built images start faster than building on-demand
   - What's unclear: Whether to build image once at startup or rebuild per session
   - Recommendation: Build once, reuse across sessions. Rebuild only on Dockerfile changes.

## Sources

### Primary (HIGH confidence)
- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) - API patterns, streaming
- [Anthropic Streaming Messages API](https://platform.claude.com/docs/en/api/messages-streaming) - Event types, error handling
- [Docker Security Documentation](https://docs.docker.com/engine/security/) - Isolation, namespaces, capabilities
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) - MicroVM architecture
- [dockerode GitHub](https://github.com/apocas/dockerode) - API examples, stream handling
- [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html) - Security best practices

### Secondary (MEDIUM confidence)
- [Docker Sandboxes: A New Approach for Coding Agent Safety](https://www.docker.com/blog/docker-sandboxes-a-new-approach-for-coding-agent-safety/) - 2026 architecture patterns
- [Running Claude Code Agents in Docker Containers](https://medium.com/@dan.avila7/running-claude-code-agents-in-docker-containers-for-complete-isolation-63036a2ef6f4) - Isolation patterns
- [MCP Security Issues](https://www.docker.com/blog/mcp-security-issues-threatening-ai-infrastructure/) - AI agent security threats
- [Container Security in 2026](https://www.cloud4c.com/blogs/container-security-in-2026-risks-and-strategies) - Current threat landscape

### Tertiary (LOW confidence)
- Community repositories (claude-code-sandbox, claude-container) - Implementation examples, not authoritative

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Official SDKs and widely adopted tools (dockerode, Anthropic SDK, Alpine)
- Architecture: HIGH - Patterns verified in official Docker and Anthropic documentation
- Pitfalls: HIGH - Derived from OWASP, Docker official docs, and 2026 security research

**Research date:** 2026-01-26
**Valid until:** 2026-02-26 (30 days - stable stack, but security landscape changes frequently)
