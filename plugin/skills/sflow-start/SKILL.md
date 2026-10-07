---
name: sflow-start
description: Explicitly choose a remote base, intake source, and workflow; create and publish the canonical Story branch.
disable-model-invocation: true
argument-hint: "<WORK-ID> [--jira | manual story details] [documents and URLs]"

---
# Start work

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Explicit choices; no preselection; preserve errors/artifacts/actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require WORK-ID. Read `singularity-flow workspace current --json`. If the selected repository is `missing`/`empty`, run `singularity-flow workspace repair <WORKSPACE-PATH> --repository <REPOSITORY-ID> --level readiness --json`. Re-read; use ready `repositoryPath`, else opened Git root. Run `singularity-flow version` and `git status --short`; stop on failure or dirt.
2. Run `singularity-flow workspace branches --json --intake --work-id <WORK-ID>`. Unless `existingWork.status` is `new`, run `singularity-flow session candidates --json`; an existing ID routes to `/sf-session` or `singularity-flow resume <WORK-ID>`; never restart it.
3. Check `singularity-flow workspace status <WORKSPACE-PATH> --level readiness --json`; repair missing required members. Authority failure: Shell `singularity-flow workspace reinitialize --dry-run --json`, Copilot `/sf-admin`; never `init` for an absent local workflow file.
4. Never preselect. Choose `<BASE>`. Unless `intake.workflowCatalogScope` is `approved-configuration`, run step 6's command without `--work-type`. Choose `<WORKFLOW>` from its exact-base `intake.storyWorkflows`.
5. Ask for Jira/manual outcome, acceptance criteria, scope, risks, named documents. References need ID, credential-free URL and branch: `--reference-repository ID=URL --reference-branch ID=BRANCH`. Pass `--jira`/`--story-file`; pair document inputs with their name flags. Never search for inputs.
6. Ask separately for baseline (`reuse`, optional reviewed `run`, `defer`) and tests (`changed-and-affected`, `all-configured`). Run `singularity-flow workspace branches --json --intake --preflight-story <WORK-ID> --from-branch <BASE> --work-type <WORKFLOW> --selected-base-only --mint-intake-receipt --readiness-baseline <CHOICE> --test-execution-mode <MODE>`. Missing setup or failed tests never block creation or imply a pass/risk acceptance. No implicit installs/tests; explicit baseline requests use `/sf-ready` and its reviewed Shell action. World Model/AST/models/telemetry are advisory. Never upgrade configuration here.
7. Start with the same base/workflow and baseline/test-mode flags; add returned `--intake-receipt`. `poc-workflow` needs `--target-url`. Without `ask_user`, use step 8 or stop.
8. Without `ask_user`, require pinned configuration: `singularity-flow choices begin start <WORK-ID> --json`, `singularity-flow choices answer <TOKEN>`, then pass `--selection-receipt <TOKEN>` (15-minute, single-use).
9. Show readiness; `/sf-next`. Pending tests: Copilot `/sf-test-setup`; Shell `singularity-flow capability test-setup --json`. Run tests later; require evidence at publish.

TRP: read `singularity-flow explain test-recovery`. Failure acceptance needs native evidence and live human review; never answer approval cards. Returned actions only.
