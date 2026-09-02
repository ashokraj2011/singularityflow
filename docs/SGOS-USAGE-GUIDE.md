# How to use SGOS

This guide explains when to use the SingularityFlow Governed Execution Operating System (SGOS),
how to take an execution from confirmed intent to verified completion, and how to share Capability
Pack authority between machines. For the complete contracts and current implementation boundary,
read the [SGOS technical guide](SGOS.md).

## Choose the right workflow

SGOS is additive. It does not replace the normal Story lifecycle, Developer Auto Mode, Git, or the
World Model.

| Need | Use |
|---|---|
| Implement ordinary product work through phases | The normal `/sf-start`, `/sf-next`, `/sf-submit`, and approval flow |
| Let SFlow advance eligible Story phases automatically | `/sf-auto` and the normal Story lifecycle |
| Define a reusable, finite, independently verifiable execution procedure | An explicit SGOS Intent, Program, and Process |
| Inspect a Story from a deterministic execution program | A Story-bound SGOS Process |
| Share reviewed Capability Pack authority with another clone or laptop | The Git-trusted Authority Store publish/sync flow |
| Give a model unrestricted repository or shell authority | Not supported by the installed SGOS profile |

For ordinary development, keep using the Story workflow. Supported lifecycle publishers use the
SGOS Candidate boundary automatically before creating governed commits; developers do not need to
create a second Process for every Story.

Use the explicit SGOS flow when the procedure itself must be reviewed, content-addressed,
repeatable, bounded, recoverable, and supported by immutable evidence.

## Mental model

```text
human intent
  -> Intent Envelope
  -> exact human confirmation
  -> Intent IR
  -> finite Workflow IR
  -> exact ratification
  -> deterministic Program
  -> Program approval on sflow/config
  -> local resumable Process
  -> ready task or compatible task wave
  -> Candidate Snapshot
  -> independent verification
  -> immutable Task Receipt and checkpoint
```

The important rule is: output is not success. A task succeeds only after its exact Candidate and
required evidence pass verification and SGOS publishes an immutable Task Receipt.

The runtime Candidate Snapshot is task evidence. It is distinct from the Git-backed lifecycle
Candidate that automatically freezes and verifies a prospective governed commit. Users normally do
not manage the lifecycle Candidate directly.

## Where SGOS state lives

| State | Authoritative location | Meaning |
|---|---|---|
| Story phases, artifacts, approvals, and source | Governed application/Story Git branches | Normal delivery authority |
| Policies, authority groups, Program approvals, Pack publisher keys | Approved `sflow/config` | Configuration and review authority |
| Shared Git-trusted Authority Store projection | Configured state branch | Transported public Pack lineage; not live execution state |
| Installed Authority Store and active Processes | Repository Git-common private sidecar | Local runtime state used by admission and recovery |
| Candidate retention and publication recovery | Protected Git refs and local recovery records | Exact bytes retained across interrupted publication |
| VS Code boards, graphs, and tables | Projection only | A view of authority; never a second authority source |

Do not manually edit Git-common Process or Authority Store files. Do not treat the state branch as
an active Process database. A new laptop receives Pack authority only after an explicit
`authority-store sync`; active Process state is not silently moved with it.

## Prerequisites

Before authoring an explicit SGOS Program:

1. Work inside the selected initialized repository, not from the home directory.
2. Commit the SGOS input JSON files to the repository before relying on them as reviewed inputs.
3. Make sure the repository can read its approved `sflow/config` authority.
4. Configure the required approval groups in approved `workflow.yml`.
5. Use only registered operations, execution units, Devices, and Capability Packs.
6. Decide whether the Process subject is an existing Story or the repository itself.
7. Use `--json` when another tool must consume the result without parsing terminal prose.

The installed SGOS profile is intentionally narrow. Its executable surface is the intrinsic
boundaries, two reviewed read-only kernel pairs, the no-effect deterministic translator, the
proposal-only no-tools Copilot unit, the read-only filesystem Device, and the fixture-only
`sandbox-cas` proof Device. It is not a general code-writing or unrestricted shell engine. Unknown
adapters, unsafe overlapping writes, unbounded expansion, missing verification, unsupported
external effects, and stale authority fail closed.

