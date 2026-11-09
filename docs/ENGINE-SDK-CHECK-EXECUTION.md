# Explicit local check execution

The SDK's `testing/execution` entry supplies an authorized fixed-command SGOS unit. It runs real
checks against an explicitly selected checkout and retains their actual bytes through SDA content
ports. It has no Git, CLI, provider or installed workflow discovery. It records observations;
the registered phase operation and its acceptance policy still need their integration owner.

## Explicit host binding

The embedding host supplies the project/repository identity, absolute checkout, pinned executable
digest, fixed argv, exact environment, report adapter/destinations, source selection, deadline,
shared content store and command authorization callback. Arguments and environment are copied
before execution. Ambient `PATH`, `HOME`, `NODE_OPTIONS` and credentials are not inherited.
The manifest binds argument and environment digests without retaining environment values.

```js
import { createNodeCheckExecutionUnit } from '@singularity-flow/engine-sdk/testing/execution';

const unit = await createNodeCheckExecutionUnit({
  id: 'application-check', projectId, repositoryId, root: selectedCheckout,
  command: { executable, executableSha256, arguments: approvedArguments, environment },
  report: { adapter: 'node-tap', files: [] },
  content,
  authorizeCommand: (manifest, contract) => authorizePinnedCheck(manifest, contract)
});
```

An empty report-file list selects captured stdout. File reports use explicit relative destinations;
escaping paths, symbolic links, non-regular files and byte-limit violations are refused. The
selected report destinations are excluded from the source snapshot, alongside the host's explicit
exclusions. The complete selection is retained in the unit manifest. A phase integration must
verify that selection against its approved source and command policy.

The task names exactly one `repository:<repositoryId>` read scope and can declare that same write
scope. Authorization is checked before launch and the executable is freshly verified. The existing
generic execution profile continues requiring its externally attested sandbox, denied network
and empty repository/Device scope. This separate profile truthfully declares host-local execution
without containment and host-unrestricted network. Construction does not certify a sandbox.

## Retained observations

The `sflow-local-check-execution/v1` candidate output contains:

- the exact manifest/task binding and command fingerprints;
- real exit status, signal, timeout, output-overflow and process-close observations;
- verified immutable runtime references to stdout, stderr and raw reports;
- verified before/after source snapshot references and their revisions;
- the shared report codec's counts/identities, or original diagnostic details when unavailable.

An unchanged old file cannot become this run's report. Missing, stale, invalid and inaccessible
reports retain explicit diagnostics and never produce a partial successful report set. A failing
test retains its actual nonzero exit and failing counts. Source drift remains visible. Ordinary
TAP has no exact source-identity claim. None of these observations records phase acceptance,
criterion satisfaction, human review or approval.

The unit composes with `execution/runtime` and namespace operational storage. That owner claims
the attempt before launch, retains the candidate/events and lets another host read its completed
result without executing again. Raw bytes stay separately addressable rather than being embedded
as large JSON strings. Existing runtime rollback and unknown-effect recovery rules remain in force.

## Supervision and failure handling

One SGOS process supervisor serves the generic unit and local checks. It uses fixed argv and
`shell: false`, bounded output and bounded termination. Spawn/input-stream errors are returned
after actual close, preserving their original error. An exited leader cannot prevent cancellation
of descendants holding its pipes. On this qualified POSIX host, owned descendants with closed
pipes are also terminated before collection completes. An unconfirmed process-group termination
produces an explicit failure and cannot mint a positive quiescence receipt.

Authorization, executable reads, source/report observation and content retention have bounded I/O
waits. Cancellation or an expired authorization wait cannot launch a late command. An observation
timeout does not establish a DNS, credential or disk cause. A late immutable content write may
finish after an interrupted acknowledgement; it cannot accept lifecycle evidence or authorize a
new process. The host reconciles accepted operational receipts before repeating an attempt.

Windows keeps its existing process-tree signaling implementation and has not been qualified by
this Mac-only delivery. No hosted CI or Windows run is implied by local process tests.

## Mac qualification

The broad native regression run passed 226 checks across eight files. After the final report
selection and termination-diagnostic fixes, all 105 focused checks across four files passed.
The independently packed and installed SDK passed 23 checks, including actual Node execution,
retained raw bytes and NodeNext declarations. Those runs reported no failures, cancellations
or skipped tests. No package-test deadline was raised.

The process checks cover input-pipe failure before close, descendants that retain or close their
pipes, active/pending stops and an unavailable termination observation. The latter retains its
original stream failure and returns no positive quiescence receipt. Additional cases cover stale,
missing and symbolic reports, source drift, bounded I/O, large report selections, and durable
reuse through filesystem, SQLite and application metadata adapters without a second launch.

Source validation passed 3,889 checks across 191 skills. VS Code typechecking and all 13 existing
bundle budgets passed. The process/Git audit retains 2,011 sites; only the existing SGOS owner's
reviewed launch-site fingerprint moved with its supervisor. No allowance or ceiling was added.
The optional SDK retains 51 operations and builds from 145 modules, emitting 1,448,547 JavaScript
bytes. These are boundary/compatibility checks, not a complete Story or a latency benchmark.

All execution used isolated local fixtures. No Windows, hosted CI, live provider, product install,
real Story mutation, migration, merge or push ran.

## Remaining integration

The namespace engine still refuses phases whose policy/execution owners are unavailable. The
next owner must resolve pinned phase commands through the registry, authenticate this execution
against the current draft/configuration/source, accept evidence conditionally and bind it into
publication and immutable submission packets. Complete application Story execution, additional
native policy extraction, existing-project migration/cutover and final distribution/performance
qualification remain Phase 5, 7, 8 and 9 work.
