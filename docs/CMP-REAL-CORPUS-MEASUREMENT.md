# CMP real-repository corpus measurement

Use this runner to collect privacy-safe local performance and completeness observations from one
or more real Git repositories. It is evidence preparation for CMP P1, not a lifecycle gate,
approval, rollout decision, or claim that the repositories are independently reviewed.

## Run it

Run from a Singularity Flow source or npm-package installation:

```bash
npm run benchmark:cmp:corpus -- \
  --repository "/absolute/path/to/repository-one" \
  --repository "/absolute/path/to/repository-two" \
  --base HEAD~1 \
  --samples 3
```

The bounds are fixed:

- 1–16 explicit `--repository` values;
- each value must resolve to the exact root of a local Git worktree;
- one bounded commit revision in `--base`; ranges and option-like values are refused;
- 1–20 samples per repository.

`--base HEAD` measures uncommitted/index/untracked changes. `--base HEAD~1` also includes the latest
commit. Select and review that interval before running the command; the report deliberately does
not retain its repository or commit identity.

## What it reads and emits

The runner uses the production repository-change-set, region-manifest, coverage, and experimental
record-preview implementations. It may read current changed-file bytes to calculate the exact
in-memory identities those implementations require. It emits none of those bytes or identities.

The single JSON object on standard output contains only:

- platform, architecture, and Node major version;
- repository and sample counts;
- aggregate latency and CPU distributions;
- aggregate region, materiality, unresolved-reason, and diagnostic counts;
- aggregate manifest, coverage, and record-preview byte distributions;
- explicit non-authoritative and no-lifecycle labels.

It excludes repository paths, file paths, content digests, source, cause statements, Work IDs, Git
identities, prompts, and transcripts. It invokes no model, AST, network operation, cache writer, or
lifecycle command. Git prompts and optional index refresh are disabled. Before producing output it
rechecks every selected repository's `HEAD` and complete porcelain state; concurrent drift refuses
the measurement instead of producing a mixed report.

## Review and evidence boundary

The runner writes no report file. If the output is retained, place it only in an approved evidence
location and bind it to the separately reviewed corpus inventory and release subject. Do not add
repository identity to the content-free report itself.

A green run proves only that the selected local repositories were measured without an observed
state change. CMP P1 still requires:

- an independently reviewed real-repository corpus and disposition of false findings;
- supported-platform measurements with named machine classes;
- approved storage, retention, privacy, and rollout decisions;
- an independently authorized decision before any new Story may default to `record` mode.

The synthetic, release-gated benchmark remains:

```bash
npm run benchmark:cmp
```

See the [CMP roadmap](CMP-ROADMAP.md) for the complete acceptance contract.
