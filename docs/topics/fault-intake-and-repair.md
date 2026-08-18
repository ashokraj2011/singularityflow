---
id: fault-intake-and-repair
title: Fault intake and governed repair
aliases:
  - fix-this
  - faults
  - repair-loop
commands:
  - fault
  - fix
  - repair
related:
  - diagnostics-and-regression
  - governed-execution
  - repository-state-and-snapshots
  - constitution
version: 1
---
A fault is immutable evidence that something failed. It is never permission to change code, weaken intent, approve work, merge, release, deploy, or modify production. Singularity Flow turns that evidence into deterministic diagnosis and, when pinned policy permits it, an isolated and bounded repair.

## Purpose and prerequisites

Use this topic after a local command, IDE task, CI build, test runner, integration environment, or monitoring adapter observes a failure. Start in the affected governed repository or select its workspace first. Capture the exact build/commit and small immutable evidence references where possible. Never paste credentials, hidden reasoning, or unrestricted chat transcripts as evidence.

The useful local release is intentionally guided. It records and groups faults, diagnoses them without a model, pins a repair plan, creates an isolated worktree only after exact authorization, accepts a candidate patch through the kernel, enforces its path scope, and reruns the complete pinned verification set. It does not approve, merge, push, release, or deploy.

## Use it from each surface

- **Shell:** use `sflow fault report`, `sflow fix`, and `sflow repair`. Wrap a command with `singularity-flow run --repair-on-fault -- <COMMAND>`. Run `singularity-flow fix --help` for every supported option.
- **Copilot:** use `/sf-fault` to record evidence and `/sf-fix` to diagnose, preview, authorize, and submit a patch through the governed kernel. The skill must stop for the exact plan hash and may not claim success without a resolved receipt.
- **VS Code:** open **My Work**. An unresolved fault appears above ordinary menu choices with **Fix this** and **Diagnose**. Those buttons open the same CLI/kernel journey; the extension stores no competing repair state.

## Guided workflow

1. Record the observation. For a command, run `singularity-flow run --repair-on-fault -- npm test`. For an external failure, use `singularity-flow fault report --source ci --environment ci --type unit-test --build 1842 --commit <SHA> --command "npm test" --exit-code 1 --log artifacts/test.log`.
2. Inspect it with `singularity-flow fault show <FAULT-ID> --json`. Confirm the source, environment, baseline, sanitized evidence, signature, and occurrence group.
3. Diagnose without code mutation: `singularity-flow fix <FAULT-ID> --diagnose-only`. Observed facts remain separate from the empty/model-labelled hypothesis channel.
4. Preview: `singularity-flow fix <FAULT-ID> --plan-only --allow-path src/payment --allow-path test/payment --verify "npm test -- payment"`. The preview writes no repair run.
5. Create or join the active run with the same `sflow fix` command without `--plan-only`. Equivalent signatures on the same baseline share one active repair.
6. Review the exact baseline, allowed/prohibited paths, non-shrinking verification commands, execution ceiling and budgets. Authorize the printed plan hash with `singularity-flow repair authorize <REPAIR-ID> --confirm <PLAN-SHA256> --open`.
7. Produce a Git patch without applying it to the developer checkout. Submit it with `singularity-flow repair attempt <REPAIR-ID> --patch candidate.patch`.
8. Read `singularity-flow repair status <REPAIR-ID>`. Only a complete passing verification set produces `resolved`; failures become retry-ready, needs-human, or exhausted according to deterministic stopping rules. A retry-ready attempt requires a fresh confirmation of the unchanged plan hash before another patch can be applied.
9. Cancel when appropriate with `singularity-flow repair cancel <REPAIR-ID> --reason "<reason>"`. The branch, worktree, attempts and evidence remain available.

## State and safety

Fault envelopes, occurrence groups, diagnoses, repair events, patches and receipts live under the repository Git control plane, so intake does not dirty application files. Each immutable record is content-hashed; unsupported future schemas and altered records fail closed. Evidence text is bounded and sanitized before storage. Large or binary evidence must be supplied by immutable URI and SHA-256.

Policy takes the most restrictive result of environment, fault type, caller request and repository configuration. Local/IDE defaults to guided, CI/staging defaults to propose, and production/security/intent conflicts default to diagnosis or challenge only. `--auto` can reduce authority but cannot increase it; bounded autonomous mutation remains unavailable unless an approved adapter policy exists.

The kernel creates a local `sflow/repair/<repair-id>` branch in an isolated worktree at the exact baseline. A dirty developer checkout is untouched. Patch paths are validated before application; `.git`, `singularity`, and configured protected paths are denied. Verification runs as exact argv without a shell, receives no network authority from SFlow, and cannot be removed by an attempt. A verifier that itself uses the network remains responsible for its own host sandbox and credentials. Repeated failures, no progress, oscillation, expired leases, baseline drift, scope expansion, unavailable verification and budget exhaustion stop or escalate the run.

## Troubleshooting

- If diagnosis has no affected path or executable verification command, supply explicit repeatable `--allow-path` and `--verify` values. SFlow remains `needs-human` rather than guessing.
- If CI asks for guided or automatic mutation, the effective ceiling remains `propose`; move the reviewed fault to an authorized local/IDE context instead of bypassing policy.
- If a requirement, policy, or architecture fault reports `challenge-intent`, open the governed amendment/challenge journey. Do not rewrite approved intent inside a repair.
- If authorization reports baseline drift, create a fresh plan. The old plan hash is intentionally unusable against new bytes.
- If a patch is outside scope, revise the patch or create a new plan with explicitly reviewed paths; do not broaden the existing plan silently.
- If a lease expires, inspect current status and authorize the same still-current plan again. Never reuse a confirmation after the plan changes.
- If verification fails, inspect the immutable attempt evidence. A second identical non-progressing result stops for a human instead of looping.

## Related topics

Continue with `sflow explain diagnostics-and-regression`, `sflow explain governed-execution`, `sflow explain repository-state-and-snapshots`, or `sflow explain constitution`.
