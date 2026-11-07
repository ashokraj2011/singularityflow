# Engine SDK publication slice

Phase 4 adds `sflow-engine/v1` and its first registered operation, `phase.publish`. The pure entry
is `src/engine-sdk/index.mjs`. It owns dispatch, input/result contracts, stage coordination and the
typed `publishPhase` helper. The helper calls the same registry entry as `run`; it has no second
publication implementation.

The existing Node integration gains the same operation without removing its fault/repair methods:

```js
import { createSflow, ENGINE_OPERATIONS } from 'singularity-flow/src/api.mjs';

const sflow = createSflow({ root: '/workspace/repository' });
const receipt = await sflow.run('phase.publish', {
  workId: 'STORY-1',
  phaseId: 'team-document',
  authored: 'external-tool',
  channel: 'external-tool'
});
```

This publishes an already authored draft. The phase's approved generation policy must permit the
declared producer, and its existing session, identity, artifact, evidence and publication checks
must pass. It does not generate content, invoke a provider, manufacture review or grant approval.
`createSflow` remains a Git-backed compatibility composition; a standalone SDK package and alternate
storage compositions are later milestones. Embedders implementing trusted ports can use the pure
`createEngine` entry independently of that legacy composition.

## Operation contract

`engine.run('phase.publish', inputs, {signal}?)` accepts only these fields:

| Field | Meaning |
|---|---|
| `workId`, `phaseId` | Optional Story reference and phase selection; the native port verifies the accepted binding |
| `authored`, `channel` | Declared authorship, checked against the pinned phase policy |
| `from` | Optional import resource; the Git composition resolves it inside its explicit checkout unless absolute |
| `usage` | Optional plain JSON usage records |
| `usageFile` | Legacy local usage-file resource; mutually exclusive with `usage` |
| `externalAiUse`, `changeOrigins` | Existing provenance declarations |

Inputs are copied and frozen before asynchronous work. Unknown fields, accessors, executable
values, sparse arrays, cycles and non-JSON objects are refused before any port runs. Bounds are
32 levels, 100,000 nodes and 4,194,304 string/key code units plus scalar accounting. The native
usage-file reader retains its existing file-reading behavior rather than rewriting historical data.

The SDK returns its own immutable envelope:

```js
{
  schemaVersion: 1,
  contract: 'sflow-engine/v1',
  operation: 'phase.publish',
  status: 'published', // or retained
  subject: {kind: 'story', id: 'STORY-1'},
  phase: 'team-document',
  generation: 1,
  revision: '<opaque-authority-revision>',
  effects: {committed: true, pushed: false},
  artifact: 'artifacts/team-document/document.md'
}
```

A retained result has no new commit or push and declares `consumed-intent` or `unchanged-document`.
It does not claim a fresh remote synchronization. Revisions stay opaque to the SDK. It refuses a
port response bound to another Story/phase or claiming an invalid generation/effect. Host commands,
Copilot prompts, application-review routes and document rendering are absent from this envelope.

The CLI adapter projects that envelope back to the existing `sflow-phase-publication` JSON and
text contracts. It retains receipt fields, retained messages, optional review offers, telemetry
text and warnings. SDK/CLI parity tests exercise packaged and copied phase names, new publication,
retries, unchanged documents, refusal and accepted legacy records. VS Code, MCP and Copilot routes
which execute this CLI operation therefore enter the same registered publication implementation.

## Boundaries

| Owner | Implementation |
|---|---|
| SDK | `src/engine-sdk/index.mjs`: registry, validation, orchestration and results |
| Kernel | `src/kernel/phase-policy.mjs`: phase interpretation, generation counters, producer policy and provenance records |
| Kernel | `src/kernel/publication-intent.mjs`: publication intent rules, loaded by this operation |
| Git compatibility | `src/engine-compatibility/git-publication.mjs`: accepted-context loading, exact reads, artifact preparation and native publication |
| Git compatibility | `src/engine-compatibility/generation-publication.mjs`: the existing generation transition extracted from `state.mjs` |
| Host | `src/commands/phase-lifecycle.mjs`: flags and CLI projection; `src/phase-publication-guidance.mjs`: publication command rendering |

The SDK and kernel dependency closures admit only their own modules and the shared foundation.
They have no filesystem, process, Git, provider or host imports. Concrete ports are supplied by
trusted embedding code, never by operation inputs or a model. The Git composition selects the
installed authorities and does not accept an arbitrary authority override.

Native ports implement `load`, `retained`, `prepare`, `commit` and `finish`. The SDK owns the order,
early idempotent return, policy checks and result envelope. Ports return publication facts rather
than a host result or SDK envelope. An optional invocation port provides host-owned request-context
isolation; the Git composition clears inherited advisory/configuration read scopes while preserving
authenticated operation context. One long-lived SDK instance cannot reuse a caller's stale preview
as mutation authority.

Cancellation is checked before load and before the next effect boundary. Once commit starts, its
native outcome wins. An abort after acceptance cannot turn a published effect into “cancelled.”
Conflict, indeterminate transport and pending-recovery errors retain their original identity,
cause, codes and recovery fields. A failure in final result projection keeps the completed native
publication accessible on an extensible error's `enginePublication` field.

## Preserved compatibility and remaining work

The native lifecycle transaction, state/configuration authorities, records, hashes, presence
claims, approval identity, exact test evidence, REV selection, atomic publication and recovery
protocols are unchanged. Publication still performs its final fresh binding checks. Existing
`phase-roles.mjs`, `phase-generation.mjs` and authorship exports remain compatibility paths; internal
consumers use the kernel's single implementation. Generation paths belong to `story-paths.mjs`.

The 600-line generation transition has left the aggregate. Its remaining 26 aggregate collaborators
are explicitly supplied by the compatibility wrapper; they are not advertised as storage-neutral
SDK contracts. They still include evidence/test preparation and receipt work which later slices
must assign to kernel, SDA or SGOS owners. The adapter also retains the existing post-publication
drift reader. This milestone does not claim that every legacy helper or operation has been ported.

Later phases extract submit, decisions, approval, advancement, manifests and queries, qualify
filesystem/database stores, package the standalone runtime, and implement verified migration.

## Qualification

Mac-only qualification is recorded in [the migration plan](ENGINE-SDK-MIGRATION.md). The native
tests use isolated machine state and fixture repositories. They include the real CLI path and
exercise manual/no-model, code publication and its tests, custom phases, pending publication,
lost races, REV, source encodings, monotonic generation counters and backward-compatible APIs.
Windows, hosted CI and live provider calls are outside this qualification.

Compared with `83c589d54`, the static source closures are:

| Entry | Modules before / after | Source bytes before / after |
|---|---|---|
| `session current` | 220 / 218 | 4,157,914 / 4,147,681 |
| Phase lifecycle handler | 458 / 443 | 9,547,718 / 9,215,047 |
| `nextsteps` handler | 117 / 115 | 2,349,497 / 2,311,925 |
| Phase entry | 238 / 237 | 4,493,643 / 4,485,244 |
| New pure SDK | — / 4 | — / 33,510 |

These are transitive static source closures, excluding deferred imports and process startup. They
are not claims about complete-command latency or Windows performance. The existing source/module
and VS Code bundle limits remain unchanged.
