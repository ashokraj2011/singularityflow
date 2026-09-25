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

1. Ask for the exact credential-free Git URL; preview `singularity-flow capability onboard <GIT-URL> --dry-run --json`.
2. Relay the plan's effects, preserved data, ID, status, and Shell/Copilot actions. Only preview migration, recreation, or local reset after explicit choice. Confirm effects, then run the returned command once with `--confirm-plan <PLAN-ID>`.
3. On `configuration-review-required`, stop and show reason, branch, full commit. Inspect `singularity-flow capability setup-proposal <SETUP-BRANCH> --lead <GIT-URL> --json`; after explicit approval use `setup-activate` with the exact full commit. Ask separately before `--acknowledge-unprotected`. Stop on other refusals. Setup branches are absent from ordinary `proposals`.
4. Use `singularity-flow capability inspect-repository <GIT-URL> --json` only for diagnostics. Never duplicate an already-mapped repository or treat an unreachable one as new.
5. Map only on explicit request; ask for missing ID, name, kind, parent, scope. Confirm:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> --json`

   For `delivery`, add `--repository <GIT-URL>`; `collection` omits it.

6. Show `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`. After explicit approval, activate with `--confirm <FULL-PROPOSAL-COMMIT>`. Ask separately before `--acknowledge-unprotected`; `singularity-flow capability publish` repairs projection only.
7. On merge conflict, preview `singularity-flow capability rebase-proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`. Show source and target commits, additive delta, new branch, and preserved data. Only supported single-map additions qualify. After separate consent, run the returned exact `--confirm <SOURCE-COMMIT> --confirm-plan <PLAN-ID>` command. Review the new proposal and ask separately before activation; never delete the source or auto-activate.

## Team onboarding

1. Select at most 20 repositories. Inspect only selected repos, one at a time. Label **Will add**, **Will link**, **Needs a choice**, or **Left out**; set problem repos aside.
2. Show the proposed tree and command before mutation:

   `singularity-flow capability map-team <TEAM-ID> --lead <LEAD-URL> --name <TEAM-NAME> --member <CHILD-ID>=<GIT-URL> --json`

   Run once after confirmation for one atomic proposal.
3. Stop for explicit approval; use step 6. Offer `/sf-workspace`; do not invoke it.
