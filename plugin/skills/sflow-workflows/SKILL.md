---
name: sflow-workflows
description: List, preview, transfer, duplicate governed workflows, or explicitly share inert Git-backed workflow drafts.
disable-model-invocation: true
argument-hint: "[list|author list|author where-used SKILL-ID|author preview WFD-ID|author submit WFD-ID --revision N|skills-recipe ID ...|simulate ID|export ...|import FILE|copy SOURCE TARGET ...]"

---
# Workflows and shared drafts

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Run `singularity-flow workflow $ARGUMENTS`; default `list`.

For `author`, use only the opened Git root.
`list|read|history|show|preview|catalog|where-used|op-status` is read-only; relay revision/coverage/gaps.
`author where-used <SKILL-ID> --json`: approved configuration; explicit `--story <ID>` selects
one accepted local Story. Preserve `--ref`, `--commit`, `--snapshot-revision`; no fetch or inventory.
Relay bindings/exclusions/paging; later pages need returned `--expected-source`. No repairs.
Create/Save require user direction, unique operation ID, observed head and matching
`--expected-authority`. Input is inert JSON. Never rebase, change replayed requests or recreate
deleted drafts. Lost acknowledgement: `author op-status <ID> --json`.
Headless `author submit <WFD-ID> --revision N` or `author delete` only hands off:
never supply receipts, answers or tokens. Direct terminal captures the named human action.
Submit creates only an exact review proposal; no approval, activation or execution.

Install: preview first; no unconfirmed `--replace` or auto-commit.

BYO preview: `singularity-flow workflow skills-recipe <NEW-ID> --label <TEXT>
--phases <APPROVED-PHASE-IDS> --json`. Code requires `--planned-claims required
--clause-phases <CRITERIA> --claim-owners <CODE=PLAN>`. Relay revision, sequence and readiness;
never infer opt-out, confirmation or execution. Proposals need separate authorization.

Export explicit selections to a new file:
`singularity-flow workflow export --workflow <ID> [--workflow <ID>...] --out <FILE> --json`.
Report complete dependency closure/locks. Policy/World Model contracts are prerequisites; never edit bundles.

Import preview: `singularity-flow workflow import <FILE> --dry-run --propose --json`.
Skill invocation is not confirmation. After digest/path/collision review and explicit acceptance run
`singularity-flow workflow import <FILE> --confirm <PLAN-SHA256> --propose --json` once.
Plans bind destination authority/revision. Never substitute digests, overwrite collisions or retry stale plans.

`duplicate` aliases `copy`. Require a distinct lower-kebab target and label. Preview:
`singularity-flow workflow copy <[story|initiative:]SOURCE> <TARGET> --label <TEXT> --dry-run --propose --json`.
Qualify ambiguous IDs. Linked copies reuse dependencies; later shared edits affect both.
No isolation claim. Review plan/collisions and wait:
`singularity-flow workflow copy <[story|initiative:]SOURCE> <TARGET> --label <TEXT> --confirm <PLAN-SHA256> --propose --json`.
Run once; never overwrite, bypass review, commit, activate, merge or refresh automatically.

Stop on dependency/collision/stale-plan/bundle/authority refusal; relay paired Shell/Copilot routes.
