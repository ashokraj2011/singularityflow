# Registered phase checks and retained execution evidence

`engine.run('phase.checks.run', { operationId, workId, phaseId })` selects the Story's pinned
commands and records their real execution results. Callers cannot supply replacement argv,
readiness flags or fabricated counts. The operation enters the same versioned registry as
preparation and publication. It preserves the current generation, private draft and canonical
Story revision; it does not publish, submit, approve or advance a phase.

## Ownership

The kernel owns check verdicts, stdout-report policy and result contracts. The SDK owns stage
coordination and declared operation inputs. The concrete namespace host binds explicit storage,
access, source observations and SGOS execution capabilities. SDA accepts conditional metadata
transactions. SGOS owns real attempts, live process ownership, events, results and quiescence.

The native `qualityValidationVerdict` rule moved unchanged to `kernel/phase-checks.mjs`. Its previous
module retains compatibility exports. Native callers and the namespace host share that rule and
the stdout-report predicate. A corpus captured from `bf90a66a2` preserves 30 verdict outcomes and
40 stdout-policy outcomes/errors under POSIX and Windows path grammars. That is pure string-rule
qualification on this Mac, not native Windows qualification.

## Explicit binding

The optional SDK entry `hosts/namespace-checks` provides a standalone check host. The public
`hosts/namespace-engine` composition also accepts `checks: { owner, bindings }`. Each binding names
a phase, command ID, logical repository, executable mapping, byte digest, exact environment and
execution unit. Construction captures those capabilities without selecting installed context or
starting work. No current working directory, Git branch, provider or global session is discovered.

```js
const engine = createNamespaceEngine({
  ...namespaceBindings,
  working: { records: localRecords, content: localContent },
  sources,
  checks: { owner: explicitExecutionOwner, bindings: approvedCheckBindings }
});
const result = await engine.run('phase.checks.run', {
  operationId: 'checks-after-authoring', workId, phaseId
});
```

The initial profile supports approved structured test argv, declared report adapters and local
execution with `modelPolicy: never`. It requires every pinned command for every selected source
repository. Legacy shell commands, named environments, non-test checks and alternate working
directories retain explicit missing-owner errors. They are not silently skipped or relabeled as
passing. Their execution-policy integration remains required work.

The host verifies the executable mapping, argument/environment fingerprints, report destination,
source selection and configured deadline against the pinned command. The existing Node backend
accepts an optional host cancellation signal before execution; task, handle, event and receipt
wire records retain their v1 fields. Cancellation during an ownership claim cannot launch a late
test process. Active cancellation waits for actual quiescence.

## Intent, execution and conditional acceptance

Before launch, an immutable intent records the exact phase, target generation, private draft
identity, configuration, accepted lifecycle basis, author, source snapshots, manifests and task
contracts. Its preparation transaction checks the current Story, authority and configuration
revisions. A durable SGOS attempt is claimed before an executor can start. Actual output and
reports remain separately addressable runtime content.

The result reader verifies the original lifecycle receipt and command sequence. It replays actual
raw reports through the shared codec, verifies source manifests and task bindings, and compares
the derived checks with the retained summary. A report from another destination, invented counts,
missing bytes or an unaccepted candidate cannot become phase evidence.

Final acceptance rechecks the private draft, authenticated actor, permissions and current source.
One conditional transaction accepts an immutable result manifest and updates its draft-specific
index while checking Story/configuration/authority revisions again. It does not rewrite the
canonical Story head. Concurrent index changes receive bounded acceptance retries without
reexecuting commands. Existing corrupt indexes are not overwritten as an automatic repair.

The `sflow-namespace-phase-checks/v1` family has separate closed plan, intent, result, manifest and
index schemas. Readers dispatch at the stored version and verify the exact acceptance transaction.
Content preparation and self-hashed candidate records alone do not prove acceptance.

## Recovery within the current phase

Lost intent or final acknowledgements resume by operation ID. A temporary acceptance-storage or
permission failure can reuse the genuinely retained execution after the same binding is restored.
An accepted result reopens on another host without the old private draft or executor. Acknowledging
it authenticates its original person without requiring the old phase agent or new write authority;
it does not restamp the result, run tests or record another effect.

Changed source or draft bindings require a new explicit check operation in the current phase.
Earlier attempts remain retained. Unknown SGOS effects preserve their existing recovery refusal;
the host does not infer failure from a timeout or automatically relaunch uncertain work. Failing
tests are recorded as failed evidence. Missing/corrupt reports and real permission/I/O errors
retain explicit diagnostics and cannot yield a passing verdict.

## Mac qualification and remaining scope

The final focused run passed 145 checks across nine files. Native integration passed 65 checks
across six files. The packed SDK passed all 24 checks, including a real registered check journey
and a separate empty-PATH process acknowledging its evidence without private storage or an
executor. Those runs reported no failures, cancellations or skipped tests.

The optional SDK now has 52 operations and builds from 149 modules, emitting 1,500,065 JavaScript
bytes. All 13 existing bundle budgets passed unchanged: gateway 852 modules, extension 152,
Help 135, support 111 and prewarm 23. No ceiling was raised.

Source validation passed 3,895 checks across 191 skills. VS Code typechecking and the unchanged
2,011-site process/Git ownership audit passed.

Publication and submission still require explicit versioned bindings to these accepted results.
The primary-document host continues refusing `check-execution` until that integration is present.
No caller flag disables the requirement. Complete application Story execution, remaining policy
owners, existing-project migration/writer cutover and final distribution/performance qualification
retain their Phase 5, 7, 8 and 9 gates.

All execution used isolated Mac fixtures. No Windows or hosted CI, live provider, product install,
real Story mutation, migration, merge or push ran.
