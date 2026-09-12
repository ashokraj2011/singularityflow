# Workflow Adapters and Story Snapshots (WFA)

Status: portable Story execution closure implemented; external workflow adapters remain proposal-only.

## Why this exists

A Story must continue to mean the same thing after configuration changes and when its accepted Git
history is checked out on another laptop. New Stories therefore accept an immutable workflow
snapshot at creation time. The snapshot is committed with the Story and contains the exact
effective-policy projection, phase templates, every governed agent admitted by the pinned Story
selection, and the retained declarative dependency bytes needed to execute those agents. Prompt
assembly, agent selection, agent skills, and World-Model view selection use this verified closure;
they do not silently rediscover a changed live agent or fetch a missing skill.

The closure is portable only with the committed Story history. Push the Story branch through the
normal publication path, then use the existing session attach or `resume --fetch` flow on the other
laptop. A manifest that has not been pushed cannot make its local blobs available elsewhere.

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

New snapshots declare `sflow-agent-document-v1` and `story-snapshot-agent-v1`. A compatible runtime
verifies those profiles and the original blob bytes before composing a prompt or using a local
cache. Execution provenance records the snapshot, agent, included dependencies, interpretation
profiles, and any separately approved prompt-override digest. It never stores an absolute checkout
path as part of that identity.

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
migration never invents historical dependency bytes or claims that an old Story was portable. A
legacy Story with no snapshot may retain live-agent behavior, but its prompts are labelled
`legacy-live`. An older v1 snapshot may still use its saved agent bytes and the baseline
`sflow-agent-document-v1` interpretation. If it names a required dependency whose exact bytes were
not retained, execution stops with `WFA_DEPENDENCY_UNAVAILABLE`; a matching name, mutable URL, or
newly installed copy is not accepted as historical evidence.

Required declarative agent dependencies are resolved and retained during capture. Optional
dependencies record an explicit included or omitted decision, which remains unchanged on resume.
Generated or executable dependencies stay explicit external requirements: the snapshot records
their reviewed identity but does not grant execution permission or embed credentials. Snapshot
verification and prompt composition never fetch them.

Machine capabilities remain local. Git credentials, provider credentials, executable locations,
toolchains, and project bindings are resolved and authorized on the laptop that resumes the Story.
They are not portable policy and are never copied into snapshot blobs. The same saved instructions
therefore still require compatible local bindings; `WFA_RUNTIME_INCOMPATIBLE` identifies an
unsupported parser/composer profile rather than pretending the old laptop's runtime moved with the
Story.

## Enforcement

New Story creation is atomic with snapshot capture. Missing, changing, symlinked, oversized, or
digest-mismatched inputs refuse creation before accepted Story state is published. Publication
validation re-verifies the accepted closure and rejects tampered blobs or a changed snapshot
reference. The snapshot is bounded to 2,048 assets, 1 MiB per captured asset, and 16 MiB total.
Cycles, duplicate logical identities, unsafe paths, symlinks, and conflicting dependency bytes are
rejected before Story creation is accepted.

## Remaining WFA roadmap

The WFA v1 specification contains six delivery increments. This implementation completes the safe
reader/capture foundation and the first read-only inspection surface. The following work remains
deliberately separate because it introduces new authority and dialect semantics:

1. Immutable amendment snapshots with parent linkage, approval binding, and append-only revision
   selection. Until then, the genesis reference cannot be replaced.
2. A dedicated Story handoff/import UX beyond the existing Git Story-branch synchronization and
   conservative session-attach flow.
3. A GitHub Actions importer that produces an unratified proposal only. It needs a bounded YAML
   parser, explicit unsupported-feature diagnostics, expression/input preservation, and fixture
   conformance before it may be enabled.
4. A GitHub checks exporter with round-trip equivalence proof. It must never export lifecycle
   approval or publication authority as if repository checks granted it.
5. Additional dialect adapters only after the canonical IR and equivalence suite are stable.

No external adapter is silently enabled by this foundation. Imported workflows must remain
proposals until the existing governed review and ratification path accepts them.
