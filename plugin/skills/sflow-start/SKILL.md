---
name: sflow-start
description: Explicitly choose a remote base, intake source, and workflow; create and publish the canonical Story branch.
disable-model-invocation: true
agent: agent
argument-hint: "<NEW-ID> [--clone-from <ORIGINAL-ID> | --jira | manual details]"

---
# Start work

<!-- sflow-copilot-pause -->
First require an explicit Work ID, then run `singularity-flow workspace branches --entry --intake --work-id <WORK-ID> --for-agent --json` once. It checks pause before Git and combines workspace/build/clean-tree/catalog facts. If `paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. Reuse the packet; no separate pause/workspace/version/status/catalog calls. Ask explicit choices; creation still revalidates live authority. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Explicit choices; no preselection; preserve errors/artifacts/actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; reuse entry `repositoryPath` after its workspace/clean-tree checks. Refuse absent/unready selections; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. `workspace-repair-required`: `/sf-workspace` repairs its selected repository before re-entry. `worktree-review-required`: preserve/list `changes`; no Story. The person commits, ignores, moves or lands them (`/sf-adhoc`), then reruns `/sf-start`.
2. Unless `existingWork.status` is `new`, route existing IDs to `/sf-session` or `singularity-flow resume <WORK-ID>`, never restart. Unreachable/unknown repositories are not new IDs.
3. Use catalog/preflight member checks; no workspace-wide rescan. Repair exact missing members. Authority failure: Shell `singularity-flow workspace reinitialize --dry-run --json`, Copilot `/sf-admin`; never `init` for an absent local workflow file.
4. Choose `<BASE>` explicitly. If `intake.workflowCatalogScope` is not `approved-configuration`, run step 6 without `--work-type`. Choose `<WORKFLOW>` from exact-base `intake.storyWorkflows`.
5. Collect outcome, criteria, scope, risks and named documents; never search. Clone: `singularity-flow story clone <ORIGINAL-ID> --preview --json`; review new name/ID, workflow/bases and reattach documents. Add `--clone-from <ORIGINAL-ID> --clone-source-commit <source.commit>`. Pinned inputs survive phase advances; copy no evidence, risk acceptances, decisions or approvals. Otherwise `--jira`/`--story-file`. References: paired `--reference-repository ID=URL --reference-branch ID=BRANCH`.
6. Choose baseline (`reuse`, optional reviewed `run`, `defer`), tests (`changed-and-affected`, `all-configured`) and gates (`hard`, `soft`) separately. Soft needs exact human coverage-risk review, reason/expiry; tests/integrity stay hard. Run `singularity-flow workspace branches --json --intake --preflight-story <WORK-ID> --from-branch <BASE> --work-type <WORKFLOW> --selected-base-only --mint-intake-receipt --readiness-baseline <CHOICE> --test-execution-mode <MODE> --gate-mode <GATES>`. Missing tests/setup never block creation or imply a pass. No implicit installs/tests; baselines use `/sf-ready`. World Model/AST/models/telemetry: advisory. Never upgrade configuration here. `preflight.storyBranch` is the branch start creates; a person's own name goes to both as `--ref <BRANCH>`.
7. Start with identical base/workflow/baseline/test/gate flags; add returned `--intake-receipt`. `targetUrl: required` needs `--target-url`; pass a `recommended` one when given. Without `ask_user`, use step 8 or stop; keep hard gates unless explicitly selected.
8. Pinned choices: `singularity-flow choices begin start <WORK-ID> --for-agent --json`, `singularity-flow choices answer <TOKEN>`, pass `--selection-receipt <TOKEN>` (15-minute, single-use).
9. Show readiness; `/sf-next`. Pending tests: Copilot `/sf-test-setup`; Shell `singularity-flow capability test-setup --json`. Tests run later; publish needs evidence.

TRP: `singularity-flow explain test-recovery`; acceptance needs native evidence/live human review. Never answer approval cards; use returned actions.