## Normal Story usage

For day-to-day product work, use the existing Copilot and VS Code workflow:

```text
/sf-start
/sf-next
/sf-progress
/sf-submit
/sf-approve
```

In VS Code, use **My Work** for the active Story and **Lifecycle** for phase progress. Candidate
verification and exact Git publication occur underneath supported lifecycle commands. The SGOS
Process commands below are not required merely to write code or complete a Story phase.

## Author and run an explicit SGOS Program

The following ceremony is for a platform author or operator deliberately creating reusable
governed execution. Run `singularity-flow <command> --help` before a mutation to see the complete
contract for the installed build.

### 1. Capture and confirm intent

Capture creates a candidate envelope. It does not grant authority and does not invoke a model.

```bash
singularity-flow intent capture \
  "Produce a verified migration report" \
  --out intent-envelope.json \
  --json
```

Author a complete explicit `intent-answers.json` that satisfies the Intent answer contract. Capture
does not generate or answer open questions, and packet creation does not complete missing facts; it
only binds the supplied answers into the exact packet a human will review:

```bash
singularity-flow intent packet intent-envelope.json \
  --answers intent-answers.json \
  --out intent-packet.json \
  --json
```

Review the packet. Confirm only the digest printed by that invocation:

```bash
singularity-flow intent confirm intent-envelope.json \
  --answers intent-answers.json \
  --confirm sha256:<INTENT-PACKET-DIGEST> \
  --confirmed-at <RFC3339-TIMESTAMP> \
  --out intent-ir.json \
  --json
```

The confirming identity comes from current Git identity and approved product authority. The default
group is `product-approvers`; approved platform-authority policy may replace it. An identity flag
cannot grant permission.

### 2. Create and ratify a finite workflow

Prepare the strict repository files `policy.json`, `workflow-declaration.json`, and `registry.json`.
The declaration must define finite tasks, dependencies, resources, evidence, verification, human
authority, and recovery policy.

```bash
singularity-flow intent workflow intent-ir.json \
  --policy policy.json \
  --declaration workflow-declaration.json \
  --out workflow-ir.json \
  --json
```

Preview the complete ratification packet:

```bash
singularity-flow intent ratification-packet intent-ir.json \
  --workflow workflow-ir.json \
  --policy policy.json \
  --registry registry.json \
  --storage-profile-sha256 sha256:<STORAGE-PROFILE-DIGEST> \
  --out ratification-packet.json \
  --json
```

After review, ratify the exact packet:

```bash
singularity-flow intent ratify intent-ir.json \
  --workflow workflow-ir.json \
  --policy policy.json \
  --registry registry.json \
  --storage-profile-sha256 sha256:<STORAGE-PROFILE-DIGEST> \
  --confirm sha256:<RATIFICATION-PACKET-DIGEST> \
  --decided-at <RFC3339-TIMESTAMP> \
  --out ratification.json \
  --json
```

Workflow ratification uses the current Git identity and the approved architecture authority by
default; an application-branch edit cannot change that authority.

Use the exact same `--coverage coverage.json` on both ratification commands unless
`workflow-ir.json` already contains `spec.intentWorkflowMap`. Coverage is required when neither
source supplies that mapping.

### 3. Compile, inspect, and simulate

Compilation is deterministic and model-free:

```bash
singularity-flow intent compile intent-ir.json \
  --workflow workflow-ir.json \
  --ratification ratification.json \
  --policy policy.json \
  --registry registry.json \
  --out program.json \
  --json

singularity-flow program validate program.json --json
singularity-flow program explain program.json --json
singularity-flow program simulate program.json --json
```

Simulation computes ordering, ready tasks, human stops, unavailable operations, and evidence needs.
It never starts a Process or executes a Device.

