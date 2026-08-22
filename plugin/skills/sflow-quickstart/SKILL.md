---
name: sflow-quickstart
description: See a complete governed change in a throwaway repository.
---
# See a governed change, end to end

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

Use this when someone is new, asks how Singularity Flow works, or wants to try it
without committing a real repository to it. It runs in a sandbox the command
creates and removes: their own repository is never touched, there is no network
access, and no model is invoked.

1. Run `singularity-flow quickstart`. Add `--keep` only if the user asks to inspect
   the resulting repository afterwards.
2. Report each completed step in order. Each line is one real governed transition,
   not a simulation — that is the point of showing them.
3. State the two facts the summary reports and people most often doubt: zero model
   invocations and no network access.
4. Then offer the next step for their own work: `singularity-flow init` for a
   repository they already have, or `singularity-flow bootstrap <REPOSITORY-URL>`
   to set up a new capability with its configuration branch and ledger.
5. Keep this read-only with respect to the user's repository. The sandbox is
   created and removed inside the command.
