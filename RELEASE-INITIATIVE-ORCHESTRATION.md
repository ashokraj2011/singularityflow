# Initiative orchestration delivery

This delivery adds an opt-in portfolio layer above Singularity Flow’s existing story workflows.

## Shipped

- Editable `singularity/portfolio.yml` schema and starter configuration.
- `initiative-lite` and `enterprise-delivery` profiles.
- Initiative outputs, inputs, checklists, gates, assurance tiers, freshness, and exact-hash approvals.
- Append-only content-addressed evidence, approval, and invalidation records.
- Dependency-cone invalidation and versioned interface contracts.
- Story DAG validation, dry-run materialization, safe branch seeding, retry journals, and Jira/Git modes.
- Cross-repository milestone synchronization.
- Reports for duration, evidence, self-approval, models, tokens, and cost.
- GitHub Copilot `/sflow-initiative-*` skills with selection receipts.
- Governed Copilot phase prompts combining persona, repository world model, remote agent Markdown, and approved initiative inputs with committed hash records.
- Flow Studio initiative dashboard and portfolio designer.

## Compatibility

- Existing story workflows and `singularity/work-items` are unchanged.
- Repositories without `singularity/portfolio.yml` perform no initiative work or extra network access.
- Personas remain prompt behavior. Initiative approval authority is a separate local Git email registry.
- Package, desktop, marketplace, and plugin versions remain `0.8.0`.

## Security and assurance

Initiative authorization is labeled `configured-local`. It is not cryptographic identity because local Git name/email can be changed. Every decision records actor, persona, channel, exact subject hash, and self-approval status.

External evidence is an observed snapshot, not a competing source of truth. Git branch state remains canonical.

## Known boundaries

- No separate web service or automatic application update is introduced.
- Approvals and lifecycle transitions are never automatically replayed after concurrent changes.
- Jira Align and other enterprise systems require an adapter or are stored as linked/uploaded evidence.
- Model, token, and cost history cannot be reconstructed for Copilot sessions that did not expose telemetry.
