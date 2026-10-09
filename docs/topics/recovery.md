---
id: recovery
title: Recovery — nothing is ever lost
aliases:
  - sync
  - recover
  - pending-publication
  - crash
  - lost-laptop
questions:
  - Recover interrupted implementation
  - How do I recover after a failed phase on macOS?
  - How do I recover interrupted work?
  - Why was work interrupted before its governed commit completed?
commands:
  - sync
  - recover
  - doctor
  - refresh-branch
related:
  - checkpoints-pause-continue
  - sequence-gates
version: 15
---
Publication is a transaction: verified preconditions, an integrity-bound preimage written to the local journal, one isolated commit of allowlisted paths, compare-and-swap branch advance, and push without force. If the process dies before the commit, `sflow sync` reclaims its dead subject lock, preserves the partial bytes under `.git/singularity-flow/publication-rescues/`, and restores the exact pre-transaction governed state. If the commit exists but push failed, sync retries that exact commit once without regenerating or rewriting it. When the push was refused because another clone published to the same Story first, sync says so; if the retained commit is a document upload, `sflow sync --replay` (preview with `--dry-run`) adds the same documents again on top of the published Story, where they take the next free IDs, and keeps the retained commit under `refs/sflow-replayed/<WORK-ID>/`. An upload refused before it committed, because this checkout was behind, names `sflow refresh-branch`. A live command is reported as active and is never rolled back. A branch-head race refuses rather than clobbering — reload and retry. A dead laptop costs nothing already committed: clone and `sflow resume`. `sflow doctor` diagnoses; `sflow recover` produces a content-addressed, model-free plan for transport, artifact, Agent Brief, code-delivery, and generation-intent blockers. Concurrent writes to the same work item are serialized by a subject lock and caught by a state fingerprint even when uncommitted.

## Purpose and prerequisites

