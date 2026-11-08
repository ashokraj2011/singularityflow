# Namespace-backed Story creation

`story.create` is a registered Engine v1 operation. An application can enroll a project, approve
its complete configuration, create a Story and reopen its source in another Node process, using
explicit namespace and immutable-content ports. No Git executable, CLI installation, checkout,
provider or ambient workspace is selected by this host.

## Application binding

Import `createNamespaceStoryEngine` from `@singularity-flow/engine-sdk/hosts/namespace-story`.
Bind `records`, `content`, `scope`, `workId`, `authority`, `access` and `clock` explicitly. The
project must already be enrolled under that authority and those store IDs. Optional local content
is used only by document reads; it cannot supply a shared Story source.

The access port receives `{ projectId, workId, operation: 'story.create', signal }` and returns
authenticated `principalId`, `actorKind`, `permissions` and `identity` facts. Identity includes a
name and an email or login. Permission `story.create` is checked before preparation and again
after content verification, immediately before the final authority observation and conditional
transaction. A service may create work; that does not authorize a human review or self-enroll
the service into reviewer groups.

```js
const created = await engine.run('story.create', {
  operationId: 'create-converter-1',
  workId: 'converter-1',
  title: 'Convert decimal and hexadecimal values',
  workTypeId: 'feature',
  configurationId: reviewedConfiguration.operationId,
  source: retainedSourceReference
});
const source = await engine.run('document.read', { reference: created.source });
```

The source is a shared `state` or `evidence` content reference, limited to 1 MiB of nonempty UTF-8
text without NUL bytes. Its exact bytes and hash are checked. A path, machine-local attachment,
branch name, caller identity, policy override or claimed readiness result is not a creation input.
Story IDs obey the approved ID pattern, without becoming checkout branch names.

## Pinned meaning and initial state

`configurationId` identifies an actual immutable configuration approval, not a mutable alias for
the latest configuration. The shared configuration codec checks the prepared transaction,
acceptance receipt, immutable decision, configuration version and compiled bytes. A later
configuration approval cannot reinterpret a prepared or existing Story.

Creation uses the approved effective workflow and the shared native phase initializer. Workflow
topology, planned-claim admission and approval attainability remain rules over that contract.
Each configured phase, authority, artifact contract, source boundary, tool declaration and
dependency remains pinned. Existing native Git creation uses the same initializer and private
approval-pin enrollment rule, retaining its original records, clock order and public behavior.

The initial phase is in progress at generation zero. No artifacts, tests, provider execution,
human review or approval are invented. Repository execution is explicitly `unbound`; later
production lifecycle ports must obtain the required repository and execution observations.
Creation does not claim the complete headless Story runtime is finished.

## Persistence, retries and reads

A prepared intent pins the original principal, identity, timestamp, source, effective workflow,
immutable configuration version and authority revision. The final transaction conditionally writes
the canonical lifecycle head, immutable genesis, read locator and immutable creation manifest,
with one `engine.story-created` event. Existing heads, genesis records and locators must be
absent. Genesis prevents accidentally reusing an ID after its mutable head is lost.

The new `namespace-story-lifecycle-read-head` family points to the canonical lifecycle head.
Readers derive their view from the current accepted lifecycle body and perform a final binding
check. They do not maintain a second authoritative snapshot. Existing v1 read heads, content
identities and diagnostics remain readable with their original meaning.

Retry the same `story.create` inputs and operation ID after a lost acknowledgement. A committed
retry acknowledges its original receipt without obtaining new permission, changing its timestamp
or creating another Story. Concurrent identical requests share one result. A prepared retry
requires the original actor and current permission. Changed intent, fenced authority, missing or
changed bytes, unsupported records, permission errors and unknown transaction outcomes remain
explicit errors; the host never silently switches storage or creates replacement work.

## Qualification and remaining work

Qualification covers actual filesystem, SQLite and application-backed stores, empty-store
enrollment and approval, creation, canonical reads, concurrent requests, lost preparation and
acceptance acknowledgements, permission and identity changes, authority fencing, ID reuse,
cancellation, source failures, later configuration updates and all 18 shipped workflow contracts.
The installed npm archive is also exercised in independent processes with an empty `PATH`, and
its NodeNext declarations admit the new operation while rejecting paths and branch inputs.

On macOS arm64 with Node 26.12.0, the final six-file setup, registry and installed-package run
passed 149 tests in 47.8 seconds, without failures, cancellations or skips. It includes deterministic
interleavings where enrollment, configuration approval and creation finish between another
invocation's observations. A five-file creation, initialization, installed-package, migration-golden
and architecture run passed 111 tests in 57.3 seconds. A separate native-state and migration
recheck passed 80 tests in 103.8 seconds. These suites overlap and are not additive. Broader qualification exercised 731 tests
across 45 files, including native Git Story creation, all three namespace adapters and their
durability/concurrency checks. Its missing new-family golden and two stale CLI-only rejection
guards were corrected and passed the follow-up checks; existing golden bodies were preserved.

Source validation passed 3,785 checks across 191 skills, three agents and two extensions. The Git
audit retained 2,011 registered production sites. VS Code typechecking and all 13 rebuilt bundle
budgets passed, with no raised ceiling. No Windows, hosted CI or live model qualification ran.

Production namespace lifecycle policy ports and a complete cross-agent Story remain Phase 7
work. Existing-project export, verified authority cutover, old-writer fencing, obsolete-access
removal and final distribution/performance qualification remain Phases 8 and 9. This opt-in host
does not install, migrate or alter an existing Git-backed project.