Keep the complete file written by `intent compile`. For a non-core signed Capability Pack, that
compile result carries both the Program and its exact `capabilityPackAuthorities`; extracting and
approving only the nested bare Program is intentionally refused.

### 4. Approve the Program through configuration authority

First preview the Program-authority proposal:

```bash
singularity-flow program approve program.json --json
```

Then confirm only its current proposal digest:

```bash
singularity-flow program approve program.json \
  --confirm sha256:<PROGRAM-AUTHORITY-PROPOSAL> \
  --approved-at <RFC3339-TIMESTAMP> \
  --json
```

This creates a normal configuration review proposal. It does not approve itself, merge the review
branch, or change the application branch. Review and merge it through the existing `sflow/config`
process. Execution is admitted only when the approved authority contains:

```text
singularity/sgos/program-authorities/<PROGRAM-DIGEST-WITHOUT-SHA256-PREFIX>.json
```

Program approval uses `architecture-reviewers` by default. Organizations may change operation
groups only through approved `sgos.platformAuthorities` configuration.

### 5. Start a bound Process

After the Program authority is approved, start one Process and retain its Process ID, revision, and
checkpoint digest:

```bash
singularity-flow process start program.json \
  --intent intent-ir.json \
  --workflow workflow-ir.json \
  --ratification ratification.json \
  --policy policy.json \
  --registry registry.json \
  --subject <WORK-ID> \
  --subject-kind story \
  --json
```

For repository-scoped execution, use a repository subject and `--subject-kind repository`. A Story
subject must already exist at the exact baseline; SGOS pins its path, record digest, normalized
state digest, and Git revision before any task can run.

As an alternative, platform tooling may supply one preassembled `--compiler-request
compiler-request.json` containing those exact five inputs and their authority bindings. SGOS does
not invent that request file.

### 6. Inspect and execute

```bash
singularity-flow process list --json
singularity-flow process status <PROCESS-ID> --json
singularity-flow process graph <PROCESS-ID> --json
singularity-flow process fsck <PROCESS-ID> --json
```

Execute one ready boundary:

```bash
singularity-flow process step <PROCESS-ID> \
  --expected-revision <CURRENT-REVISION> \
  --json
```

Or execute one bounded wave of compatible tasks:

```bash
singularity-flow process run <PROCESS-ID> \
  --maximum-parallel 4 \
  --expected-revision <CURRENT-REVISION> \
  --json
```

`process run` executes one ready wave, not the complete Process. Its parallelism is limited by the
installed ceiling (currently eight), the lower caller ceiling, and resource conflicts. Read fresh
status and repeat with the new expected revision when another wave is ready.

Inspect why a task is or is not verified:

```bash
singularity-flow task evidence <PROCESS-ID> <TASK-ID> --json
```

Always take the next expected revision from a fresh status response. Do not reuse a revision or
confirmation digest after Process state changes.

## Model-backed tasks

The compiler, scheduler, simulation, intrinsic boundaries, policy checks, and evidence validation
are model-free. A Program can use the installed proposal-only Copilot Execution Unit only when the
operator explicitly permits it:

```bash
singularity-flow process step <PROCESS-ID> \
  --expected-revision <CURRENT-REVISION> \
  --allow-model \
  --json
```

The model receives no terminal authority. Its output remains a proposal and must flow through an
independent material verification task. Global `--no-model` still refuses model execution.

## Human Requests

When a task needs judgment, SGOS creates a typed Human Request instead of guessing. Inspect the
current request first:

```bash
singularity-flow request show <REQUEST-ID> \
  --process <PROCESS-ID> \
  --json
```

An approval response binds the exact request, Process revision, Process digest, and current approved
reviewer membership:

```bash
singularity-flow request respond <REQUEST-ID> \
  --process <PROCESS-ID> \
  --decision approved \
  --confirm sha256:<REQUEST-DIGEST> \
  --expected-revision <CURRENT-REVISION> \
  --expected-process-sha256 sha256:<PROCESS-DIGEST> \
  --json
```

