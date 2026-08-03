# Agent-only development reset

Singularity Flow 0.9.0 uses one role model: governed Agent Markdown. This is a
development release and intentionally does not migrate repositories or work
items that still contain role, lens, or legacy prompt-role state.

Current repositories use:

```text
singularity/workflow.yml          # phase and lifecycle contract
.github/agents/*.agent.md         # execution roles and automatic phase agents
singularity/portfolio.yml         # optional Epic/initiative contract
singularity/work-items/           # committed Story state
singularity/initiatives/          # committed Epic state
```

If validation reports an unsupported legacy configuration, create a clean
development branch and initialize the current model:

```bash
git fetch origin
git switch -c WORK-123 origin/main
singularity-flow init
singularity-flow validate --strict
```

Review `.github/agents/` and ensure every configured phase has exactly one
`sflow-default-for` owner. Then commit and push the branch normally. Do not copy
old runtime JSON into the new branch; create a new Story or Epic so its immutable
resolution is built from the current schema.

Reinstall the CLI and Copilot plugin after upgrading the source checkout:

```bash
./install.sh
```

The installer replaces previous plugin copies. Restart Copilot so `/sf-*` and
`/sflow-*` discovery reloads the new Agent Markdown contracts.
