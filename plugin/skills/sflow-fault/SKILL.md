---
name: sflow-fault
description: Record, list, or inspect an immutable Singularity Flow fault without treating the report as repair authority.
disable-model-invocation: true

---

# Fault intake

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal or any stop, relay the returned route before ending: `remediationPlan` steps, else `commandGuidance`, `nextAction`, `continuation.actions` or `recovery.actions`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition; run a returned action only when the person asks.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Use this skill when a developer, test runner, CI job, IDE, or monitoring tool says something is broken.

1. For an existing fault, run `singularity-flow fault show <FAULT-ID> --json` and reproduce its observed fields without upgrading them into conclusions.
2. For a new report, collect source, environment, failure type, failing command, exit code, message, build/commit, Story when known, and immutable evidence references. Do not request or reveal credentials, tokens, raw hidden reasoning, or unrestricted chat history.
3. Preview the exact command. Prefer structured argv so Windows paths and quoting remain exact: `singularity-flow fault report --source <SOURCE> --environment <ENVIRONMENT> --type <TYPE> [--build <ID>] [--commit <SHA>] [--story <WORK-ID>] [--command-argv '<JSON-ARRAY>'] [--exit-code <UNSIGNED-32-BIT-CODE>] [--message <TEXT>] [--log <FILE>]... [--idempotency-key <KEY>] --json`. Retain `--command <COMMAND>` only for compatibility with simple shell input. Pass `--story` only for a known Story; a fault needs none.
4. Explain that the fault is evidence, not authority. Reporting it does not permit code changes, approval, merge, release, deployment, or production mutation.
5. Offer `/sf-fix <FAULT-ID>` for deterministic diagnosis and a policy-bounded repair plan.

Never invent evidence hashes, claim a model hypothesis is observed, or start a recursive repair from inside a repair attempt. Secret redaction is a last safety boundary, not permission to solicit or knowingly submit credentials.
