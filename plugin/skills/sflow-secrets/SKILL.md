---
name: sflow-secrets
description: Scan tracked or staged content for likely credentials and explicitly install repository secret protection.
disable-model-invocation: true
argument-hint: "scan [--staged] | protect"
---
# Scan and protect secrets

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow secrets scan --json`, adding `--staged` only when requested.
2. Report file paths, rule IDs, and remediation without reproducing detected credential values.
3. Before `singularity-flow secrets protect`, show the exact hook or configuration files that will change and require an explicit request. Use `--force` only after separately reviewing an existing installation conflict.
4. Secret scanning is deterministic and never sends file content to a model. Never print environment variables or add a detected secret to chat, logs, commits, or prompt context.

