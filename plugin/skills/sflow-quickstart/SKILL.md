---
name: sflow-quickstart
description: See a complete governed change in a throwaway repository.
disable-model-invocation: true

---
# See a governed change, end to end

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

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