Use `--option <EXACT-OPTION-ID>` for a declared choice, or `--decision provided --input-json
'<JSON>'` for non-sensitive structured input. `--sensitive-handle` accepts the request schema's
non-secret handle JSON; it never accepts the underlying credential or a plain secret string.

The VS Code **Singularity Flow: Open Command Center** action provides the Process board, graph,
evidence links, unavailable-Process diagnostics, direct decisions, and declared-option forms.
Typed input, including non-sensitive typed input, remains CLI-only. The webview sends exact
identifiers to the reviewed command path; it does not become a separate execution engine. Authoring,
Process start, Authority Store transport, typed or brokered input, and model-backed steps remain
CLI-only. Command Center Step and Run actions do not add `--allow-model`.

## Stop, resume, and recover safely

Request a durable stop with the current revision:

```bash
singularity-flow process stop <PROCESS-ID> \
  --expected-revision <CURRENT-REVISION> \
  --json
```

`stop-requested` means dispatch is paused but an exact attempt or owner lease is still settling.
Repeat `process stop` or inspect fresh status until the owner and active attempt are gone and the
Process reports quiescence. Resume only from the current checkpoint:

```bash
singularity-flow process resume <PROCESS-ID> \
  --confirm sha256:<CURRENT-CHECKPOINT> \
  --expected-revision <CURRENT-REVISION> \
  --json
```

After an interrupted CLI or adapter execution, diagnose before changing anything:

```bash
singularity-flow process recover <PROCESS-ID> --json
```

Use only the exact confirmation-bound recovery command it prints:

- `reconcile-success` when an already verified receipt proves completion;
- `retry-safe` only for declared effect-free retryable work with attempts remaining;
- `fail` to stabilize uncertain execution without claiming success.

An ordinary failed task uses a separate preview/confirm retry ceremony:

```bash
singularity-flow task retry <PROCESS-ID> <TASK-ID> --json

singularity-flow task retry <PROCESS-ID> <TASK-ID> \
  --confirm sha256:<RETRY-PLAN-DIGEST> \
  --json
```

Retry is offered only when an attempt remains and the Program explicitly makes that task safe to
retry without an unsupported effect.

Never delete Process storage, reset a branch, invent a new digest, or replay an external effect as a
recovery shortcut. Use `process quarantine` for the exact legacy or incomplete state shapes that
SGOS identifies as unprovable.

Intentional replay is restricted to a safe pure suffix. Forking is restricted to a genesis
checkpoint. Preview either action first and confirm only its current plan digest.

## Export Process evidence

Create a canonical, content-addressed evidence bundle without changing Process state:

```bash
singularity-flow evidence export <PROCESS-ID> \
  --out .sflow/evidence/process.json \
  --json

singularity-flow evidence verify .sflow/evidence/process.json --json
```

Verification proves the exported bundle's structure and integrity. It does not independently prove
that current authority, signatures, or external facts remain valid.

## Share Capability Packs with Git-trusted mode

Git-trusted mode moves the complete reviewed Capability Pack lineage through the repository's
approved state branch. It uses Git remote permissions, branch controls, and forward-only history as
the transport root of trust. It creates and transfers no Authority Store transport private key.
Pack publisher signatures remain and continue proving Pack bytes and provenance.

### 1. Install the reviewed trust policy

Generate a scaffold without mutating configuration:

```bash
singularity-flow authority-store trust-scaffold \
  --mode git-trusted \
  --store repository-platform \
  --json
```

Take the returned `trustScaffold`, retain the approved Pack publisher public keys, save it as:

```text
singularity/sgos/capability-pack-trust.json
```

Review and publish that file through the normal `sflow/config` configuration process.

### 2. Initialize and publish from the source clone

Initialize only when the source clone does not already have that local Store:

```bash
singularity-flow authority-store init \
  --store repository-platform \
  --json

singularity-flow authority-store verify \
  --store repository-platform \
  --json
```

Preview publication, review the exact state commit and projection, then confirm:

