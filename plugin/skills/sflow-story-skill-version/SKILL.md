---
name: sflow-story-skill-version
description: Review and adopt an approved new skill package version for an active Story without silently changing its pinned execution snapshot.
disable-model-invocation: true
argument-hint: "status | preview <SKILL-ID> --reason <TEXT> | propose <SKILL-ID> --reason <TEXT> | decide <AMENDMENT-ID> --decision <approve|reject> --reason <TEXT>"
---

# Review a Story skill-version amendment

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Read `singularity-flow story skill-version status --json` from the verified Story repository. It reports the pinned version and any pending proposal; it does not read a floating live skill folder as authority.
2. When the person names an approved skill ID and reason, run `singularity-flow story skill-version preview <SKILL-ID> --reason <TEXT> --json`. Show the old and proposed package identities, approved configuration revision, exact plan digest, and each affected, preserved, or unproven dependency. Stop if the CLI reports an unknown dependency, changed policy outside the selected package, unavailable approved bytes, or unsupported snapshot shape.
3. A proposal is a separate governed mutation. Require the person's explicit confirmation of the **full digest returned by the current preview**, then use the CLI's returned `propose` argv with that confirmation. A Copilot-generated assent or a typed digest by itself is not human authorization. Never alter `workflow.json`, a WFA manifest, or evidence files directly.
4. The proposal does not adopt the skill. For `decide`, present the exact proposal and policy to an eligible human reviewer and collect a reason. Run the CLI's read-only decision preview first; only after explicit confirmation use its returned `decide` argv. Distinct identities and any required groups are checked by the existing approval authority. Do not fabricate or copy approvals.
5. Report the committed decision. If the threshold is met and approved, the CLI must create a new immutable snapshot revision and reopen only dependencies it can prove affected; all unproven cases stay blocked. If rejected or pending, the original pinned Story version remains authoritative. Existing publication, checks, and human approval gates still apply to reopened phases.
6. Do not run a selected skill phase from this skill. Host execution remains gated separately; use the returned next action after the adoption transaction is verified.
