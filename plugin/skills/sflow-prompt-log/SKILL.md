---
name: sflow-prompt-log
description: Enable, disable, inspect, or display the workspace-local audit log of governed prompts Singularity Flow sends to Copilot for each agent and Story phase. Use when a contributor or reviewer needs prompt provenance without changing workflow state.
disable-model-invocation: true

---

# Manage governed prompt auditing

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Interpret `$ARGUMENTS` as one of `on`, `off`, `status`, `list`, `view <record-id>`, `retention`, `repair`, or `clear`; use `status` when no action is supplied.
2. Run `singularity-flow prompt-log <action>`, forwarding filters such as `--agent`, `--phase`, `--work-id`, and `--limit` unchanged.
3. Explain that capture is off by default, machine-local, and applies only to future `singularity-flow wm compose` handoffs. It does not backfill prompts or change workflow state.
4. For `list`, reproduce the complete table. For `view`, run `singularity-flow prompt-log view <id>` and preserve its Context, Model and execution, Tools, Tokens and cost, Request and output, Grounding, and Prompt sections in that order. Use `--json` only when structured machine data is requested and `--raw` only when the user explicitly asks for prompt text alone.
5. Keep tool authorization distinct from observed tool calls. An allowlist says what the model could use; it does not prove a tool was called. Preserve `unavailable` token and cost values rather than converting them to zero. The prompt-only token value is an explicitly labelled estimate, not provider billing usage.
6. Never claim this captures Copilot's hidden system prompt, chat history, provider internals, response body, or individual host tool calls. It captures governed prompts assembled by Singularity Flow and, for kernel-owned invocations, joins the separate content-free invocation audit.
7. Warn that prompts can contain proprietary requirements and source context. The logger removes recognized token shapes, records any redaction count, and stores the result only in the selected workspace (or the repository-local Git control area when no workspace is active).
8. Use `singularity-flow prompt-log retention --retention-days <1..365>` to change the default 30-day retention. Repair requires the exact confirmation `--confirm "REPAIR PROMPT AUDIT"`; it preserves the original private bytes before excluding unsafe records and resealing valid history. Clear requires `--confirm "DELETE PROMPT AUDIT"` and permanently removes active history and recovery copies.
9. Preserve integrity warnings. Current records use a machine-local HMAC chain; older v1 records are labelled `legacy-unsealed` until an explicitly confirmed repair reseals them. Never describe this as independent or server-backed attestation.
