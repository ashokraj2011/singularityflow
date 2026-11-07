# Engine SDK submission slice

This is the first delivery of migration Phase 5. It adds two registry entries to `sflow-engine/v1`:

| Operation | Typed helper | Boundary |
|---|---|---|
| `phase.submit` | `submitPhase` | Submit the exact published generation under its existing checks and approval policy |
| `convergence.submit` | `submitConvergence` | Submit an explicitly confirmed convergence result; it still requires human phase approval |

The CLI, its confirmed convergence callback and the existing `createSflow` Node integration use
these entries. Neither helper has a separate transition implementation. Story advancement's
preview, lock, disposition checks and digest confirmation remain in their existing command owner;
the confirmed submission callback now enters the registry. Extracting the full advancement
operation, decisions, approval, manifests and queries remains Phase 5 work.

```js
import {createSflow} from 'singularity-flow/src/api.mjs';

const sflow = createSflow({root: '/workspace/repository'});
const result = await sflow.submitPhase({workId: 'STORY-1', phaseId: 'team-design'});
```

This submits an already published phase. It does not author an artifact, invoke a model, attest
visual evidence, record a human decision or approve the phase. Required code tests cannot be
waived by choosing another host or passing `runChecks: false`.

## Inputs and outcomes

Both operations accept `workId`, `phaseId`, `runChecks` and `decisionValues`. Only
`convergence.submit` accepts `confirmation`, the exact reviewed `sha256:` convergence digest.
An ordinary submission cannot receive a confirmation, actor, approval policy or private authority
flag. The accepted Story, pinned configuration, session and authorization are loaded by the native
port. The private native convergence authority remains unexported in the aggregate owner.

Inputs have the publication slice's bounded, frozen plain-JSON contract. Decision inputs are a
name-to-scalar map; the pinned decision defines their meanings, required fields, choices and numeric
bounds. A retry of an already submitted generation preserves its recorded values and reports any
newly supplied values as ignored. Neither submission operation changes those values on a retry.

The SDK's immutable result contains:

```js
{
  schemaVersion: 1,
  contract: 'sflow-engine/v1',
  operation: 'phase.submit',
  status: 'awaiting-approval', // completed or retained are also possible
  subject: {kind: 'story', id: 'STORY-1'},
  phase: 'team-design',
  generation: 1,
  revision: '<opaque-authority-revision>',
  effects: {committed: true, pushed: false},
  submission: {
    phaseStatus: 'awaiting_approval',
    submittedAt: '<recorded-timestamp>',
    approvalMode: 'required',
    currentPhase: 'team-design',
    reviewPacket: '<packet-binding>'
  }
}
```

`completed` means that the pinned policy explicitly required no human approval or its existing
deterministic waiver passed. It does not mean that the SDK manufactured a human approval.
`retained` means an already submitted generation, with no new commit or push. The legacy aggregate
may not expose an exact submission revision or packet binding; those fields are explicitly `null`
on that retained response. A retry does not add a history scan to manufacture either value.

The CLI owns its unchanged `command-result` projection, personalization, deterministic next actions,
document display and Shell/Copilot/VS Code rendering. Those host decorations are absent from SDK
receipts. The projection is exported as `phaseSubmissionCommandResult` for parity qualification.

An engine may bind only the operation ports it implements. Its registry still names the versioned
vocabulary; calling an operation without its port returns `ENGINE_PORT_UNAVAILABLE` before I/O.
An unknown operation remains `ENGINE_OPERATION_UNSUPPORTED`.

## Owners

| Owner | Responsibility |
|---|---|
| `engine-sdk/index.mjs` | Input/result contracts, captured port functions, dispatch, stage order and cancellation |
| `kernel/submission-intent.mjs` | Decision-input preflight and separation of ordinary versus confirmed convergence submission |
| `kernel/decision-inputs.mjs` | The existing decision-input normalization and binding rules, now independent of host I/O |
| `engine-compatibility/git-submission.mjs` | Accepted context, native publication, exact review packet, existing post-commit receipts and session handoff |
| `engine-compatibility/submission-transition.mjs` | The existing 788-line native submission transition moved out of `state.mjs` |
| `evidence/refusal-memory.mjs` | Disposable retry memory and its unchanged transition wrapper |
| `commands/submit.mjs` | CLI flags, legacy result projection and presentation |

`workflow-decisions.mjs` and the old command-layer retry helper retain compatibility exports. The
aggregate's status, validation and write exports retain their original function identities. Only
the aggregate compatibility owner may load the extracted native transition. Its 43 aggregate
collaborators are explicit compatibility debt, rather than a storage-neutral port contract.

The native transition body is unchanged apart from relative import rebasing and collaborator
binding. Its normalized body has 111 statements and SHA-256
`015daad1c5dd9a3de9a47691ce8a1d67a213520c3eb2044a946885dc1aa4c388` relative to the Phase 4 baseline.
The one existing read-only Git tree observation moves with it; total Git call sites do not increase.
Existing source review, generation freshness, source/test evidence, required checks, presence,
approval modes, terminal evaluation, records, hashes, authority and recovery remain native owners.

Native post-commit compatibility tails still use the shared command-layer receipt/projection
helpers. Their local receipts and warnings are not new transition authority. Moving those helpers
to their final owners is shared work with the upcoming approval extraction. Likewise, legacy
diagnostic wording is retained; this slice does not claim that every old error now has semantic
action data. No prompt or provider implementation enters the pure SDK/kernel closure.

## Qualification and budgets

The [migration plan](ENGINE-SDK-MIGRATION.md) records Mac qualification. Fixtures use isolated
machine state and local repositories/remotes; they do not migrate a real project. Windows, hosted
CI and live providers are excluded.

The gateway bundle admits two additional extracted owners: the pure decision-input module and
the native submission transition. Its source-module ceiling changes from 846 to 848; the byte
ceiling and all other runtime ceilings are unchanged. These are owner extractions, not additional
process, provider or transport dependencies. Source import closures and native journeys remain
separately checked; module counts alone are not a latency measurement.

This delivery does not complete Phase 5 or the migration. Filesystem and database storage,
standalone packaging, existing-project authority cutover and obsolete-path removal keep their
original later-phase gates.
