---
name: sflow-capability-map
description: Propose, review, and activate one capability or an atomic team mapping.
disable-model-invocation: true

---

# Map a capability or onboard a team

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story or repository required; use only the selected lead URL. Resolve local checks with `singularity-flow workspace current --json`; never search `$HOME`.

## One capability

1. Ask for the credential-free Git URL; preview `singularity-flow capability onboard <GIT-URL> --dry-run --json`. Relay effects and preservation. Run the returned `--confirm-plan` command once only after confirmation.
2. On `configuration-review-required`, inspect `singularity-flow capability setup-proposal <SETUP-BRANCH> --lead <GIT-URL> --json`; activate only after approval. Ask separately before `--acknowledge-unprotected`. Stop on other refusals.
3. Diagnose with `singularity-flow capability inspect-repository <GIT-URL> --json`. An unreachable repository is not new.
4. On explicit mapping request, ask for ID, name, kind, parent, and scope. Confirm:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> --json`

   For `delivery`, add `--repository <GIT-URL>`; `collection` omits it.

5. Show `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`. After approval run `singularity-flow capability activate <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`; ask separately before `--acknowledge-unprotected`. `singularity-flow capability publish` repairs projection only.
6. On conflict, preview `singularity-flow capability rebase-proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`. Consent separately to its exact confirmation command. Review before activation; never auto-activate.

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
