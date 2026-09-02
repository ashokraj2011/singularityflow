---
name: sflow-initiative-start
description: Start a multi-repository Singularity Flow initiative by selecting its immutable profile and automatically activating the first phase agent.
disable-model-invocation: true
argument-hint: "<INIT-ID> [--jira] [--title TEXT] [--description TEXT]"

---
# Start an initiative

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Keep every choice and confirmation inside GitHub Copilot.

1. Require an initiative or Jira ID. Check that `singularity/portfolio.yml` exists and run `singularity-flow initiative profiles --json`.
2. Run `singularity-flow initiative choices begin start <INIT-ID> --json`.
3. Present the returned initiative-profile choice with Copilot's `ask_user`. Never infer or silently default the profile. The selected profile's first phase activates its governed agent automatically.
4. Record each exact answer with `singularity-flow initiative choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
5. After the receipt reports `ready: true`, run `singularity-flow initiative start <INIT-ID> --selection-receipt <TOKEN>` with the user's Jira, title, and description arguments.
6. The CLI creates the exact initiative branch, snapshots the portfolio/profile, commits, and pushes. Do not create or switch branches manually.
7. Show the complete phase flow, profile, current phase, commit, publication result, and next action. Recommend `/sf-initiative-documents` after phase preparation.

If `ask_user` is unavailable or disabled, stop without mutation. Never substitute public `--profile` or `--agent` flags; they intentionally do not exist.
