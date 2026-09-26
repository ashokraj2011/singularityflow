---
name: sflow-workflows
description: List, preview, transfer, duplicate governed workflows, or explicitly share inert Git-backed workflow drafts.
disable-model-invocation: true
argument-hint: "[list|author list|author preview WFD-ID|author submit WFD-ID --revision N|skills-recipe ID ...|simulate ID|export ...|import FILE|copy SOURCE TARGET ...]"

---
# Workflow catalog, shared drafts, and transfer

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Run `singularity-flow workflow $ARGUMENTS`; default `list`.

For `author`, require an explicit opened Git root, without workspace fallback.
`list|read|history|show|preview|catalog|op-status` is read-only; relay exact revision, coverage and gaps.
Create/Save require user direction, unique operation ID, exact observed head and matching
`--expected-authority`. Input is inert payload/assets JSON. Never rebase text, change a replayed
request or recreate deleted drafts. Lost acknowledgement: `author op-status <ID> --json`.
Headless `author submit <WFD-ID> --revision N` or `author delete` only hands off:
never supply receipts, answers or tokens. Direct terminal captures the named human action.
Submit creates only an exact review proposal; no approval, activation or execution.

For installation, preview YAML/Markdown. No unconfirmed `--replace` or auto-commit.

Read-only BYO preview: `singularity-flow workflow skills-recipe <NEW-ID> --label <TEXT>
--phases <APPROVED-PHASE-IDS> --json`. Code requires explicit `--planned-claims required
--clause-phases <CRITERIA> --claim-owners <CODE=PLAN>`. Relay revision, sequence, pending approval
and unavailable host; never infer opt-out or import/confirm/execute. Proposals require separate authorization.

Export only explicit selections to a new file:
`singularity-flow workflow export --workflow <ID> [--workflow <ID>...] --out <FILE> --json`.
Report complete dependency closure and remote-agent locks. Policy/World Model contracts are prerequisites,
not imports. Never hand-edit bundles.

Import preview: `singularity-flow workflow import <FILE> --dry-run --propose --json`.
Skill invocation is not confirmation. After explicit digest/path/collision review and acceptance run
`singularity-flow workflow import <FILE> --confirm <PLAN-SHA256> --propose --json` once.
Never substitute a digest, overwrite collisions, or retry stale plans without a new review.

`duplicate` aliases `copy`. Require a distinct lower-kebab target and label. Preview:
`singularity-flow workflow copy <[story|initiative:]SOURCE> <TARGET> --label <TEXT> --dry-run --propose --json`.
Qualify ambiguous Story/Initiative IDs. Linked copies reuse dependencies; later shared edits affect
both, so never claim isolation. Show the exact plan/collisions and wait for explicit acceptance:
`singularity-flow workflow copy <[story|initiative:]SOURCE> <TARGET> --label <TEXT> --confirm <PLAN-SHA256> --propose --json`.
Run once; never overwrite, bypass review, commit, activate, merge or refresh automatically.

Stop on missing dependencies, collisions, stale plans, invalid bundles or authority refusal.
Always relay paired Shell and Copilot routes; a deterministic command remains CLI-owned.
