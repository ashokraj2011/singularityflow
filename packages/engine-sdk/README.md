# SFlow Engine SDK (preview)

Embed the versioned engine in a Node host such as a build runner or application. This package is
an ESM workspace preview. It has no installation hooks, global Node replacement, CLI discovery,
provider invocation or runtime npm dependencies. It is not published to a registry by this build.

From the SFlow source checkout:

```sh
npm ci
npm run engine-sdk:build
npm pack --workspace @singularity-flow/engine-sdk --ignore-scripts
```

Install the resulting local archive in the host project with `npm install /path/to/archive.tgz`.
The archive contains the runtime, declarations and source inventory; it needs no SFlow checkout.
The ordinary CLI and extension installers and their existing package exports remain unchanged.

```js
import { createEngine, ENGINE_OPERATIONS } from '@singularity-flow/engine-sdk';

// Bind the operation ports explicitly. A port is a trusted integration, not user request data.
const engine = createEngine({ ports: applicationPorts });
const result = await engine.run('phase.review', { workId, phaseId });
```

`engine.run(operation, inputs)` is the public vocabulary. Helpers such as `publishPhase` enter
the same registry. Unknown operations, undeclared inputs and unavailable ports fail explicitly.
Declarations derive operation names, input keys and helpers from that executable registry. They
describe structural inputs; runtime still enforces context, exact review binding and authority.
Construction does not give a caller permission to approve: trusted ports must bind the actor,
project and current facts and preserve the applicable human approval policy.

The core and `errors` exports are pure. Import storage explicitly when it is needed:

```js
import { createFilesystemNamespaceStore } from '@singularity-flow/engine-sdk/storage/filesystem';
const store = await createFilesystemNamespaceStore({
  root: absoluteApplicationDataDirectory, create: true, binding: { kind: 'shared' }
});
const result = await store.read({ projectId: 'payments' }, 'state', 'stories/example');
```

- `namespace`: draft record/transaction contracts and validation, with no selected backend.
- `storage/filesystem`: opt-in durable local filesystem namespace store.
- `storage/sqlite`: opt-in native SQLite namespace store; close it when the host is done.
- `storage/application`: bind an application's qualified atomic journal port.
- `storage/journal`: versioned journal-port constant and shared pure transaction reducer.
- `errors`: the same error constructor used by the engine and every bundled storage entry.

Node 22 or later is required for the core and filesystem/application backends. SQLite is loaded
only when its factory is called and requires the native capabilities qualified on managed Node
26.12.0. An incompatible SQLite runtime fails explicitly; there is no hidden package download.

Storage uses `sda-namespace-store/draft-1`; the engine vocabulary is `sflow-engine/v1`. The package
is `1.0.0-alpha.0`, not a product 1.0 release or a stable storage-contract announcement. Its
`private` flag prevents accidental registry publication while local packing/installing remains
supported. A versioned engine name, shape or outcome change needs an explicit contract version.

This delivery makes the existing explicit-port engine and namespace stores installable. It does
not yet provide portable lifecycle ports for a complete Story. Existing Git lifecycle/configuration
authority is unchanged; this package neither migrates an installed project nor automatically
selects a namespace store. Full cross-agent Story execution, verified authority cutover and final
distribution/performance qualification remain migration gates.
