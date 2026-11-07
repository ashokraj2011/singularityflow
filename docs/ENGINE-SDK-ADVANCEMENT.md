# Registered convergence advancement

`convergence.advance` coordinates a reviewed convergence result and the existing
`convergence.submit` operation. The CLI and the Node API enter the same registry. Advancement
does not approve a phase or activate its successor: the existing non-waivable human approval
remains a separate operation.

This is another Phase 5 extraction. It retains the installed Git authorities and is not an
alternate storage backend or an authority migration.

## Inputs and results

The closed JSON input contains only `workId`, `confirmation`, `runChecks` and `decisionValues`.
An omitted confirmation requests a read-only preview. A supplied confirmation must equal the
freshly verified convergence snapshot digest. A phase override, actor, authority, review packet,
callback or private submission flag cannot enter through this operation.

Both entry forms use the same operation:

```js
const preview = await sflow.run('convergence.advance', {workId});
// Present the result to the human. Obtain their exact reviewed digest separately.
const submitted = await sflow.advanceConvergence({
  workId,
  confirmation: humanReviewedDigest
});
```

The preview receipt contains the bound Story, phase, generation, iteration, finding count,
reconciliation identity and confirmation digest. Its status is `ready-to-confirm` and both
effect flags are false. It contains no shell command or model prompt.

A confirmed receipt contains the actual nested `convergence.submit` receipt. Its status is
`awaiting-approval` or `retained`; its subject, phase and generation must match the reviewed
binding, and its approval mode must remain `required`. A retained outcome does not claim another
commit. Ordinary `phase.submit` still cannot acquire convergence authority from a flag.

## Ownership and lock lifetime

| Owner | Responsibility |
|---|---|
| Kernel | Existing blocker evaluation and exact digest comparison |
| Engine SDK | Input validation, detached review facts, confirmation and registered submission coordination |
| Git compatibility port | Accepted configuration, fresh aggregate/projection, source and terminal checks, existing subject lease |
| Existing submission port | Actor and session checks, required tests, immutable submission packet, conditional publication and recovery |
| CLI | Flags, legacy JSON/text, warnings and safe command guidance |

The trusted advancement port implements `withReview(inputs, operation, {signal})`. It must await
the operation exactly once and return its actual result while holding the existing Story lock.
This callback is an internal port protocol, not a public or model-callable input. The SDK captures
the port method at construction, rejects missing/repeated/out-of-scope callbacks and rejects a
replacement result. It does not turn an untrusted port implementation into an authority.

The native port preserves the former command's sequence:

1. Resolve accepted Story execution and take its existing subject lease.
2. Reload the aggregate and current convergence context inside that lease.
3. Read the same installed convergence file and recheck bindings, facts, settlement and sources.
4. Apply the existing counted-presence and undisposed-finding rules.
5. Verify the exact publishable projection. If this is a terminal convergence phase, run the
   existing terminal gate before offering a digest to confirm.
6. Let the SDK compare the exact confirmation and execute registered `convergence.submit` before
   releasing the lease. The native lease remains reentrant for the existing submission writer.

Every SDK invocation keeps the existing fresh-read scope boundary. Resetting an inherited
advisory read scope does not release the separate Story-lock context. No CLI router or command
handler performs the submission inside the engine.

The shared installed-layout reader lives in
`src/engine-compatibility/convergence-projection-read.mjs`; other Story commands use that same
reader. Missing projections, future/archive versions and corrupt-file errors retain their
existing distinct meanings and causes.

## Effects, failures and presentation

Native failures retain their identity, code, cause, publication commit and recovery details.
Cancellation can stop the next effect; it cannot turn an accepted or unknown publication into
an undone operation. An error after review carries `engineAdvancement` with the captured review
and any completed submission receipt. The underlying writer's `enginePublication` report remains
available when submission committed but could not return a final receipt. A null nested receipt
does not establish that no external effect occurred.

The native port emits only the semantic `advancement.confirmed` notice. The CLI retains the old
confirmation line, preview JSON and next-command rendering. Confirmed submission uses the same
host presenter as ordinary submission. Legacy malformed decision-assignment flags remain ignored
for previews and are reported only after exact consent, as before.

The CLI's formatting runs after the reviewed operation's lease has ended. All authority checks,
confirmation and submission effects remain inside the lease; presentation never controls that
authority. Presentation or observer failure after commit cannot justify submitting again.

## Qualification scope

The SDK tests exercise preview, exact consent, custom phase IDs, retained outcomes, invalid port
results, cancellation and native-error/effect preservation. The complete fresh-clone Story journey
also compares real CLI and SDK previews, observes the CLI's actual SDK submission receipt,
checks a retained retry under the native Story lease, and continues through human approval,
verification and release. Existing convergence integrity, presence and non-waivable approval
guards follow the extracted owners.

Qualification is local on Mac using isolated machine state and fixture Git remotes. No Windows,
hosted CI or live provider runs are required for this slice. Remaining Phase 5 work includes
individual route/amendment operations, context manifests and admission/query helpers. Filesystem
and application backends, installable SDK packaging and verified project migration remain later
milestones in [the migration plan](ENGINE-SDK-MIGRATION.md).
