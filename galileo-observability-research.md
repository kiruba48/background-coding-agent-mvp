# Galileo (Splunk Agent Observability): Research Findings

**Date:** 2026-10-07
**Status:** Research only. No code changes.
**Scope:** Find out what Galileo ([galileo.ai](https://galileo.ai/)) offers and whether it fits the background coding agent's evaluation and observability needs.
**Related:** `memory/project_managed_agents_comparison.md` (hosting strategy), `daytona-integration-research.md` (corporate-deployment roadmap)

---

## TL;DR

- **Galileo no longer exists as an independent product.** Cisco closed the acquisition on 2026-05-22. Since **2026-08-07** it is sold as **Splunk Agent Observability**: `galileo.ai/pricing` now redirects to splunk.com. Existing Galileo customers keep the old docs.
- **What it does:** it traces LLM and agent runs, scores them with 20+ built-in evaluators (including agent-specific metrics), runs experiments against datasets, and offers runtime guardrails using its small "Luna" judge models.
- **Fit with our app: partial.** Its strongest overlap is with our biggest gap: we have **no persistent traces and no regression evals**. `MetricsCollector` keeps data in memory only, and cost data appears only in pino logs. Its weakest overlap is the headline features (hallucination/RAG metrics, Luna guardrails). Our ground truth already comes from deterministic signals (build, test and lint in the verifier) plus our own LLM judge.
- **Recommendation:** don't commit to Galileo as a platform yet. First, **instrument with vendor-neutral OpenTelemetry**. The Claude Agent SDK already emits OTel, so this step is useful whichever backend we pick. Then run a **time-boxed spike** that sends those traces to Galileo, to check whether its agent metrics actually work on `claude_code.*` spans. Decide after that.

---

## 0. Update 2026-10-07: what the Splunk AO docs change

Source: [agent-observability-docs.splunk.com](https://agent-observability-docs.splunk.com/what-is-splunk-agent-observability)

| Topic | Old Galileo docs | Splunk AO docs (current) |
|---|---|---|
| Names | Log stream, `GALILEO_*` env vars | **Agent Stream**, `SPLUNK_AO_*` env vars |
| SaaS setup | API key + console URL | **Realm + Splunk Observability Cloud access token.** Variables: `SPLUNK_AO_REALM`, `SPLUNK_AO_O11Y_TOKEN`. The token needs the **INGEST** scope plus the `agent_observability_admin` role |
| SaaS OTLP endpoint | `api.galileo.ai/otel/traces` | **`https://ingest.<realm>.observability.splunkcloud.com/v2/trace/otlp`** |
| On-prem OTLP endpoint | n/a | `<api-url>/otel/v1/traces` with headers `Splunk-AO-API-Key`, `project`, `agentstream` |
| Routing | Headers | **Verified 2026-10-07:** send header `project` + **`logstream`** and resource attrs `splunk_ao.project.name` + **`splunk_ao.logstream.name`**. That's what the official Python SDK v0.4.0 does. The documented `agentstream` keys did **not** land traces in the Agent Stream |
| SDKs | Python + TypeScript | **Only Python is documented** (`splunk_ao`, `SplunkAOSpanProcessor`). No TS SDK in the new docs, so we'd use plain OpenTelemetry JS |

**Span validity rules (important for us).** For a span to be valid, it must carry GenAI semantic-convention attributes:
- `gen_ai.operation.name` (`invoke_agent` / `chat` / `execute_tool`)
- `gen_ai.provider.name`
- `gen_ai.tool.name` on tool spans
- input/output content via `gen_ai.input.messages` / `gen_ai.output.messages` (or the OpenInference `input.value` / `output.value`)

Error spans need `error.type` and status `ERROR`.

**Claude Agent SDK spans do not meet these rules.** Checked against the [Claude Code monitoring reference](https://code.claude.com/docs/en/monitoring-usage):
- They use the custom names `claude_code.interaction`, `claude_code.llm_request` and `claude_code.tool`.
- They set `gen_ai.system` (the old attribute name), `gen_ai.request.model` and `gen_ai.tool.call.id`.
- They do **not** set `gen_ai.operation.name`, `gen_ai.provider.name` or `gen_ai.tool.name`, and LLM spans carry **no input/output messages**. Message content only appears as separate log events (`OTEL_LOG_RAW_API_BODIES`), which AO does not ingest because it accepts traces only.

**Consequence:** sending the SDK's own OTel output straight to AO will most likely produce rejected or empty spans, with no agent evaluators. **The integration point is our host process.** We build GenAI-compliant spans from the SDK message stream, which already contains every assistant message, `tool_use` and `tool_result`, and export them with the OpenTelemetry JS SDK. Section 6, step 3 is revised accordingly.

**Spike result (2026-10-07):** a hand-built trace (`invoke_agent` → `chat` + `execute_tool`) sent from TypeScript with plain OpenTelemetry was accepted (response `{"valid":3}`) and shown in the `dev` Agent Stream. The agent, LLM and tool step types were recognised and the input/output messages were displayed. The OTel JS exporter logs a harmless "could not deserialize response" warning because the ingest endpoint replies in JSON, not protobuf. Script: scratchpad `splunk-spike/spike.ts`.

**Evaluator results over OTLP (2026-10-07):**

| Evaluator | Result |
|---|---|
| Action Completion | ✅ scored (true) |
| Agent Efficiency | ✅ scored (true) |
| Tool Error Rate | ✅ scored (no error) |
| Token counts (`gen_ai.usage.*`) | ✅ recorded |
| Tool Selection Quality | ❌ `not_applicable`: "requires the available tools to be logged on the LLM span, but none were found" |
| Cost | ❌ empty. Our `splunk_ao.llm.cost.total_usd` is ignored; Splunk probably prices from its model table |

For Tool Selection Quality, four ways of attaching the tool list were tried over OTLP, and all were ignored:
- `gen_ai.tool.definitions`
- `splunk_ao.tool.definitions`
- the `splunk_ao.system` marker
- OpenInference `llm.tools.*`

The REST ingest API (`POST /v2/projects/{id}/spans`, the path used by the SDK's native logger) has an explicit `tools` field.

**Integration verified, host side (2026-10-07).** The `src/telemetry/` integration ran end to end against `eu0` / `bg-agent-spike` / `dev`. Four real `npm-dependency-update` runs used a small local repo; all exited 0 with `finalStatus: success`. Each log showed `Splunk AO telemetry enabled` and no `telemetry_export_failed` or `telemetry_flush_timeout`. One of those runs used `SPLUNK_AO_CAPTURE_CONTENT=false`, and its log showed `captureContent:false`. Since the fix commit, each run logs `agent_run_started` with `runId` (= `gen_ai.conversation.id` / `splunk_ao.session.id`) and `traceId`, so a pino log can be matched to its Splunk trace.

A run-shaped trace built with the real helpers was POSTed straight to the ingest endpoint. It contained the root, `attempt 1`, `invoke_agent claude-code`, `chat` ×2, `execute_tool`, `verify` and `judge`, and the response was `{"valid":8}`. **Caveat:** a bare span with no `gen_ai.*` attributes also returns `{"valid":1}`. So the ingest `valid` count only means the span was accepted. It does not check the span-validity rules above, and the UI is the only real check. The workflow spans (`attempt N`, `verify`, `judge`) carry `gen_ai.provider.name` and input/output messages, but no `gen_ai.operation.name`, because semconv has no "workflow" operation.

**Verified in Splunk through the AO REST API (2026-10-07).** The checks used `POST https://app.<realm>.observability.splunkcloud.com/ao/api/v2/projects/<id>/{spans,traces,sessions}/search` with `X-SF-Token`, so no browser was needed.
- **Span tree.** `invoke_agent background-coding-agent` (agent) → `attempt 1` (workflow) → `invoke_agent claude-code` (agent) → `chat …` (llm) / `execute_tool …` (tool). `verify` and `judge` are workflow spans under the attempt. Splunk types `attempt`/`verify`/`judge` as **workflow** without `gen_ai.operation.name`, so no operation name is needed.
- **Sessions.** The session id is the run's `runId`, and the capture-off run's session input shows `[redacted]`.
- **Tokens and cost.** Both are recorded per chat span and rolled up per session, about $0.14 for one lodash run. `claude-sonnet-4-6` is priced; the spike's model was not.
- **Evaluators.** Both session-level agent evaluators (`0086796d…`, `6ab3aa2c…`: Action Completion / Agent Efficiency) scored `success`. Tool Error Rate scores every tool span and rolls up. Tool Selection Quality is `not_applicable`, as expected. Session evaluators read `pending`, and roll-ups can briefly read `failed`, for 1–3 minutes after a run.
- **Tool Error Rate found a real app issue.** `mcp__verifier__verify` fails inside the session with "Claude requested permissions to use mcp__verifier__verify, but you haven't granted it yet". The in-session verifier MCP tool is not permitted, and the host-side verifier still runs afterwards. This needs a separate follow-up.

**Two defects were found and fixed during verification:**
1. **Runs split across two sessions.** This happened in 3 of 4 runs. `splunk_ao.session.id` was only on the root span. `BatchSpanProcessor` exports early chat and tool spans before the root ends, so Splunk put them in an orphan session. The fix carries the session id in the OTel Context and stamps `splunk_ao.session.id` + `gen_ai.conversation.id` on every span. Two later runs each produced a single session.
2. **Chat input was empty after the first turn.** Splunk silently drops `tool_call_response` parts, under any role, and renders only `text` parts. Tool results are now sent as role `tool` with both a `tool_call_response` part (semconv) and a `text` part. Chat spans now show the tool results as input.

---

## 1. What the platform provides

| Area | What it is | Notes |
|---|---|---|
| **Tracing / observability** | Sessions → traces → spans. Includes Graph View, Timeline View and Conversation View, plus log streams, global dashboards, and alerts with webhooks (Jul 2026) | Accepts native SDK logging (Python/TS) **or OTLP**: `https://api.galileo.ai/otel/traces` with `Galileo-API-Key`, `project` and `logstream` headers |
| **Evaluators ("metrics")** | 20+ built-in evaluators covering RAG, safety, security and agents | Agent metrics: **Action Completion, Tool Selection Quality, Action Advancement, Agent Flow, Agent Efficiency, Reasoning Coherence**, Conversation Quality and User Intent Change |
| **Custom metrics** | LLM-as-judge or code-based metrics. "Help me write" AI-generates code metrics (Jul 2026) | Autotune adjusts LLM metrics based on human feedback |
| **Experiments & datasets** | Run an app or prompt over a dataset, compare and rank runs, group experiments. Synthetic data generation is available in the SDK | Public APIs for log streams and experiments |
| **Insights / AI Assistant** | "Insights Engine" detects failure patterns and suggests fixes. An AI Assistant answers debugging questions with links to evidence | |
| **Annotation queues** | Route traces to subject-matter experts for human review (GA Aug 2026) | |
| **Guardrails ("Protect")** | Turns offline metrics into runtime blocking or escalation, backed by the **Luna-2** small models | Vendor claims sub-200 ms latency and ~97% lower cost than a GPT-4 judge. Luna access was Enterprise-only |
| **MCP server** | Brings eval insights into the IDE (Oct 2025) | |
| **Deployment** | SaaS, VPC, on-prem | Splunk now lists "Observability Cloud and self-hosted" |
| **SDKs** | Python and **TypeScript**. The TS SDK provides `GalileoSpanProcessor`, an OTel SpanProcessor | Ready-made integrations: LangGraph, CrewAI, Google ADK, Vercel AI SDK, Mastra, MS Agent Framework. **No Claude Agent SDK integration found.** |

**Pricing (current Splunk listing):** "from $100/month per 1.2M spans annually, billed annually". This includes 500M Luna tokens and 5 Luna fine-tuning runs per year. Before the rebrand there was a free tier (5k traces/month) and a Pro plan at $100/month for 50k traces. **I could not confirm that the free tier still exists after the rebrand.**

Rough sizing (my estimate, not measured): one session produces roughly 30–60 LLM requests and tool calls, which comes to about 60–120 spans. That makes 1.2M spans/year roughly **10–20k agent sessions/year**, which is comfortably above our current volume.

---

## 2. What we have today (baseline)

| Concern | Current implementation | Gap |
|---|---|---|
| Run outcomes | `src/orchestrator/metrics.ts` `MetricsCollector` tracks merge, veto and failure rates plus turns and duration | **In memory, per process.** Lost on exit, with no history |
| Cost/tokens | `claude-code-session.ts:199` logs `sdk_session_cost` (`total_cost_usd`, `usage`) to pino | Only in logs. Not aggregated or queryable |
| Step-level trace | None. Only the SDK message stream and pino logs | You can't see *why* a session took 40 turns or which tool calls failed |
| Correctness | Composite verifier (build/test/lint) + zero-diff check + LLM judge (`claude-haiku-4-5`, `judge.ts`) | Strong per run, but **no regression suite**. Changes to prompts, models or recipes ship without a before/after comparison |
| Human feedback | PR merged or closed on GitHub | Never fed back into any metric |

---

## 3. Fit analysis, feature by feature

### High fit

**1. Agent-run tracing via OTel (very little code).** The Claude Agent SDK's CLI already emits OTel traces (`claude_code.interaction`, `claude_code.llm_request`, `claude_code.tool`), metrics (tokens, cost, lines changed) and log events. Enabling it only requires env vars (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, `OTEL_*_EXPORTER=otlp`). The SDK also propagates `TRACEPARENT` automatically. If `runAgent()` opens a parent span, every Claude Code span nests under it.

**2. Pipeline-level trace with our domain signals.** This is where the real value is. One trace per task: `intent → scoping → runAgent → [attempt N: session → verifier → judge] → PR`. The verifier result, judge verdict, retry count, zero-diff flag and later the PR merge are recorded as span attributes or feedback. No vendor can see these by default, and this is the "domain layer" moat.

**3. Experiments for regression testing.** We change prompts often (`buildGenericPrompt`, end-state prompting, recipes). A fixed dataset of tasks × repos, re-run per change and scored by **our** verifier pass rate + judge verdict + cost/turns, is the missing safety net. Galileo's Experiments feature can host the comparison UI, but the scorer has to be ours.

### Medium fit

- **Agent metrics** (Action Completion, Tool Selection Quality, Agent Efficiency). These could add a second opinion next to our judge, e.g. flagging sessions with lots of wasted tool calls. **Open question:** do they compute on `claude_code.*` spans? Galileo's OTel integrations are built around frameworks that emit GenAI/OpenInference semantic conventions. Claude Code uses its own span names, which may just render as generic spans with no agent metrics. This is the main thing the spike has to answer.
- **Annotation queues**: useful once a reviewer team labels vetoed or failed runs.
- **Insights Engine**: nice to have once volume is high enough for patterns to emerge.

### Low fit

- **RAG, hallucination and context-adherence metrics.** Our output is a diff that a compiler and tests verify. These metrics target chat and RAG apps.
- **Luna guardrails in the runtime path.** Our guardrails are structural: Docker with cap-drop, an iptables egress allowlist, `:ro` mounts and PreToolUse Write/Edit blocks. A probabilistic guard adds latency and a vendor dependency to the critical path for little gain. On top of that, Luna is Enterprise-only.
- **Replacing our LLM judge.** The judge decides whether a PR gets created. Keep it in-process and fail-open, as it is today.

---

## 4. Integration constraints specific to our architecture

1. **The container firewall blocks it.** `docker/entrypoint.sh` resolves only `api.anthropic.com` and then `DROP`s all other egress. The Claude Code CLI runs **inside** that container, so its OTel exporter can't reach `api.galileo.ai`. Options:
   - (a) Add the Galileo IPs to the allowlist. This is simple but widens egress from an untrusted-code sandbox.
   - (b) **Preferred:** run an **OTel Collector** on the host or on `agent-net`, and allowlist only that collector. The collector handles redaction, sampling and fan-out to Galileo, Splunk or another backend. This also keeps us vendor-neutral.
2. **Env passthrough.** `src/cli/docker/index.ts:79` forwards only `-e ANTHROPIC_API_KEY`. The `OTEL_*` and `CLAUDE_CODE_*` telemetry vars need to be added. In TS, `options.env` *replaces* the inherited env (`claude-code-session.ts:371` already builds an explicit env object).
3. **Short-lived processes lose spans.** The CLI batches exports, and on abort we `docker kill` after a 5 s grace period. We need to lower `OTEL_TRACES_EXPORT_INTERVAL`/`OTEL_LOGS_EXPORT_INTERVAL` and accept some loss on cancelled runs.
4. **Content and data sensitivity.** By default, telemetry is structural only: no prompts, no file contents. Galileo's LLM-based agent metrics need content (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`), which means **sending customer source code to a third party**. For the corporate-deployment roadmap this points to self-hosted Splunk/Galileo or redaction in the collector.
5. **Tracing is beta in the Claude Agent SDK.** Span names and attributes may change between releases.

---

## 5. Vendor considerations

- **Ownership change is a risk.** Galileo is now one product inside Splunk Observability (Cisco). Expect the roadmap to follow Splunk, enterprise-oriented packaging, and pricing that has already shifted to annual span-based billing. That works well for teams already on Splunk and is a heavier commitment for everyone else.
- **OTel keeps us portable.** If we instrument with OTel and route through our own collector, Galileo becomes one possible *backend* rather than an SDK baked into the codebase. Other OTel-ingesting eval/observability tools (e.g. Langfuse, Arize Phoenix, Braintrust, LangSmith) can be compared on the same data. I have not re-verified their current features or pricing for this note.
- This lines up with the hosting-strategy memo: adopt external platforms for commodity layers and keep the domain layer (verifier, judge, recipes) ours.

---

## 6. Recommended next steps

| # | Step | Effort | Vendor-specific? |
|---|---|---|---|
| 1 | Persist run records: append a JSONL/SQLite row per run with status, attempts, verifier and judge results, cost, turns, duration and PR URL. This replaces the in-memory-only `MetricsCollector` | S | No |
| 2 | Wrap `runAgent()` in an OTel root span, with child spans for retry attempt, verifier, judge and PR, and domain attributes on each | S–M | No |
| 3 | ~~Enable the SDK's built-in telemetry~~ *(revised, see §0)*. Emit GenAI-semconv spans **from the host** while consuming the SDK message stream: `invoke_agent` per session, `chat` per assistant turn, `execute_tool` per tool_use/tool_result pair. The container firewall needs no change because export happens on the host | M | No (standard semconv) |
| 4 | **Spike (≤2 days):** export the step-2/3 spans to Splunk AO (SaaS ingest endpoint). Check (a) whether spans are accepted and nest correctly, (b) whether Action Completion and Tool Selection Quality compute, (c) cost per session | S | Yes |
| 5 | Build a regression dataset (10–20 tasks across npm and Maven repos) scored by verifier + judge, and run it per prompt/model change. Host the results in Galileo Experiments only if the spike succeeds | M | Optional |

**Decision gate after step 4:** adopt Galileo if its agent metrics work on our spans and the data-residency story (self-hosted or redaction) holds up. If not, keep the OTel pipeline and compare an open-source backend.

---

## Sources

- [Galileo homepage](https://galileo.ai/)
- [Galileo release notes](https://docs.galileo.ai/release-notes): Splunk rebrand on 2026-08-07, agent metrics, MCP server, experiments
- [Splunk Agent Observability pricing](https://www.splunk.com/en_us/products/pricing.html#agent-observability)
- [Cisco: intent to acquire Galileo](https://blogs.cisco.com/news/cisco-announces-the-intent-to-acquire-galileo) · [Splunk: Galileo acquisition](https://www.splunk.com/en_us/about-splunk/acquisitions/galileo.html)
- [Galileo OTel integration recommendations](https://docs.galileo.ai/sdk-api/third-party-integrations/opentelemetry-and-openinference/integration-recommendations): OTLP endpoint and headers
- [Galileo agent evaluation blog](https://galileo.ai/blog/ai-agent-evaluation) · [Introducing Agentic Evaluations](https://galileo.ai/blog/introducing-agentic-evaluations)
- [Galileo SDK examples (Python/TS)](https://github.com/rungalileo/sdk-examples)
- [Claude Agent SDK: Observability with OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability)
- Pre-rebrand pricing (third party): [cekura.ai](https://www.cekura.ai/blogs/galileo-ai-pricing), [befailproof.ai](https://befailproof.ai/answers/galileo-pricing/)
