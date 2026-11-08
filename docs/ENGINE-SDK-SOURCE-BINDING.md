# Explicit repository source observations

`source.bind` is an opt-in registered Engine v1 operation. It records actual source observations
for selected repositories in an enrolled namespace Story. SGOS reads the explicitly supplied
checkouts, the kernel owns admission and state meaning, the SDK coordinates the operation, and
SDA retains its manifests and conditional acceptance. No CLI, Git executable, provider, ambient
workspace or default checkout is discovered by this host.

## Application binding

```js
import { createFilesystemSourceUnit } from '@singularity-flow/engine-sdk/sources/filesystem';
import { createNamespaceSourceEngine } from '@singularity-flow/engine-sdk/hosts/namespace-source';

const app = await createFilesystemSourceUnit({
  root: absoluteCheckoutDirectory,
  id: 'app-checkout', projectId, repositoryId: 'app',
  excludePaths: ['node_modules', 'dist']
});
const engine = createNamespaceSourceEngine({
  records, content, scope: { projectId }, workId, authority,
  sources: [app], access: applicationSourceAccess, clock: applicationClock
});
const result = await engine.run('source.bind', {
  operationId: 'bind-app-1', workId,
  expectedRevision: currentStoryRevision,
  repositories: ['app'],
  reason: 'Record the checkout selected for this Story'
});
```

Bind the same explicit stores, project, Story and authority as creation. The access port receives
`{ projectId, workId, operation: 'source.bind', signal }` and returns authenticated project,
principal, actor-kind, identity and permission facts. `source.bind` permission is checked before
preparation and again immediately before conditional acceptance. Either a human or service may
record an observation; this cannot stand in for human approval or a visual witness.

Use the actual canonical head revision. A creation or source-binding result provides `revision`;
`phase.review` exposes the current read revision as `manifest.observedRevision`. A content digest,
transaction revision, Git commit or invented readiness flag is not a substitute. Repository IDs
are distinct logical IDs, sorted by the operation; physical roots never enter operation inputs.

## Observation and retention

The filesystem unit reads ordinary files and hashes their actual bytes. Its portable manifest
retains relative paths, SHA-256, byte lengths and executable bits, along with the explicit logical
unit, project, repository, provider and selection. File bodies, absolute checkout paths, mtimes
and inode identities are not stored in the manifest. The manifest itself is immutable evidence
content, verified by its real byte digest and length. This does not archive source code.

The default exclusions are `.git` and `.singularity-flow`. Dependency and build directories need
explicit exclusions; `.gitignore` is an ordinary captured file. Keep application stores outside
the selected tree or under an explicitly excluded path. Symlinks and unsupported file types
produce explicit errors. File, traversal, total-byte and manifest bounds refuse oversized
observations without truncating them. Configurable deadlines are bounded by five minutes and
report stage, relative path and elapsed deadline separately from the underlying unknown I/O cause.
Timeout or cancellation rejects the capture; an outstanding OS read may finish its cleanup later.

Metadata observations before and after hashing detect concurrent changes and root replacement.
The SDK captures again before final acceptance, verifies retained bytes, refreshes permission and
conditionally commits against the original lifecycle and authority revisions. This is an
observation, not an atomic freeze of the filesystem: subsequent edits need their own validation.

The accepted state keeps both the current binding and each repository's first retained observation
in `sourceBindings.origins`. Takeover or a later explicit binding preserves those origins and all
older receipts. It neither silently replaces the initial baseline nor requires scanning source
history. Phase policy still needs to decide which later changes are in scope.

## Retry, takeover and real errors

A prepared intent pins the original actor, timestamp, store IDs, authority, Story revision,
repository descriptors and actual source manifests. Concurrent identical calls reconcile to one
accepted transition. Changed inputs under the same operation ID, revoked permission, another
actor, a moved head, fencing or missing retained bytes remain explicit errors.

Retry the same inputs and operation ID after an unknown outcome. An accepted retry acknowledges
its original receipt without recapturing today's checkout or claiming new authorization. It can
be acknowledged from another process with `sources: []`. An unaccepted intent still requires
the matching source descriptors, unchanged files, original actor and fresh permission. If source
bytes changed, preserve the intent and use a new operation ID to bind the reviewed new baseline
against the current Story revision. The Story is not recreated.

Another laptop can supply a different explicit checkout through a new binding. It retains the
same Story and immutable previous observations; physical checkout paths remain machine private.
Actual missing-file and permission errors keep their identity and details. Source-unit absence,
changed source, unsupported schemas, cancellation, deadlines, corruption and unknown storage
outcomes are not converted to success or an inferred DNS/authentication diagnosis.

## Boundary and qualification

Binding updates canonical source metadata and one lifecycle history event. It does not edit source
files, open a generation, run tests, record review, approve, publish or advance a phase. Execution
remains explicitly `unbound`. Existing native Git phase contracts and installed authority are
unchanged. In particular, a filesystem digest must not be presented as the real Git commit
required by the existing `phase.begin` contract.

The Mac qualification exercises actual filesystem captures and filesystem, SQLite and
application-backed namespace stores. It covers concurrent requests, interrupted acknowledgement,
permission and actor changes, authority fencing, multi-repository selection, drift, takeover,
retained origins, real errors and source-contract bounds. An actual packed SDK runs enrollment,
configuration approval, Story creation and source binding in an external consumer; a separate
empty-PATH process acknowledges the accepted observation after source bytes change. NodeNext
declarations cover the new public entries and reject path/readiness substitutes in requests.

On macOS arm64 with Node 26.12.0, the final eleven-file run passed 281 tests in 297.9 seconds,
with no failures, cancellations or skips. Broader qualification exercised 784 tests across 48
files; 783 passed and one exposed a concurrent SQLite initialization race. The SDA opening path
was repaired without retrying application transactions. Its 22-test durability recheck and the
final 281-test run passed, including deterministic contention, exhaustion and permission cases.
The broad suite was not rerun in full after that targeted repair; these counts overlap.

Source validation passed 3,795 checks across 191 skills, three agents and two extensions. VS Code
typechecking, the unchanged 2,011-site Git ownership audit and all 13 rebuilt bundle budgets
passed. The gateway remains 851 modules / 6,851,105 bytes and the extension 152 modules /
1,289,033 bytes, within their existing ceilings. No Windows, hosted CI or live model runs were used.

Portable preparation, local drafts, phase execution and a complete cross-agent Story remain
Phase 7 work. Remaining native-rule extraction, verified migration, old-writer fencing and final
cleanup/distribution/performance qualification retain their Phase 5, 8 and 9 scope.
