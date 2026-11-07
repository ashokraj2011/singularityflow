# Git compatibility adapter

Phase 3 adds an internal composition entry at `src/sda/git-compatibility-adapter.mjs`. A trusted host
binds a stable project ID to an explicit absolute repository checkout, then opens a native port by
logical namespace and role. Constructing the binding does no I/O. Owners load when their port or
operation is first used; opening configuration alone does not load its readers or writers.

This is the `sda-git-compatibility/draft-1` profile, separate from the generic
[`sda-namespace-store/draft-1`](NAMESPACE-STORAGE-CONTRACT.md) protocol. It adapts existing installed
authorities without migrating records, inventing new transaction receipts or changing old hashes.

## Authority mapping

| Logical namespace / role | Existing owner | Preserved behavior |
|---|---|---|
| `state` / `lifecycle` | `sda/story-branch-authority.mjs` | Subject branch observation, conditional publication, pending recovery and stage-aware cancellation |
| `state` / `proof` | `sda/git-ledger-adapter.mjs` | Existing state-branch event log, operation-key deduplication, snapshot pages and digest verification |
| `config` / `configuration` | `approved-configuration-reader.mjs`, `configuration-proposal.mjs` | Exact reads, immutable configuration commits, reviewed proposals, confirmed activation and retained transaction reconciliation |

The logical `state` namespace does not mean that lifecycle records move onto the Git `state`
branch. [ADR 0018](adr/0018-sda-lifecycle-authority-options.md) remains in force: the subject branch
owns lifecycle state, the ledger holds proof/projections, and `sflow/config` owns approved policy.
The native lifecycle and proof ports retain their exact SDA v1 descriptors and implementations.
The facade itself is ineligible for selection as either authority or a generic namespace store.

## Internal API

```js
import { createGitCompatibilityAdapter } from '../src/sda/git-compatibility-adapter.mjs';

const scope = { projectId: 'project-a' };
const storage = createGitCompatibilityAdapter({
  root: '/workspace/repository', // trusted composition supplies the verified checkout
  scope,
  proof: { config: approvedLedgerConfig } // optional; no ledger is enabled implicitly
});

const lifecycle = await storage.open(scope, { namespace: 'state', role: 'lifecycle' });
const proof = await storage.open(scope, { namespace: 'state', role: 'proof' });
const config = await storage.open(scope, { namespace: 'config', role: 'configuration' });
```

`open(scope, address, {signal}?)` validates the project and supported namespace/role before loading
an owner. It returns a cached, root-bound native port. A mismatched scope, disabled proof port,
unknown role or unsupported namespace is refused without a storage operation. Binding options are
captured so caller mutation cannot redirect a later-opened proof port. A project scope is a trusted
composition binding check; it does not authenticate a caller or establish a multi-tenant ACL. Hosts
must not bind different logical projects to the same physical authority as an isolation mechanism.

Lifecycle retains `observe(target, options?)`, `publish(transition, options?)` and
`pending(subject, options?)`. Proof retains `append(event, options?)`, `page(query?, options?)` and
`verify(options?)`. Their v1 arguments, opaque revisions, results, refusal codes, error causes,
pending records and recovery routes pass through without projection or reclassification. No
transport is retried by the facade. Native retry and reconciliation policies still apply.

The configuration port delegates these operations:

| Compatibility method | Existing operation |
|---|---|
| `withRead(callback, options?)` | `withApprovedConfigurationRead` |
| `withCommitRead(binding, callback, options?)` | `withRepositoryConfigurationCommitRead` |
| `propose(change, options?)` | `proposeConfigurationChange` |
| `listProposals(options?)` | `listWorkflowConfigurationProposals` |
| `inspectProposal(branch, options?)` | `inspectWorkflowConfigurationProposal` |
| `activateProposal(branch, options?)` | `activateWorkflowConfigurationProposal` |
| `transactions(options?)` | `configurationTransactions` |
| `reconcileTransaction(id, options?)` | `reconcileConfigurationTransaction` |

