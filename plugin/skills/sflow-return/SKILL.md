---
name: sflow-return
description: Safely reconstruct a published Story on this machine from durable remote evidence.
argument-hint: "<WORK-ID>"
disable-model-invocation: true

---
# Return to published governed work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Preview remote evidence before mutation, preserve dirty work, and require the user to provide the exact Work ID confirmation.

Run `singularity-flow return <WORK-ID> --json` first. Show the configured remote, source ref and commit, destination branch, locator integrity hash, freshness, and whether the worktree is clean. If it is dirty, stop; never stash, reset, clean, commit, or discard changes. Ask the user to explicitly confirm the exact Work ID. Only after they provide it, run `singularity-flow return <WORK-ID> --apply --confirm <WORK-ID>`. Report the reconstructed phase and governed agent, then refresh with `/sf-home`. Never generate the confirmation yourself and never substitute `resume` when the Story must be discovered from another machine.
