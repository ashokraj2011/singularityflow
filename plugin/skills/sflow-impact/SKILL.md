---
name: sflow-impact
description: Inspect, classify, attest, verify, compare, and export governed Story delivery measurements without inventing evidence or causal claims.
disable-model-invocation: true
agent: agent
argument-hint: "[status|study|enroll|exposure|evidence|finalize|verify|compare|export|doctor] [ARGS]"

---
# Govern delivery measurement

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. With no arguments, run `singularity-flow impact status`.
2. Before `enroll`, show the engine's suggested complexity/risk signals. Require the user to supply both bands and explicitly request `--confirm`; never confirm or opt out on their behalf.
3. Before `exposure attest`, explain that an attestation is self-reported evidence. Require the phase, exposure level, assurance, and a reason when supplied by the user.
4. Import only a user-selected JSON or YAML evidence envelope. For a raw provider observation, use `singularity-flow impact evidence collect <PROVIDER> <FILE> --commit <FULL-SHA> --run-id <ID>` so the engine creates the strict envelope. Do not rewrite provider observations or replace `unavailable` with estimates.
5. `finalize` is valid only for a closed Story and creates a hash-bound Impact Receipt through the normal publication transaction.
6. For `compare`, preserve the engine's method, evidence grade, privacy-floor refusal, uncertainty interval, guardrail result, and exact inference label. Matched observational and before/after results are not causal.
7. For a prompt-set study, use `singularity-flow impact study prompt-hash <singularity/prompts/FILE.md>` for each reviewed prompt. Never calculate or substitute a hash yourself. Explain that Story assignment is deterministic, the assigned variant is disclosed, and an agent override would contaminate and therefore block the comparison.
8. Mutating operations commit and push through Singularity Flow. Report the commit or pending-publication state and the next valid action.