Configuration arguments and results are the existing ones. The optional `signal` is checked before
owner loading and before invocation; running configuration operations retain their current native
completion/recovery behavior. Lifecycle keeps its publication stage boundaries; proof keeps its
pre-start cancellation check. An in-flight push never turns an unknown or accepted effect into
“cancelled.”

`withRead` keeps the existing working-tree/pinned-Story default. Fresh approved-policy reads use the
owner's explicit authority options; the adapter never silently upgrades an active Story's pin.
`withCommitRead` uses the exact supplied commit. Configuration mutations still create proposals;
activation still checks the exact reviewed commit, identity, protection acknowledgement, semantic
conflicts, leases and receipts. A local transaction journal is recovery data, never authority.

## Limits and remaining coupling

This bridge intentionally has no arbitrary `put`, `delete` or generic `transact` API. Lifecycle and
configuration have different atomic write protocols. Declaring one raw transaction across them
would either bypass review or require a new record layout and authority decision. Its descriptor
therefore declares `rawTransactions: false` and `crossNamespaceAtomicity: false`; it does not claim
the generic record-store conformance suite. Both native ports run their existing v1 conformance
suites through this entry, while configuration gets real Git review/activation integration tests.

Standalone `evidence`, `runtime` and `local` ports are unsupported. Evidence continues to travel in
the existing lifecycle publication and immutable delivery bindings. SGOS operational records and
machine-private attachments keep their current owners. There is no fallback into another namespace.

Native transition descriptions still contain source branches and trusted preparation callbacks.
Configuration reads and proposals still use trusted callbacks. These are internal compatibility
ports, not model-callable or serializable SDK inputs, and must remain behind registered domain
operations. Phase 4 extracts publication coordination and its rules behind the SDK with explicit
CLI JSON parity. Later backend and migration phases can implement generic namespaced storage and
an explicit authority cutover; this bridge does neither.

Architecture tests keep the contract pure, restrict all namespace/compatibility imports to this
boundary, and allow only the existing concrete owner imports in the adapter. Existing production
CLI, MCP, VS Code and Copilot routes are unchanged; no root package export selects this draft.

## Local qualification

The targeted suites use isolated machine state and temporary repositories with local bare remotes.
They do not alter a real Story, installation, workspace or remote service. Run them on this Mac:

```sh
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedTestEnvironment } from './scripts/test-machine-state.mjs';
const machine = mkdtempSync(path.join(os.tmpdir(), 'sflow-git-compat-tests-'));
try {
  execFileSync(process.execPath, ['--test', '--test-concurrency=2',
    'test/sda-git-compatibility-contract.test.mjs',
    'test/sda-git-compatibility-conformance.test.mjs',
    'test/sda-git-compatibility-configuration.test.mjs',
    'test/sda-conformance.test.mjs', 'test/sda-lifecycle-conformance.test.mjs',
    'test/architecture-boundaries.test.mjs'], {
    env: isolatedTestEnvironment(machine), stdio: 'inherit'
  });
} finally {
  rmSync(machine, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
JS
```

The migration plan records the completed qualification. Windows, hosted CI and live provider runs
are excluded from this phase.

### Current-branch requalification

The Phase 3 bridge was rechecked on macOS 26.7.2 with Node 26.12.0 after the later SDK extractions.
All 187 focused tests across 16 files passed, with no failures, cancellations or skips. The run
covered the three compatibility suites, unchanged native lifecycle/proof conformance, namespace
contracts/conformance, final publication binding, configuration proposals, foundation ownership,
adapter names, architecture boundaries, lazy startup and SGOS contracts.

An additional regression verifies that both configuration readers propagate the exact frozen
native callback error, its cause and its recovery details. The callback executes once; neither
the checkout head nor dirty-file status changes. This adds no retry or alternate recovery policy.

Source validation passed 3,633 checks. VS Code typechecking and npm dry-run packaging passed; both
adapter modules and this document are included, while test fixtures are excluded. The verification
used temporary local Git remotes and isolated machine state. No Windows, hosted CI, live provider,
installation, workspace or real Story operation was run.
