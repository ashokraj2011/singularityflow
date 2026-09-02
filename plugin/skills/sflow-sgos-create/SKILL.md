---
name: sflow-sgos-create
description: Guide and create a bounded core SGOS Workflow Candidate from confirmed Intent.
disable-model-invocation: true
argument-hint: "<INTENT-IR> --policy FILE --registry FILE --storage-profile-sha256 SHA256"
---
# Create an SGOS Workflow Candidate

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → verified `repositoryPath`, cwd=`repositoryPath`; never `$HOME`; no active Story is required.

1. Run `singularity-flow workspace current --json`; use `repositoryPath` as cwd. Inputs and distinct outputs must be repository-relative.
2. Run `singularity-flow intent workflow-guide <INTENT-IR> --registry <FILE> --json`. Show clauses, eligible operations, their `verificationOperationIds`, and eligible verifiers. Stop on refusal or no compatible pair.
3. Use `ask_user` for the lower-kebab ID, one returned operation and compatible verifier, policy, storage SHA-256, output paths, and optional title, attempts, and output reference. Outputs must be under `singularity/sgos-drafts/<id>/`. Never infer or preselect.
4. Show the exact command and two uncommitted files; ask for confirmation. Invocation of this skill is not that confirmation.
5. Run exactly once:

   `singularity-flow intent workflow-create <INTENT-IR> --policy <FILE> --registry <FILE> --storage-profile-sha256 <SHA256> --id <LOWER-KEBAB> --operation <EXACT-ID> --verification-operation <EXACT-ID> --declaration-out <NEW-FILE> --out <NEW-FILE> [--title <TEXT>] [--maximum-attempts <N>] [--output-ref <REF>] --json`

6. On refusal, relay it and stop; never hand-edit outputs. Otherwise show paths, hashes, clause map, graph, budgets, and the returned ratification-packet command. Label both files **unratified proposals** and leave them uncommitted.
7. Stop. Never run `intent ratify`, `intent compile`, `program approve`, `process start`, `process step`, `process run`, a returned next command, or any `--confirm` action. Never claim that Copilot, this skill, or Workflow creation granted authority.
