---
name: sflow-fault
description: Record, list, or inspect an immutable Singularity Flow fault without treating the report as repair authority.
disable-model-invocation: true

---

# Fault intake

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. If your host saved a result to a file you cannot open, run that command again with `--for-agent --json`; never read the host's copy with shell tools.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Use this skill when a developer, test runner, CI job, IDE, or monitoring tool says something is broken.

1. For an existing fault, run `singularity-flow fault show <FAULT-ID> --json` and reproduce its observed fields without upgrading them into conclusions.
2. For a new report, collect source, environment, failure type, failing command, exit code, message, build/commit, Story when known, and immutable evidence references. Do not request or reveal credentials, tokens, raw hidden reasoning, or unrestricted chat history.
3. Preview the exact command. Prefer structured argv so Windows paths and quoting remain exact: `singularity-flow fault report --source <SOURCE> --environment <ENVIRONMENT> --type <TYPE> [--build <ID>] [--commit <SHA>] [--story <WORK-ID>] [--command-argv '<JSON-ARRAY>'] [--exit-code <UNSIGNED-32-BIT-CODE>] [--message <TEXT>] [--log <FILE>]... [--idempotency-key <KEY>] --json`. Retain `--command <COMMAND>` only for compatibility with simple shell input.
4. Explain that the fault is evidence, not authority. Reporting it does not permit code changes, approval, merge, release, deployment, or production mutation.
5. Offer `/sf-fix <FAULT-ID>` for deterministic diagnosis and a policy-bounded repair plan.

Never invent evidence hashes, claim a model hypothesis is observed, or start a recursive repair from inside a repair attempt. Secret redaction is a last safety boundary, not permission to solicit or knowingly submit credentials.
