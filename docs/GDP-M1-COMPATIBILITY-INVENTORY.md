# GDP-M1 compatibility inventory and projection boundary

**Milestone:** GDP-M1

**Status:** implemented as a disabled, read-only compatibility layer

**Baseline:** `main@5fa71dbf7d4a6ed452d08027915c491909f7706f`

**Durable GDP records:** none

GDP-M1 establishes how current Singularity Flow work can be described by the corrected GDP
vocabulary without changing how that work behaves. It does not create a Change Passport, evaluate
proof, select a delivery mode, migrate state, add a command, or expose a product surface.

The source record remains the sole authority. The projection is a transient diagnostic value over
an already-read record. It never reads Git or the filesystem and never calls a model, AST, or World
Model runtime.

## Authority inventory

| Existing system | Authoritative state | Execution authority | GDP-M1 interpretation |
|---|---|---|---|
| Story Workflow | `story-workflow` through `src/state.mjs` | creation-pinned phase workflow | legacy Workflow-mode observation |
| Developer Auto | machine-local `auto-flight-state` plus Story workflow | Auto v2 and current Story phase | legacy Workflow-mode observation with Auto pace |
| Ad Hoc | machine-local `adhoc-session` and landing receipt | Ad Hoc session/landing policy | legacy Outcome-like observation; not native GDP Outcome authority |
| SGOS | `gvm-process`, pinned Program, binding, and record index | GVM v1 process runtime | legacy Workflow or Outcome-like observation based on its authority binding |

Cross-cutting approval, evidence, Candidate, proof, and publication owners are listed in
[`compatibility-inventory.json`](./contracts/gdp/compatibility-inventory.json). GDP-M1 does not
supersede any of them:

- approvals remain decisions of the current approval authority and Story/SGOS runtime;
- evidence keeps its original type and assurance ceiling;
- Candidate hashes are observed only when a legacy record explicitly contains one;
- pending publication remains owned by the existing publication unit of work and recovery marker;
- GDP Proof Subject, Proof Summary, and Change Passport are explicitly `unavailable`.

## Projection contract

[`compatibility-projection.mjs`](../src/delivery-modes/compatibility-projection.mjs) accepts one of
four already-verified record kinds and optional already-verified publication recovery metadata. Its
closed output is described by
[`gdp-compatibility-projection.schema.json`](../schemas/gdp-compatibility-projection.schema.json).

Every result states:

- `classification: legacy` and `selectionStatus: legacy`;
- the existing runtime that still owns execution;
- a conservative normalized lifecycle state;
- whether Candidate or World Model identity was actually present;
- GDP proof and Passport availability as `unavailable`;
- why the legacy reader is `sunset-blocked`;
- that the projection performs no write and grants no authority.

The projection hash addresses only this bounded transient view. It is not a Candidate, Proof
Subject, Passport, approval, publication receipt, or MIG-managed durable identity.

## Lifecycle corpus

The M1 fixture corpus includes:

1. active Story workflow;
2. completed and published Story workflow;
3. reopened Story workflow;
4. cancelled Ad Hoc session;
5. interrupted Auto flight requiring recovery;
6. partially published Story workflow with a pending recovery marker;
7. running SGOS process.

The tests also prove that projection is deterministic, deep-frozen, and non-mutating; missing AST
and World Model data remain non-blocking; no feature default is enabled; no CLI or VS Code surface
imports the projection; and no GDP durable family is registered with MIG.

## Upgrade, downgrade, and packaging behavior

GDP-M1 adds only a dormant source module, schema, fixture corpus, tests, and documentation. Because
no existing reader imports it and it writes no record:

- upgrading leaves existing bytes and behavior unchanged;
- downgrading needs no state conversion;
- npm and VSIX packaging can include the module without activating it;
- Windows, macOS, and Linux receive identical deterministic output for identical input;
- uninstalling or disabling the future projection reader is the complete rollback.

## Feature defaults

All GDP switches are frozen off in the module and pinned by the machine-readable inventory:

- compatibility projection product surface;
- shadow Change Passport;
- proof observation;
- Outcome mode;
- Workflow Passport;
- automatic enrollment;
- enforcement.

M2 may consume the projection behind a new explicit shadow-only boundary. Until then, the M1
module is a tested compatibility contract, not a user-facing feature.
