# Post-transition effects and host presentation

After a lifecycle commit, SFlow refreshes the local phase/session projection, records receipts for
required delivered actions and records specification claim/delivery usage. The existing native
writers, transaction checks, idempotency and state-branch layout still own those effects.

`engine-compatibility/post-transition.mjs` now coordinates them independently of command helpers.
It returns native facts and the original errors. It contains no console output, prompt or rendered
recovery command. Optional effects keep their existing applicability checks and lazy writers.

`phase-post-transition-guidance.mjs` owns the CLI warning text, safe recovery routes and success
lines. Existing command-helper paths re-export its compatibility functions. Internal CLI consumers
use this owner directly; native approval and submission use the effect service instead.

## Headless diagnostics

The Git composition accepts a trusted `notice(event)` observer. A headless integration can use it
without loading CLI presentation, and can inspect the latest 256 advisory events on that binding:

```js
const sflow = createSflow({
  root: '/workspace/repository',
  notice(event) {
    // The host decides how to display or record this native observation.
    observe(event.code, event.workId, event.error?.code);
  }
});

const decision = await sflow.approvePhase(reviewedInputs);
const notices = await sflow.notifications();
```

These are machine-local diagnostics for the existing Git composition, not new lifecycle records,
approval authority or a replacement for native pending-publication recovery. They do not change
the `sflow-engine/v1` operation receipt. Native errors remain available on `event.error`, including
their codes and causes. The CLI retains its existing diagnostic redactor and command renderer.

| Notice code | Native observation |
|---|---|
| `transition.tail-failed` | A projection or session refresh failed after the lifecycle commit |
| `transition.receipts-failed` | A required delivered action's receipt could not be recorded |
| `transition.usage-failed` | The specification usage writer failed |
| `transition.usage-differs` | Existing state-branch usage differs and was preserved |

A failing observer cannot convert an accepted lifecycle transition into another approval attempt.
The effect report keeps both the native failure and, separately, the observer failure. The bounded
diagnostic list retains the native event. CLI adapters continue to show the same recovery routes.
The actual receipt/usage writers and later readiness gates still determine what remains to repair.

The shared post-publication wrapper also serves existing reject, reopen, review and synchronization
paths. Its old module exports remain available, while effect execution and presentation have one
owner each. Source guards prevent the native service from acquiring CLI imports or console output.

## Mac qualification

The 92-test regression run passed with no failures, cancellations or skips in 150.5 seconds. It
covers real SDK/CLI approvals and submissions, partial/duplicate/unauthorized approval votes,
required action receipt recording and retry, lost-outbox recovery, specification-slice claim and
delivery usage, state-store transactions/leases, startup ownership and dependency guards.

A native approval was fault-injected after its commit: both session refresh and the headless
observer failed, yet the exact committed approval remained approved, the successor remained
Implementation and the native failure code remained inspectable. The specification-slice journey
also confirmed exact usage records and repair of a lost write.

The source gate passed 3,550 checks. VS Code typechecking and all 13 rebuilt bundle budgets passed
without raising a ceiling. The gateway has 849 source modules and 6,730,291 JavaScript bytes. The
pure SDK closure remains eight modules, 75,096 source bytes and zero Node builtin imports; native
bookkeeping and host wording do not enter it. Tests use isolated machine state, temporary local
repositories and fixture identities. No Windows, hosted CI or live provider runs were started.
