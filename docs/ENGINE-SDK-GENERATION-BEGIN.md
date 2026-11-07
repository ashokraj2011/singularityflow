# Generation begin operation

`engine.run('phase.begin', inputs)` and `engine.beginPhase(inputs)` establish the installed local
code-generation boundary. The CLI's `phase begin` uses this same operation. Its existing JSON
and text remain host projections; native generation receipts and approval authority do not change.

## Contract

| Input | Meaning |
|---|---|
| `workId` | Optional exact Story binding; does not select another checkout |
| `phaseId` | Optional phase ID, defaulting to the current Story phase |
| `adoptExisting` | Explicit request to adopt the reviewed application change set, subject to the existing policy |
| `confirm` | Exact current adoption digest; does not replace the required review or override source/protected-path rules |

Root, workflow, provider and actor overrides are not operation inputs. A trusted native host binds
an explicit checkout. Each invocation starts without inherited advisory/configuration read scopes.
The accepted Story loader and the installed native admission remain responsible for saved policy,
agent identity, phase sequence, local documents, pending publications, approved scope, feature
readiness and host readiness.

The operation has three port stages: `load`, `verify` and `begin`. The kernel captures the Story,
phase, generation high-watermark and existing intent before awaiting the selected stage. An open
intent for exactly the next generation takes `verify` and returns `retained`; otherwise `begin`
runs the native local draft transaction and returns `begun`. A repeated call neither relabels a
published generation nor silently repairs or replaces an invalid existing receipt.

The semantic result includes the bound subject, phase, prospective generation and logical intent
identity, receipt digest, baseline source revision and open status. It has no physical receipt path
or actor-presentation body. The effect record distinguishes opening/saving a local draft from a
verified retry. Both outcomes explicitly report no commit, push, test execution, model invocation,
approval or phase advancement. The result is provenance, not a substitute for the edit guard's
verification of the canonical local receipt.

## Native compatibility

The admission transition has left `state.mjs` for the native `generation-boundary.mjs` owner. The
original function remains a compatibility delegate, supplying twelve named legacy collaborators. Its
fifteen admission statements and the local transaction's body retain their predecessor tokens.
This is not a claim that those legacy policy helpers have all reached the kernel.

The local draft transaction now has one implementation in
`src/engine-compatibility/story-draft-transaction.mjs`; its old command-helper export is an alias.
Existing callers use the native owner directly. Lock acquisition, revision checks, preimages,
telemetry-cursor capture, rollback, journal retention and subject-specific recovery are unchanged.
Opening a generation is still local. Its receipt joins an ordinary later lifecycle publication;
the operation never commits application changes by itself.

Native errors preserve their identity, code, cause and recovery details. Optional
`enginePhaseBegin` diagnostics name the completed/pending stage and whether local effects may
exist. They do not retry a failed transaction or claim that cancellation rolled back a completed
write. The native journal remains responsible for uncertain or failed recovery.

This operation preserves the original CLI creation response, including `local: true` and
`lifecycleEvent: null`, and its retry response containing only the original intent. SDK fields
are not added to either legacy envelope. Source and bundled CLI routes use the registered path.

## Remaining scope

[Reviewed rollover](ENGINE-SDK-GENERATION-ROLLOVER.md), draft-check and prepublish now use their
registered operations. Preparation and the remaining native policy helpers still need their own
extractions. This operation adds no arbitrary storage writes, new Git layout, authority
cutover, alternate backend or standalone SDK package. The full scope remains in the
[migration plan](ENGINE-SDK-MIGRATION.md).

## Local qualification

Mac qualification on Node 26.12.0 passes 320 distinct focused checks without failures,
cancellations or skips. This includes 150 publication/recovery fault checks, complete dirty-review
repair journeys, protected/source-boundary generation checks, feature-readiness admission,
instruction-defined test commands, work intervals, source/bundled CLI parity and SDK/import guards.
After narrowing the native dependency and protecting optional diagnostics, a final 112-check
rerun also passes. It confirms that incomplete retained receipts reach native verification and
that frozen/read-only diagnostic properties never replace the original error.

All thirteen existing bundle budgets pass unchanged; the gateway remains 852 modules / 6,742,146
bytes. The pure SDK closure is 15 modules / 191,747 input bytes, with zero external imports.
Repositories, remotes and machine state are isolated local fixtures. No Windows, hosted CI, live
provider, merge, push, real Story or installation migration is part of this qualification.
