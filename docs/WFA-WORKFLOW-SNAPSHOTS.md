# Workflow Adapters and Story Snapshots (WFA)

Status: snapshot portability foundation implemented; external workflow adapters remain proposal-only.

## Why this exists

A Story must continue to mean the same thing after configuration changes and when its accepted Git
history is checked out on another laptop. New Stories therefore accept an immutable workflow
snapshot at creation time. The snapshot is committed with the Story and contains the exact
effective-policy projection plus the phase-template and selected governed-agent bytes needed to
verify its definition. Automated cross-machine handoff is a later increment; this foundation does
not claim that a snapshot alone recreates external runtimes, credentials, or provider observations.

The accepted snapshot is not a second live configuration source. It is a content-addressed closure
under the Story directory:

```text
singularity/work-items/<WORK-ID>/
  workflow.json
  config/wfa/
    snapshots/000001/manifest.json
    blobs/sha256/<digest>
```

`workflow.json` carries only the accepted manifest reference, revision, snapshot hash, and genesis
hash. Phase template references point at immutable blobs. Refreshing `sflow/config`, replacing a
template, or installing a newer extension cannot change an in-flight Story's phase contract.

## Inspect and verify

```bash
singularity-flow story workflow show --work-id PAY-1
singularity-flow story workflow verify --work-id PAY-1 --json
singularity-flow story workflow drift --work-id PAY-1
```

`show` and `verify` perform no network access and no lifecycle mutation. Verification checks the
manifest identity, content hashes, effective-policy fold, resource limits, and every captured blob.
`drift` compares the accepted provenance with the locally approved configuration observation. It
does not refresh remotes implicitly; refresh configuration explicitly if a fresh comparison is
required.

Stories created before WFA remain readable and are reported as `legacy / closure unproven`. A
migration never invents historical dependency bytes or claims that an old Story was portable.

Remote agent dependencies are declarations, not snapshot inputs. Their raw URLs are not copied into
the manifest; only a domain-separated reference digest and availability requirement are retained.
Snapshot verification never fetches them.

## Enforcement

New Story creation is atomic with snapshot capture. Missing, changing, symlinked, oversized, or
digest-mismatched inputs refuse creation before accepted Story state is published. Publication
validation re-verifies the accepted closure and rejects tampered blobs or a changed snapshot
reference. The snapshot is bounded to 2,048 assets, 1 MiB per captured asset, and 16 MiB total.

## Remaining WFA roadmap

The WFA v1 specification contains six delivery increments. This implementation completes the safe
reader/capture foundation and the first read-only inspection surface. The following work remains
deliberately separate because it introduces new authority and dialect semantics:

1. Immutable amendment snapshots with parent linkage, approval binding, and append-only revision
   selection. Until then, the genesis reference cannot be replaced.
2. Story handoff/import commands that prove repository identity and accepted snapshot closure before
   attaching a session on another laptop.
3. A GitHub Actions importer that produces an unratified proposal only. It needs a bounded YAML
   parser, explicit unsupported-feature diagnostics, expression/input preservation, and fixture
   conformance before it may be enabled.
4. A GitHub checks exporter with round-trip equivalence proof. It must never export lifecycle
   approval or publication authority as if repository checks granted it.
5. Additional dialect adapters only after the canonical IR and equivalence suite are stable.

No external adapter is silently enabled by this foundation. Imported workflows must remain
proposals until the existing governed review and ratification path accepts them.
