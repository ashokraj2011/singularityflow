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

1. Ask the exact credential-free Git URL; preview `singularity-flow capability onboard <GIT-URL> --dry-run --json`.
2. Relay `repository-onboarding-plan/v1` effects, preserved data, `planId`, status, and Shell/Copilot actions. Hide pins, SHAs, leases. Preview `--migrate`, `--recreate`, or `--reset-local` only after explicit choice.
3. Confirm the exact effects and preserved data; run the exact Shell command returned by the plan once: `singularity-flow capability onboard <GIT-URL> --confirm-plan <PLAN-ID> --json`.
4. On `configuration-review-required`, stop: repository setup uses `sflow/config-change/onboarding/`. Show reason, branch, full commit. Inspect `singularity-flow capability setup-proposal <SETUP-BRANCH> --lead <GIT-URL> --json`. After explicit approval run `singularity-flow capability setup-activate <SETUP-BRANCH> --lead <GIT-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`. On `REPOSITORY_ONBOARDING_CONFIGURATION_UNPROTECTED`, ask separately before `--acknowledge-unprotected`, or use external review. Stop on other refusals; recheck. `singularity-flow capability proposals` excludes setup branches.
5. Run `singularity-flow capability inspect-repository <GIT-URL> --json` only for compatibility diagnostics. Never duplicate `already-mapped` or treat `unreachable` as new.
6. Continue only after an explicit request for a new mapping; then ask only for missing ID, name, kind, parent, scope. Confirm:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> --json`

   For `delivery`, add `--repository <GIT-URL>`; `collection` omits it.

7. Show `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`. After explicit approval run `singularity-flow capability activate <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`. On `CAPABILITY_CONFIGURATION_UNPROTECTED`, ask before `--acknowledge-unprotected`, or use external review. `singularity-flow capability publish` repairs projection only.

## Team onboarding

1. Select at most 20 repositories; inspect selected repos one at a time, never a whole result page. Label **Will add**, **Will link**, **Needs a choice**, or **Left out**. Set problem repos aside without blocking others.
2. Show the exact proposed tree and command before mutation:

   `singularity-flow capability map-team <TEAM-ID> --lead <LEAD-URL> --name <TEAM-NAME> --member <CHILD-ID>=<GIT-URL> --json`

   Run once after confirmation for one atomic proposal.
3. Stop for explicit approval; use step 7. Offer `/sf-workspace`; do not invoke it.
