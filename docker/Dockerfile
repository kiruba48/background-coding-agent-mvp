# Stage 1: Node.js base with essential tools
FROM node:20-alpine AS nodejs-base

RUN apk add --no-cache \
    bash \
    git \
    ca-certificates \
    ripgrep \
    iptables \
    bind-tools \
    su-exec

# Stage 2: Add Java and Maven for Maven task support
FROM nodejs-base AS multi-runtime

RUN apk add --no-cache \
    openjdk17-jre-headless \
    maven

# Stage 3: Final agent image with Claude Code CLI
FROM multi-runtime AS agent

# Install Claude Code CLI globally at pinned version
RUN npm install -g @anthropic-ai/claude-code@2.1.79

# Create non-root user with specific UID/GID
RUN addgroup -g 1001 -S agent && \
    adduser -u 1001 -S agent -G agent -h /home/agent

# Create workspace directory owned by agent user
WORKDIR /workspace
RUN chown agent:agent /workspace

# Copy entrypoint script — runs as root to configure iptables, then drops to agent
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Entrypoint handles privilege drop to agent user via su-exec
# Do NOT set USER agent — entrypoint runs as root first, drops via su-exec
# Do NOT set CMD — the SDK passes the claude command as args
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
