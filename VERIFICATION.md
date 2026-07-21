# Singularity Flow Lite 0.6 verification

Use this checklist before packaging or rolling the workflow into a repository.

## Automated release checks

```bash
npm install
npm test
npm run check
npm pack --dry-run
git diff --check
```

Expected CLI versions:

```text
singularity-flow --version  → 0.6.0
sflow --version             → 0.6.0
```

The package dry run must include `bin/`, `src/`, `plugin/`, `templates/`, `schemas/`, `examples/`, and the project documentation. It must not include test fixtures, `.git`, or local `.singularity` work items.

## Configuration checks

- `singularity-flow init` creates `.singularity/workflow.yml`, all referenced templates, all persona prompts, and the world-model builder prompt without overwriting edited files.
- Invalid YAML, unknown phase references, invalid persona capabilities, and missing templates fail clearly.
- Work-type template overrides take precedence over phase defaults.
- `start` snapshots the work type, resolved phases, configuration hash, and template hashes.
- Changing a work item's type after creation is rejected by validation.
- `migrate-config` preserves legacy JSON and Git history.

## Interactive selection checks

- `start` always asks for work type and persona.
- `resume` always asks for persona.
- No public `--type` or `--persona` option bypasses the picker.
- Non-interactive start/resume fails instead of choosing a default.
- Any configured persona may be selected in any phase.
- Persona selection alone changes only `.git/singularity-flow/session.json` and creates no commit.

## Artifact and lifecycle checks

Run a feature and bugfix through every configured phase. For each generation verify:

- Artifact location is `.singularity/work-items/<ID>/artifacts/<phase>/`.
- Managed metadata includes the correct actor, persona, generation, hashes, usage, and approvals.
- Commit subject includes `[ID][phase:<id>][generated:<n>]`.
- The work branch is pushed before the command reports success.
- Submission, approval, rejection, and advancement each have their own pushed commit.
- A second clone can fetch, fast-forward, resume, and reconstruct state solely from the branch.

For an unreachable remote, verify the local commit is retained, transitions are blocked, and `singularity-flow sync` publishes the same history after connectivity returns.

## Approval checks

- Only a persona whose `mayApprove` includes the phase can approve or reject it.
- Approval records include authenticated identity, selected persona, timestamp, channel, and decision.
- Multi-approval thresholds ignore repeat decisions by the same identity.
- Self-approval is allowed but appears in the artifact, approval record, status, and conformance report.
- Rejection can target only an allowed earlier phase and invalidates target/downstream approvals.
- Concurrent terminal decisions cannot force-push over each other.

## Traceability checks

- Requirements use stable `AC-n` identifiers.
- Feature implementation specs and bugfix fix specs use stable `SPEC-nnn` identifiers mapped to acceptance criteria.
- Verification contains test/source evidence.
- Conformance reports every AC and SPEC item with `matched`, `partial`, `missing`, `deviated`, or `unplanned` and exact file/line evidence.
- The conformance report discloses approved deviations and self-approvals.
- A tracked source/test change after conformance makes the report stale and fails the gate.

## Token checks

- Exact provider usage preserves provider, model, input/output/cached/total counts, timestamps, and collection source.
- Missing provider values are recorded as `unavailable`, never guessed.
- Aggregates are correct by phase, persona, work type, and work item.

## World-model checks

- Phase-required views are always present.
- Persona views are added and do not replace required views.
- The persona prompt is present in phase context.
- Verification and conformance include the evidence ledger.
- `singularity-flow wm check` detects a stale manifest.

## Final GitHub checks

Install the example approval and validation workflows, pin the released package version, and configure branch protection to require the validation job. Exercise both comment forms:

```text
/approve design as architect
/reject design as architect --to requirements --reason "Missing failure behavior"
```

Confirm the workflow actor and declared persona appear in committed decision records and that the final terminal gate verifies the remote head.