Use this topic when the current goal matches **recovery**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow recover [WORK-ID] --json` inspects the active phase, including before its first publication. Use `--phase <phase>` for an explicit phase. An automatic action requires `--apply --confirm <planId>`. `sflow sync`, `sflow doctor`, and `sflow refresh-branch` remain available for their narrower roles.
- **Copilot:** `/sf-recover`, `/sf-doctor`, `/sf-refresh-branch`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Inspect the plan. Each blocker names its stable code, category, phase/generation, evidence path and line, and one bounded action.
4. Follow the action's owning route when it is guided. Recovery never fabricates a requirement, implementation, test, clarification, or approval.
5. Only when the plan contains automatic actions, confirm the exact `planId` and use its returned `applyCommand`, retaining phase/fetch/no-model flags. The command recomputes repository HEAD and the worktree fingerprint and refuses a stale plan. A guided/manual plan is not an automatic failure: follow its owning action instead. If `--apply` was used anyway, the refusal retains those actions and manual instructions on every surface.
6. Re-read recovery once after completion. Retry only after evidence shows the diagnosed blocking condition changed. For a missing interpreter or dependency, that evidence is the repaired runtime in the same command/cwd, not an unrelated edit to source just to change a hash.

Every phase refusal uses the same containment rule. The current phase remains the repair boundary;
published generations stay immutable, authored work is not discarded, and recovery never advances
the lifecycle or rewrites history. A read-only phase recovery plan names the exact blocker and the
owning producer (`/sf-phase`, `/sf-code`, or another configured route). Configuration defects are
repaired through configuration authority while the Story stays paused in the same phase; the pinned
Story snapshot is never hand-edited. A configuration refresh only changes future Stories: it is
not a same-Story amendment of a malformed pinned test command. An approval failure ends the approval-only turn. If reviewed
bytes must change, a new turn uses `/sf-reject` to choose an allowed repair target, followed by fresh
authoring, submission, and approval.

This applies to prepare, generation begin, generation rollover, draft checks, publication,
submission, and approval. A failed approval never offers another approval retry against stale
evidence: the approval turn ends, and any content repair starts through `/sf-reject` in a new turn.
Optional Copilot telemetry cursor corruption, contention, or local write failure cannot block phase
work or turn a successfully restored draft into a failed rollback; usage is reported as partial or
unavailable instead.

For an interrupted publication, `sflow sync` selects the recovery action from the journal boundary:

- **Live owner:** stop and return to the terminal running the reported PID.
- **Dead owner, before commit:** restore the durable preimage and retain the interrupted bytes in the reported rescue directory.
- **Commit created, push incomplete:** publish the retained commit without rebasing, amending, or regenerating.
- **Legacy dirty journal without a preimage:** fail closed and require manual inspection; recovery never guesses what the previous bytes were.

## State and safety

Recovery inspection is read-only and never invokes a model or AST. `recover --apply`, `sync`, and `refresh-branch` can mutate governed or machine-local state and remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Pre-commit rollback touches only the governed roots named by the integrity-checked journal; unrelated source edits and staged files are not reset. Only system-owned transport and exact preimage restoration are automatic. Source, authored artifacts, policy, approvals, and human answers are never invented or repaired by a model. AST or a language pack being unavailable is advisory and cannot block recovery or ordinary file-based work.

The rollback boundary restores both durable files and the same in-memory Story aggregate retained by
long-lived hosts, so an immediate retry cannot see a phase transition that was refused. After a
governed commit lands, session refresh and review rendering are presentation work: failures there are
reported as warnings with a resume route and never relabel the committed lifecycle mutation as a
failure or invite a duplicate publish, submit, approval, rejection, reopen, amendment decision, or
convergence-rework decision.

The same rule covers local pending-marker cleanup after a successful push. The committed/pushed
transition is reported as successful, the marker remains available for exact verification, and
`sflow sync` (or `sflow initiative sync`) clears it without repeating the lifecycle mutation.

A phase transition finishes a retained publication itself. When an earlier command committed but
could not push, the next transition (`next`, `submit`, `approve`, `reject`, and the others) first
retries that exact publication with the same exact-lease sync. If the push succeeds, the transition
continues. If it fails, the transition refuses as before and names `sflow sync`. A publication
interrupted before its branch ref advanced is never rolled back automatically; `sflow sync` remains
the explicit path for it. Set `SINGULARITY_FLOW_TRANSITION_REPAIR=off` to switch this off.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a generation intent was already consumed and its bytes changed (for example, a requested README update after implementation publication), do not retry `/sf-code` or submit the old generation. Use `/sf-recover` or `singularity-flow recover <WORK-ID> --phase <phase> --json` to review the blocker, Git diff, and exact rollover action. Preview with `singularity-flow phase rollover <phase> --json`; execute only the returned `--confirm` command after confirming the changed paths are owned, in scope, and permitted by policy. Recheck recovery and the phase's code/test evidence before publishing the successor. The previous generation remains preserved.
- If the prior publication commit cannot be authenticated, or the changed paths are protected, unrelated, or not owned by the current Story, do not treat a rollover or risk acceptance as a shortcut. Preserve the bytes, inspect `singularity-flow doctor --json` and the repository history, and repair the specific authority or scope problem first.
- An accepted risk is not an integrity bypass. Where convergence reports an eligible observed deviation, a human can record `singularity-flow story adjudicate <ITEM-ID> --work-id <WORK-ID> --disposition accepted-deviation --reason <reason> --clause <CLAUSE-ID>`; the decision remains visible as a deviation and does not replace required code, tests, publication, or approval. A changed consumed generation, missing or forged evidence, protected-path violation, or unverifiable publication cannot be accepted away.
- If the same diagnosed condition is unchanged, stop. Repeating publish cannot change its preconditions. An environment-only repair can leave source hashes and the recovery `planId` unchanged; verify the repaired interpreter/dependency rather than requiring an artificial source edit.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Code/test gate recovery: diagnose before retrying

`/sf-code` authors and publishes a generation; `/sf-submit` revalidates the published generation.
These are separate gates. `draft-check: ready` and `prepublish: ready` only mean the currently
inspectable conditions passed; neither claims that required tests have run successfully.

Recovery must not end at a red toast or repeat the same failed command indefinitely. Each refusal
offers a diagnostic, guided repair, explicit human review, or external prerequisite. Commandless
human instructions remain visible in VS Code and Copilot. If recovery inspection itself fails,
diagnose its repository/configuration prerequisite rather than recursively running the same
inspection. A missing phase ID routes to the actual Story phase list, not a guessed workflow name.
An unavailable host, missing authority, or integrity failure may require an authorized owner; a
recovery route is not a promise that a model can automatically fix or waive every blocker.

For an unpublished generation, recovery and prepublish share the publication dependency checks:
approved input bytes and hashes, required integration receipts, grounding, generation-bound human
clarification, MCP host readiness, and required MCP evidence. A missing dependency suppresses the
publication command and automatic draft correction and names its own diagnostic or guided repair.
Warning-only policies remain warnings in both CLI and VS Code. Grounding is always warning-only:
the World Model is guidance, so a missing or unverifiable grounding record never suppresses
publication. These checks do not send a delivery,
start a host, answer a question, or rewrite a saved prompt. Publication rechecks the dependencies;
a prior `ready` result is not reusable authorization. Code publication checks again after tests,
because test commands can change files.

Use `--no-model` consistently for a permitted manual route. Its publication command retains the
resolved producer and flag; recovery does not demand model grounding or human-clarification records
for non-model authorship. Recovery also does not request a new prompt for an already-published
generation merely because submission is still pending. Integrity failures still require their
reported repair; they cannot be accepted away as warning-only freshness.

Start with the selected Story checkout, not another workspace's terminal:

```sh
singularity-flow session current --json
singularity-flow recover <WORK-ID> --phase <phase> --json
singularity-flow phase prepublish <phase> --json
```

Recovery and prepublish expose `testExecution.commands` without executing tests, including after
publication. Compare the interpreter, argv, working directory, report adapter and path with the
manual test run. Inferred commands are shown directly; configured argv are withheld from generic
diagnostics because they may contain credentials. Inspect those through their governed configuration
source. IDs such as `.-python-tests` are identifiers, not executables.

### Why a passing test report can accompany a failed gate

Required tests need both a successful process exit and valid, sufficiently populated structured
results. A report with 16 passing tests does not override exit code 1: it could precede a failing
coverage threshold, teardown, second command stage, or be an old report from a different run.
SFlow clears the declared result before execution and captures bounded diagnostics from that run
before restoring transient output. A restored file in the checkout is not the current run's evidence.
Failure reports are explicitly diagnostic-only (`gateEligible: false`), never receipts or approval.
Existing native report files are backed up before clearing and restored on a failed/refused run;
validated successful native runs retain their fresh output. Directory adapters clear only report
files, not the entire directory. A native report path overlapping tracked repository content is
refused before execution, rather than deleting source and discovering the conflict afterwards.

Refusals and saved CLI logs retain a bounded/redacted `requiredTestExecution` projection:
command identity, cwd, exit, stdout/stderr, report availability/counts, bounded failing test names
where the adapter exposes them, failure classification and repair guidance. Arbitrary error
details and configured argv are not logged. Existing logs cannot retrospectively recover output
that an older build never saved.

For Python inference SFlow uses a structurally valid module `.venv`, then repository `.venv`, before
the normal system launcher. Windows uses `Scripts/python.exe`; macOS/Linux use `bin/python3` or
`bin/python`. This avoids a manual run using the project's pytest while publication accidentally
uses a system Python without pytest. It does not install dependencies, activate a shell environment,
override an explicit pinned command, or guarantee pytest is installed in that environment.
Inferred pytest runs disable Python bytecode and pytest cache writes, so passing tests do not
create an unexpected `__pycache__` or `.pytest_cache` source change. Explicit configured commands
keep their original arguments and remain the configuration owner's responsibility.

### Choose the repair that matches the blocker

| Finding | Repair and retry boundary |
| --- | --- |
| Missing launcher/dependency or wrong Python | Inspect exact runtime/cwd, restore approved dependencies with necessary authorization, prove the failure condition changed, retry. No source edit or rollover is needed if published bytes are unchanged. |
| Untracked `.sflow/results/**` | Preserve it. Recovery treats these reserved generated outputs as disposable diagnostics, not unexpected source changes. Tracked/staged reports still require review. No `git clean`, reset or manual deletion is needed. |
| Owned source/test/artifact draft in an open intent | Review scope and repair within that intent; rerun draft checks and prepublish. A dirty tree is expected while authoring. |
| README/code/tests changed after publication | `/sf-recover` → review diff → preview `singularity-flow phase rollover <phase> --json` → human confirms exact digest → publish successor. Preserve the previous generation. |
| Test process changes source | Preserve and review changes; tests must be observational. Repair the runner/source, using rollover if the generation was already consumed. Do not rerun repeatedly over mutated bytes. |
| Nonzero exit with passing report | Inspect current run's stderr and remaining runner stages. Do not treat report counts as authority to waive the failed process. |
| Missing/invalid/zero-test report | Correct the repository-owned reporter or runner declaration when in scope, then retry. Never fabricate a report or lower minimums to manufacture a pass. |
| Malformed pinned test command | Configuration owner repairs the approved policy; refresh alone does not change this Story's pin. Preview `singularity-flow story test-policy amend <WORK-ID> --reason "<reason>" --json` for the engine's reviewed command-only amendment route. Follow its eligibility, live human confirmation, and fresh-validation requirements; retain historical evidence and never hand-edit the pin. |
| Divergence, protected/unowned paths, unverifiable publication | Preserve bytes and follow the exact diagnostic/owner action. These are not eligible for a blanket “accept risk” bypass. |

Runtime repair can legitimately leave the code and artifact fingerprints unchanged. Skills compare
the diagnosed condition and runtime evidence as well as source/check hashes, stop on an unchanged
condition, and allow at most three distinct repairs per attempt. They never endlessly call publish,
silently discard a dirty tree, or submit/approve from the recovery skill.

### Scope and rollout

The execution, report and recovery fixes apply to all phases using the shared code-delivery test
gate, not only a workflow named `spec-driven-standard`. Existing Stories keep their pins and
published generations. Install the updated CLI in each calling host and update Copilot skills;
VS Code's bundled CLI also needs the rebuilt extension. A source commit alone does not update an
already-installed extension. Use the read-only recovery commands above first; migration of Story
state, resetting worktrees, deleting test reports, and resubmitting are not installation steps.

## Related topics

Continue with `sflow explain checkpoints-pause-continue`, `sflow explain sequence-gates`.
