# Registered decision recording

Phase 5 adds `engine.run('decisions.record', inputs)` and `recordDecisions(inputs)` to the existing
internal SDK and Node API. CLI recording enters that same registered operation. Reading or
previewing a list remains a read; it does not authorize a write.

## Ownership

- `kernel/decision-plan.mjs` owns answer validation, choice admission and stable amendment batches.
- `engine-sdk/decision-execution.mjs` coordinates the consented effects and reports their confirmed
  prefix, failed effect and remaining suffix.
- `engine-compatibility/git-decisions.mjs` loads the accepted Story and invokes the existing native
  record writers. Each writer retains its identity, group, lifecycle and publication checks.
- `commands/decisions.mjs` owns flags, answers files, terminal interaction, confirmation summaries
  and the existing CLI JSON projection. `decision-list.mjs` keeps its compatibility exports and
  host wording, while delegating rules and coordination to their new owners.

The shared amendment bound has one pure owner in `kernel/decision-limits.mjs`; its existing
`plan-amendments.mjs` export remains available. No record format, authority, Git layout or Story
configuration pin changes.

## Operation contract

```js
const result = await api.recordDecisions({
  workId: 'STORY-1',
  phaseId: 'specification',
  confirmation: reviewedList.packetSha256,
  answers: {
    choose: { d1: 'scope-informative' },
    reason: { d1: 'The source owner reviewed this statement as informative context.' }
  }
});
```

`workId`, `phaseId` and `fetch` select the native Story context. `answers` contains only `choose`,
`reason`, `expires`, `cause`, `clause` and `article`. The confirmation must match the exact current
decision-list digest. The operation does not accept actors, authority claims, caller-built packets,
executable plans, callbacks or selection receipts. Inputs are bounded, detached and frozen before
asynchronous work, without executing caller accessors.

The trusted port loads the native list. The SDK snapshots its policy data and decision date before
host interaction. That snapshot contains choice IDs, needs, authority facts and effects; command
strings and display-only authority guidance stay out. A terminal host may ask the person and return
their answers. The default headless path requires explicit answers and exact confirmation; it
never silently accepts a default decision. Native identity is resolved when effects begin, after
interaction, and each existing writer still validates the person who is acting.

The immutable `sflow-engine/v1` receipt contains the bound Story, phase, recorded entries, refused
choices, remaining-list summary and its digest. `effects.recordedEntries` counts associations
between choices and native records. It does not claim a unique number of commits or pushes: several
plan paths may share one amendment, and one choice may require multiple records. A declined human
confirmation returns `status: 'not-recorded'` with no effects.

## Failure and recovery

Cancellation before an effect changes nothing. Once a native effect starts, the operation preserves
its real accepted, failed or unknown outcome instead of claiming that cancellation undid it. A
failure stops the plan at its exact suffix. The native error and confirmed prefix remain available
on `error.engineDecisionEffects`; the CLI retains its existing partial-record refusal and recovery
guidance. Finishing or presenting the result cannot conceal a failed native write.

The typed receipt refuses malformed or differently bound record projections and invented refusal
entries. A projection failure after recording retains the same effect report for inspection; it is
not an instruction to repeat successful writes. Stale list confirmation is refused before any
effect. The subsequent list is read from current native state, so replaying a completed selection
does not recreate its decisions.

If after-state inspection is unavailable, `remaining` and `packetSha256` are `null`, rather than an
invented empty list. The original inspection error is retained in native context and exposed through
the Git host's local diagnostic channel as `decisions.inspection-unavailable`. A diagnostic observer
failure does not change a successful decision record.

## Compatibility work that remains

The Git port calls native exported writer functions that still reside in several
`commands/decision-*.mjs` modules. It does not invoke CLI dispatch, argument parsers or subprocesses.
Those native writer bodies and the legacy partial-failure formatter still need their own extraction
before the decision boundary is fully independent of command modules. This explicit bridge does not
claim completion of Phase 5, a new storage backend, public package extraction or project migration.

The pure SDK closure contains 11 source modules, 92,591 source bytes and no external imports. The
gateway adds exactly three extracted pure owners: the decision planner, limits and coordinator
(849 to 852 modules). All byte ceilings and the other runtime module ceilings remain unchanged.

## Local qualification

The 68-test focused Mac run and 33-test native journey run pass with no failures or skips. They
include actual SDK recording,
CLI-to-SDK receipt comparison, stale replay, unauthorized identity refusal, existing planner/UI
compatibility, source boundary guards, malformed result admission and native failure preservation.
Tests use isolated machine state and local Git fixtures; no real Story, installation or remote
service is changed. The journey run also covers a multi-phase decision/approval incident, actual
plan amendment and preservation of unrelated work, combined approval decisions, partial approval
thresholds, and existing publication/submission/approval receipt parity (168.5 seconds).

`npm run check` passes 3,556 checks across 191 skills. VS Code typechecking, all 13 freshly rebuilt
runtime bundle budgets and npm dry-run packaging pass. All four new owner modules and this document
ship; tests and fixtures remain excluded. The native effect dispatcher, record ID projection, batch
planner and plan executor were compared with their previous implementations using normalized syntax
trees; their bodies are unchanged apart from rebased imports. Windows, hosted CI and live providers
are not part of this delivery.
