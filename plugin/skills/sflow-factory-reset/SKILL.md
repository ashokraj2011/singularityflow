---
name: sflow-factory-reset
description: Preview and deliberately reset repository-owned Singularity Flow configuration and machine-local runtime state from the currently installed npm package defaults.
argument-hint: "[--dry-run]"
disable-model-invocation: true
---
# Factory-reset this repository

This operation permanently discards uncommitted files under `singularity/`, the
legacy `.singularity/` directory, and `.git/singularity-flow/`. Git history,
application source, workspace clones, the global workspace registry, and custom
repository agents whose filenames are not supplied by Singularity Flow remain.

1. Run `singularity-flow factory-reset --dry-run --json` first.
2. Show the complete `remove`, `replace`, `preserve`, and
   `uncommittedResetPaths` lists. Do not summarize away uncommitted paths.
3. Ask the contributor whether to proceed. The contributor must explicitly
   provide the exact `confirmation` string from the preview.
4. Only after that answer, run:

   ```bash
   singularity-flow factory-reset --confirm "<EXACT CONFIRMATION>" --json
   ```

5. Run `singularity-flow init --check --json` and show `git status --short`.
   Explain that the reset is intentionally uncommitted and must be reviewed.

Never supply the confirmation yourself, infer consent from the original request,
commit, push, reset Git history, or delete a repository clone. The repository-only
flow must not delete the global workspace registry. If the preview reports
uncommitted reset-scope changes, call them out prominently because factory reset
will discard them.

If the contributor explicitly asks to reset **all local Singularity Flow state**,
run `sf-reset-all` without `--yes` and show its full preview. Explain that it also
clears `~/.singularity-flow/` and forgets all saved workspaces, while preserving
their physical clones, application source, Git history, and VS Code keychain
credentials. After a separate explicit confirmation, run `sf-reset-all --yes`.
