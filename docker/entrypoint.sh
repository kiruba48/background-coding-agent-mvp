#!/bin/bash
set -e

# Resolve Anthropic API IPs for firewall allowlist
ANTHROPIC_IPS=""
for i in 1 2 3; do
  ANTHROPIC_IPS=$(dig +short api.anthropic.com A 2>/dev/null)
  [ -n "$ANTHROPIC_IPS" ] && break
  sleep 1
done

# Allow loopback (localhost)
iptables -A OUTPUT -o lo -j ACCEPT

# Allow established/related connections (responses)
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS (UDP and TCP port 53)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

if [ -n "$ANTHROPIC_IPS" ]; then
  for IP in $ANTHROPIC_IPS; do
    iptables -A OUTPUT -p tcp --dport 443 -d "$IP" -j ACCEPT
  done
  # Block everything else
  iptables -A OUTPUT -j DROP
else
  # DNS fallback: allow all TCP 443 if resolution failed
  echo "WARNING: Failed to resolve api.anthropic.com — allowing all TCP 443" >&2
  iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
  iptables -A OUTPUT -j DROP
fi

# Drop from root to agent user and exec the provided command
exec su-exec agent "$@"
