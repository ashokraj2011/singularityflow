---
name: sflow-initiative-evidence
description: List or register content-addressed initiative checklist evidence with explicit assurance and provenance in GitHub Copilot.
disable-model-invocation: true
argument-hint: "list [CHECK-ID] | add <CHECK-ID> --assurance <LEVEL> [--path FILE | --url URL]"

---
# Manage initiative evidence

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

For listing, run `singularity-flow initiative evidence list [CHECK-ID] --json` and show hash, phase, check, assurance, observation time, freshness, source, and registrar identity.

For registration:

1. Show the active checklist contract with `/sf-initiative-checklist`.
2. Require the contributor to explicitly choose `machine-verified`, `system-verified`, `human-approved`, or `presence-only` and identify the source.
3. Preview the phase, checklist item, source, assurance, verification method, applicability decision, reason, and superseded hashes.
4. Run `singularity-flow initiative evidence add <CHECK-ID> --assurance <LEVEL>` with the supplied `--path`, `--url`, `--external-id`, `--observed-state`, `--source-version`, `--verification`, `--decision`, `--reason`, and repeatable `--supersedes` values.
5. Report the content hash, committed evidence copy, commit, and push.

Never infer higher assurance from a URL or file. Every registration is an append-only lifecycle event and must be committed and pushed.