```bash
singularity-flow authority-store publish \
  --store repository-platform \
  --json

singularity-flow authority-store publish \
  --store repository-platform \
  --confirm sha256:<PUBLISH-PLAN-DIGEST> \
  --json
```

After the first successful publication, update the reviewed v3 `transport.minimumAuthority` with
the exact returned `revision`, `stateSha256`, and `projectionSha256`. A null minimum is for
bootstrap; the reviewed minimum prevents later sync or rollback below that checkpoint.

### 3. Sync another clone or laptop

First make sure the receiver can read current approved configuration. Do not create a competing
empty Store: sync can install an absent local Store.

```bash
singularity-flow authority-store sync \
  --store repository-platform \
  --json

singularity-flow authority-store sync \
  --store repository-platform \
  --confirm sha256:<SYNC-PLAN-DIGEST> \
  --json

singularity-flow authority-store verify \
  --store repository-platform \
  --json
```

Sync permits only install, exact no-op, or strict fast-forward. It never merges divergent Pack
history, silently rewinds authority, or force-pushes. By default, the Git identity confirming either
publication or sync must belong to the approved `architecture-reviewers` authority.

Normal compilation and Process admission read Pack lineage from the installed local Store. They
never auto-fetch or auto-sync the state branch. When Pack authority changes, publish it at the
source and explicitly preview and confirm sync on every receiving machine.

Use signed-v2 transport instead when authority must remain independently verifiable even if the Git
host or state-branch history is compromised or force-rewritten.

## Copilot and VS Code usage

- In Copilot, use `@sflow /how SGOS` for deterministic reviewed help. Help does not execute a
  lifecycle mutation.
- Continue using `/sf-*` skills for normal Story work.
- Run exact `intent`, `program`, `process`, and `authority-store` commands in the selected repository
  terminal.
- In VS Code, open **Singularity Flow: Open Command Center** for Process projections and eligible
  guarded actions. The Command Center asks for confirmation before it invokes an exact
  revision-bound mutation.
- A shell mutation executes according to that command's contract; only commands explicitly
  documented as preview/confirm ceremonies are previews.

## Troubleshooting checklist

| Symptom | Safe next action |
|---|---|
| Program cannot start | Confirm its exact approval record is merged into approved `sflow/config` |
| Story subject is rejected | Re-read the Story at the exact baseline; do not substitute a Work ID from another branch |
| Process revision mismatch | Run `process status` and use the new revision; do not reuse the old command |
| Process appears interrupted | Run `process recover <PROCESS-ID> --json` |
| Process is unavailable or storage looks corrupt | Run `process fsck <PROCESS-ID> --json`; quarantine only when instructed |
| Human response is stale | Run `request show` again and use the current request and Process digests |
| Capability Pack is unavailable on a new laptop | Preview and confirm `authority-store sync`, then run `authority-store verify` |
| Git-trusted histories diverged | Stop; do not merge or force. Inspect both lineages and resolve through reviewed authority |
| A model task is refused | Confirm that the Program uses the installed proposal-only unit and explicitly pass `--allow-model` |
| An adapter or Device is unsupported | Provide reviewed registry/Pack authority plus the exact installed handler, Candidate capture, verifier, and manifest wiring; approval alone is insufficient |

## Operating rules

1. Prefer the normal Story lifecycle unless a reusable SGOS Program is genuinely needed.
2. Simulate and inspect a Program before proposing approval.
3. Keep configuration decisions on reviewed `sflow/config`.
4. Trust exact receipts and verified evidence, not terminal prose or model claims.
5. Use only the current printed digest, revision, and checkpoint.
6. Never manually modify Process, Candidate-retention, or Authority Store state.
7. Keep Pack publisher public keys needed to verify history; revoke or supersede Packs instead of
   deleting historical verification keys.
8. Explicitly sync Git-trusted Pack authority on each machine that must execute it.
9. Treat unsupported execution shapes as design work, not as a reason to weaken the runtime.
