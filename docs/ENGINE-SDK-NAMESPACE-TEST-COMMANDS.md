# Story test commands in the namespace engine

`test-command.context` returns the exact current commands, their hashes, the original requests,
acceptances and revocations, and the pinned deciding groups. It reads accepted receipts and
checks the final Story revision. Reading this context neither runs tests nor grants authority.

`test-command.request` and `test-command.decide` now have namespace owners. The native Git host
keeps its original request, re-pin, presence and terminal review contracts. The namespace request
uses an explicit `sflow-namespace-story-command/v1` wrapper:

```js
const view = await engine.run('test-command.context', {phaseId: 'build'});
const current = view.manifest.commands[0];
await engine.run('test-command.request', {
  phaseId: 'build',
  command: {
    profile: 'sflow-namespace-story-command/v1',
    command: reviewedStructuredCommand,
    replaces: {id: current.command.id, sha256: current.sha256}
  },
  reason: 'The reviewed command executes the approved regression scope.'
});
```

Story commands remain required tests; this operation cannot demote a test to advisory or replace
a non-test quality obligation. An additional command uses `replaces: null` and a new ID. A replacement names the exact current
normalized descriptor and its hash. The repository's configured commands and original Story
configuration remain immutable. Human acceptance supplies a Story-only overlay; revoking it
restores its predecessor. A later replacement cannot silently outlive a revoked prerequisite.
Native inspected suggestions and file-derived re-pins remain distinct contracts; this profile
requires the full explicit structured command.

The current phase's author may request a command. Only an authenticated human in the original
deciding group can accept or revoke it, under the original self-acceptance policy. A submitted
review cannot have its commands changed in place. Authority, current phase, request, original
receipt and conditional transaction are recomputed before acceptance and during historical replay.
Repeated delivery reuses the accepted operation instead of adding a second command decision.
Required person-presence signatures or test-recovery agreements still need their actual owners;
a command acceptance cannot replace either contract.

An accepted command is never passing test evidence. Continue the preserved private draft using
its exact rebase binding, retain its source, and run `phase.checks.run` through an explicitly bound
SGOS executor. The executor must match the approved executable, argv, environment, result adapter
and source selection. The old executor is refused before starting a process. Check-plan v2 names
the actual accepted command inventory; plan v1 keeps its original configured-only meaning.
Original configuration, source, task, report bytes, attempts and receipts still verify independently.

Publication, prepublication inspection, Code coverage and test-witness discovery use the same
verified command inventory. The original tests remain required until their exact replacement is
accepted. Removing an execution binding, changing permission, missing evidence, unreadable original
receipts or changed source does not become success or trigger an unbound fallback command.
The installed SDK can read and replay the original decisions without the old laptop or checkout.

Forward-amendment pending/latest/revalidation queries also have a shared kernel owner. Frozen
native results cover presence filtering, exact input hashes and generation changes. Native command
rendering remains in its adapter. This query extraction does not implement namespace forward
amendment publication or its human revalidation mutations.

## Qualification and remaining work

The new Mac checks exercise filesystem, SQLite and application stores; actual Node test execution;
Code acceptance and independent approval; command revocation; interrupted acknowledgement;
unreadable original receipts; an offline installed consumer with empty PATH; and shared-only replay.
Frozen pre-extraction fixtures verify original native values and errors. Qualification passes
421 distinct affected Mac checks, including 79 native compatibility checks, 94 architecture
checks and the unchanged 34-check installed qualifier in 42.4 seconds. Source validation passes
4,231 checks; VS Code types, the unchanged Git ownership audit and all 13 original bundle ceilings
pass. No deadline, package test, schema guard or bundle ceiling was relaxed.

This delivery advances the Phase 5 query and Phase 7 test-command owners. Test recovery agreements,
test/evidence risks, bounded repair, forward amendments and the other owners in the
[completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md) remain required. Neither phase is complete.
