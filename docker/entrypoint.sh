#!/bin/bash
set -e

# Resolve Anthropic API IPs for firewall allowlist
ANTHROPIC_IPS=""
for i in 1 2 3; do
  # Filter dig output to valid IPv4 addresses only (V-4: reject CNAMEs/errors)
  ANTHROPIC_IPS=$(dig +short api.anthropic.com A 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
  [ -n "$ANTHROPIC_IPS" ] && break
  sleep 1
done

# V-3: Fail hard if DNS resolution fails — do NOT degrade to allow-all
if [ -z "$ANTHROPIC_IPS" ]; then
  echo "FATAL: Failed to resolve api.anthropic.com after 3 retries — refusing to start without network isolation" >&2
  exit 1
fi

# Allow loopback (localhost)
iptables -A OUTPUT -o lo -j ACCEPT

# Allow established/related connections (responses)
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS (UDP and TCP port 53)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Allow HTTPS to Anthropic IPs only
for IP in $ANTHROPIC_IPS; do
  iptables -A OUTPUT -p tcp --dport 443 -d "$IP" -j ACCEPT
done

# Block everything else
iptables -A OUTPUT -j DROP

# Drop from root to agent user and exec the provided command
exec su-exec agent "$@"
