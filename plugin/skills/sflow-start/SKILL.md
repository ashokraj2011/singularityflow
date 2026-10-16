---
name: sflow-start
description: Explicitly choose a remote base, intake source, and workflow; create and publish the canonical Story branch.
disable-model-invocation: true
argument-hint: "<WORK-ID> [--jira | manual story details] [documents and URLs]"

---
# Start work

<!-- sflow-copilot-pause -->
First require an explicit Work ID, then run `singularity-flow workspace branches --entry --intake --work-id <WORK-ID> --for-agent --json` once. It checks pause before Git and combines workspace/build/clean-tree/catalog facts. If `paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. Reuse the packet; no separate pause/workspace/version/status/catalog calls. Ask explicit choices; creation still revalidates live authority.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Explicit choices; no preselection; preserve errors/artifacts/actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; reuse entry `repositoryPath` after its workspace/clean-tree checks. Refuse absent/unready selections; never search `$HOME`/parents.

1. Use the entry above once. `workspace-repair-required`: follow `/sf-workspace` for its exact selected repository; re-enter only after repair. `worktree-review-required`: preserve and review its listed changes; do not create a Story. Use its `repositoryPath`; never search for a checkout.
2. Unless `existingWork.status` is `new`, route existing IDs to `/sf-session` or `singularity-flow resume <WORK-ID>`, never restart. An unreachable/unknown repository is not a new ID.
3. The catalog and selected-base preflight check required members together; do not repeat a workspace-wide status scan. Repair a returned missing-member failure explicitly. Authority failure: Shell `singularity-flow workspace reinitialize --dry-run --json`, Copilot `/sf-admin`; never `init` for an absent local workflow file.
4. Choose `<BASE>` explicitly. If `intake.workflowCatalogScope` is not `approved-configuration`, run step 6 without `--work-type`. Choose `<WORKFLOW>` from exact-base `intake.storyWorkflows`.
5. Collect Jira/manual outcome, criteria, scope, risks, documents. References need ID, credential-free URL and branch: `--reference-repository ID=URL --reference-branch ID=BRANCH`. Pass `--jira`/`--story-file`; pair document inputs with their name flags. Never search for inputs.
6. Choose baseline (`reuse`, optional reviewed `run`, `defer`), tests (`changed-and-affected`, `all-configured`) and gates (`hard`, `soft`) separately. Soft needs exact human coverage-risk review, reason/expiry; tests/integrity stay hard. Run `singularity-flow workspace branches --json --intake --preflight-story <WORK-ID> --from-branch <BASE> --work-type <WORKFLOW> --selected-base-only --mint-intake-receipt --readiness-baseline <CHOICE> --test-execution-mode <MODE> --gate-mode <GATES>`. Missing tests/setup never block creation or imply a pass. No implicit installs/tests; baselines use `/sf-ready`. World Model/AST/models/telemetry: advisory. Never upgrade configuration here.
7. Start with identical base/workflow/baseline/test/gate flags; add returned `--intake-receipt`. `poc-workflow` needs `--target-url`. Without `ask_user`, use step 8 or stop; keep hard gates unless explicitly selected otherwise.
8. Without `ask_user`, use pinned choices: `singularity-flow choices begin start <WORK-ID> --for-agent --json`, `singularity-flow choices answer <TOKEN>`, pass `--selection-receipt <TOKEN>` (15-minute, single-use).
9. Show readiness; `/sf-next`. Pending tests: Copilot `/sf-test-setup`; Shell `singularity-flow capability test-setup --json`. Run tests later; require evidence at publish.

TRP: `singularity-flow explain test-recovery`; acceptance needs native evidence/live human review. Never answer approval cards; use returned actions.
