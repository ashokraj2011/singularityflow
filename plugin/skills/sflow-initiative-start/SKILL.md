---
name: sflow-initiative-start
description: Start a multi-repository Singularity Flow initiative in GitHub Copilot by explicitly selecting an initiative profile and session persona.
argument-hint: "<INIT-ID> [--jira] [--title TEXT] [--description TEXT]"
disable-model-invocation: true
---
# Start an initiative

Keep every choice and confirmation inside GitHub Copilot.

1. Require an initiative or Jira ID. Check that `singularity/portfolio.yml` exists and run `singularity-flow initiative profiles --json`.
2. Run `singularity-flow initiative choices begin start <INIT-ID> --json`.
3. Present every returned `choiceSets` group with Copilot's `ask_user`. Never infer, preselect, or silently default the initiative profile or persona.
4. Record each exact answer with `singularity-flow initiative choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
5. After the receipt reports `ready: true`, run `singularity-flow initiative start <INIT-ID> --selection-receipt <TOKEN>` with the user's Jira, title, and description arguments.
6. The CLI creates the exact initiative branch, snapshots the portfolio/profile, commits, and pushes. Do not create or switch branches manually.
7. Show the complete phase flow, profile, current phase, commit, publication result, and next action. Recommend `/sflow-initiative-documents` after phase preparation.

If `ask_user` is unavailable or disabled, stop without mutation. Never substitute public `--profile` or `--persona` flags; they intentionally do not exist.
