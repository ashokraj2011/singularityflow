---
name: sflow-capability-map
description: Propose, review, and activate one capability or an atomic team mapping.
disable-model-invocation: true
agent: agent

---

# Map a capability or onboard a team

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story or repository required; use only the selected lead URL. Resolve local checks with `singularity-flow workspace current --json`; never search `$HOME`. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

## One capability

1. Ask for the credential-free Git URL; preview `singularity-flow capability onboard <GIT-URL> --dry-run --json`. Relay effects and preservation. Run the returned `--confirm-plan` command once only after confirmation.
2. On `configuration-review-required`, inspect `singularity-flow capability setup-proposal <SETUP-BRANCH> --lead <GIT-URL> --json`; activate only after approval. Ask separately before `--acknowledge-unprotected`. Stop on other refusals.
3. Diagnose with `singularity-flow capability inspect-repository <GIT-URL> --json`. An unreachable repository is not new.
4. On explicit mapping request, ask for ID, name, kind, parent, and scope. Confirm:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> --json`

   For `delivery`, add `--repository <GIT-URL>`; `collection` omits it.

5. Show `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`. After approval run `singularity-flow capability activate <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`; ask separately before `--acknowledge-unprotected`. `singularity-flow capability publish` repairs projection only.
6. On a value conflict, run the returned `singularity-flow capability discard-proposal` once confirmed, then the returned `singularity-flow capability edit` or `map` again. Preview a returned `singularity-flow capability rebase-proposal`. Consent separately to each confirmation; never auto-activate.

## Cancel or replace a pending mapping

1. List `singularity-flow capability proposals --lead <LEAD-URL> --json`; identify the exact branch and full commit. Never guess from an ID, URL, or prefix. Setup and team proposals are separate.
2. For explicit cancellation, explain remote review-branch deletion and approved-map preservation. Run `singularity-flow capability cancel-proposal <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-COMMIT> --reason <REASON> --json` once. Stop on moved, merged, missing, or unverifiable refs; never force-delete or clear uncertain receipts.
3. For an exact same-capability replacement, add `--supersede-branch <REVIEW-BRANCH> --supersede-commit <FULL-COMMIT>` to the full `singularity-flow capability map` command. Deletion and creation must be atomic. If the old outcome is uncertain, inspect first; never cancel unrelated refs.

## Team onboarding

1. Select at most 20 repositories. Inspect selected repos individually; label **Will add**, **Will link**, **Needs a choice**, or **Left out**. Set problems aside.
2. Show the proposed tree and command before mutation:

   `singularity-flow capability map-team <TEAM-ID> --lead <LEAD-URL> --name <TEAM-NAME> --member <CHILD-ID>=<GIT-URL> --json`

   Run once after confirmation for one atomic proposal.
3. Stop for explicit approval. Offer `/sf-workspace`; do not invoke it.
