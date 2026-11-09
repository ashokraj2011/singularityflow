# Shared structured test-report interpretation

The native test runner and optional Node SDK now interpret report bytes through one pure
kernel owner. This is a prerequisite for portable phase checks. It does not certify an executor,
accept a phase, establish a human witness or change an installed project's authority.

## Ownership and public entries

`src/kernel/test-report-codec.mjs` owns the existing report interpretation rules. Its only import
is the shared error constructor. It has no filesystem, process, Git, configuration or provider
dependency. Its factory captures explicit byte conversion, allocation, concatenation and SHA-256
functions without invoking them during construction.

`src/verification/test-report-reader.mjs` selects Node bytes and hashing. The existing native
`code-delivery-tests.mjs` exports remain compatibility aliases. Physical file discovery, path
security, report freshness, command execution and native execution-receipt creation stay in their
native owners. Reporter environment setup belongs to the existing `test-runtime.mjs` host;
the previous Node observation module retains its compatibility exports.

The SDK exposes two opt-in entries:

- `testing/reports`: pure interpretation with the explicit `sflow-test-report-bytes/v1` capability.
- `testing/node`: `createNodeTestReportCodec()`, selecting Node bytes and hashing only.

Neither entry discovers a repository, chooses a command, reads a file or starts a process.
The application supplies actual report contents:

```js
import { createNodeTestReportCodec } from '@singularity-flow/engine-sdk/testing/node';

const codec = createNodeTestReportCodec();
await codec.prepareTestReportReader('vitest-json');
const observation = codec.replayTestReports('vitest-json', [
  { contents: retainedReportBytes }
]);
```

Lazy report readers still require preparation before replay. Preparation initializes the pure
reader rather than importing framework discovery or execution code. Public declarations describe
raw contents; a path alone is not a report.

## Preserved meaning

The extraction preserves the existing JUnit, TRX, Node TAP, Jest/Vitest JSON, Go JSON, Karma,
Playwright, Mocha and Cargo interpretation and refusal semantics. XML structure and aggregate
checks, occurrence identities, ambiguous names, retry observations, digest composition and
per-file/combined limits retain their original behavior. Strict local replay remains distinct
from the existing general replay route. Null-prototype XML attribute dictionaries are preserved.

The original 38 rule bodies are checked against independently captured native function hashes.
A packet captured from `7c1f01311` records 38 native results and refusals, including original error
identity. The existing facade, pure explicit-capability codec and standalone Node codec replay
that same packet. The fixture is not regenerated from the extracted implementation.

Plain Node TAP cannot establish exact source locations for passing cases. The native custom
reporter retains its existing exact identities. Parsing a passing count does not authenticate
the process, prove that the report is fresh or establish that an acceptance criterion was met.
Phase policy continues deciding whether a particular observation is sufficient.

## Mac qualification

The focused run passed 189 checks. The subsequent native integration run passed 310 checks across
13 files. The independently packed and installed SDK passed all 22 package checks, including
NodeNext declarations and a genuine Node test run whose output is replayed under an empty PATH.
Those final runs reported no failures, cancellations or skipped tests.

Source validation passed 3,886 checks across 191 skills. VS Code typechecking, the unchanged
2,011-site process/Git ownership audit and all 13 existing bundle budgets passed. No ceiling was
raised. The optional SDK retains 51 operations and builds from 143 source modules, emitting
1,431,195 JavaScript bytes.

The package consumer refuses filesystem, command, configuration and Git imports from the report
entry. Source guards preserve the pure graph and narrow native binding. Native integration covers
execution evidence, local report replay, test recovery, framework identities, command pins and
compatibility imports. These are parser and boundary checks, not complete application execution.

## Remaining integration

Portable phase execution still needs authenticated pinned commands, owned process supervision,
fresh source/configuration bindings and durably accepted test evidence. Publication and immutable
submission packets must bind that actual evidence before an application Story can complete through
the namespace engine. Existing-project migration, writer cutover and final distribution/performance
qualification remain required. Phases 5, 7, 8 and 9 stay open.

All qualification here used isolated Mac fixtures. No Windows or hosted CI, live provider,
product installation, real Story mutation, migration, merge or push ran.
