# Singularity Flow Phase Mutation Contract

**Specification ID:** `PMC-v1`

**Status:** Proposed

**Version:** `0.1.0-draft`

**Date:** 2026-10-11

**Implementation notes:** [Phase mutation contracts](PHASE-MUTATION-CONTRACT.md) describe the
implemented corrections and limits. Test-authoring phases do not require invented code intents;
permissions are session/turn-scoped, and corrupt explicit caches fail closed. Installed host
qualification is still outstanding: installation alone never proves prevention. These notes
supersede the draft's broad source-writing and enforcement assumptions below.

**Related work:** Copilot repository boundary (`copilot-repository-boundary.mjs`), agent hooks
(`agent-hooks.mjs`), code-generation assurance (`generation-boundary.mjs`), compact phase entry,
World Model is guidance (never authority)

## 1. Executive decision

Every phase already pins what it may change: `writeScope` (`artifact-only` or
`source-and-artifact`), `sourceBoundary` (`unrestricted` or `test-automation`), its artifact set,
the protected process paths, and, for code phases, the open generation intent. SFlow checks these
only after the fact, at publication, submission or the next phase entry. An agent that ignores its
instructions can change source in a phase that may not, and SFlow notices minutes later.

This specification makes that existing policy one **mutation contract** per Story phase and turn.
It does three things:

1. **States it.** Every agent entry packet, composed phase prompt and handoff carries the contract:
   what this turn may change, what it may not, and why.
2. **Enforces it where the host allows.** During an explicit SFlow turn, a `preToolUse` hook denies
   file edits the contract forbids before they happen. Approval turns become write-locked: the
   approval command is the only mutation.
3. **Says how strong the guarantee is.** Each contract reports its enforcement level: `prevented`
   (a host hook intercepts edits), `detected` (SFlow finds the change at the next lifecycle step) or
   `advisory` (instructions only). SFlow never claims prevention it cannot deliver.

The contract is derived from pinned policy, never from a phase's name. A custom workflow whose
Planning step is `source-and-artifact` may change source in Planning. A packaged `artifact-only`
Planning may not.

## 2. The incident that prompted this

Story `g1-hex` (spec-driven-standard, workspace `myc1`), 2026-10-11, times IST, from the Story's Git
history, SFlow's command and harness logs, and the Copilot CLI session log:

| Time | What happened |
| --- | --- |
| 13:01:49 | The human typed `/sf-approve specification --work-id g1-hex`. |
| 13:03:17 | `choices answer` then `approve` succeeded. Planning became current. The 8.5 KB result was spilled to a temporary file the agent never read. |
| 13:03:27 | Not knowing it had approved, the agent ran `approve` again. Refused: "Cannot approve for specification yet", with next step "Generate and publish phase 'planning'". |
| 13:03:45–13:05:34 | Instead of ending the turn, the agent read `src/` and edited six application files, implementing the Story's feature. No SFlow command ran. No generation intent existed. |
| 13:06:22 | The agent reported "Implemented the hex conversion feature". |
| later | `/sf-plan` refused authoring: `PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED` for the six files. |

The model was `mai-code-1.1-flash`, chosen by Copilot's Auto for that turn. The `/sf-approve` skill
already says "Never edit repository files … or begin/author another phase. A failed approval ends
this turn." The instruction did not hold, and nothing at tool level enforced it:

- The plugin's `preToolUse` hook (`boundary-guard`) matches only shell and search tools, and it
  restricts repository discovery, not edits.
- `agent-guard`, which already denies edits for read-only agents, session-only turns and published
  code generations, is not installed by any shipped hook configuration.
- The refusal for re-approving an approved phase pointed at authoring the next phase.

## 3. Current state

What exists and is reused:

| Policy or mechanism | Where | Today |
| --- | --- | --- |
| `writeScope: artifact-only` | pinned phase policy | Submission refuses changes outside `<workItemRoot>/<ID>/artifacts/<phase>/` (`PHASE_ARTIFACT_ONLY_CHANGES`). |
| `sourceBoundary: test-automation` | pinned phase policy | Publication refuses non-test paths (`assertSourceBoundary`). |
| Protected process paths | `governance.protectedPaths`, capability policy, packaged defaults | Generation refuses changes to them. |
| Generation intent | `phase begin`, `generation-boundary.mjs` | Code phases need an open intent before source changes; checked at publication. |
| Published code generation | `agent-guard` | Edits denied, but the hook is not shipped. |
| Session-only and read-only-review turns | `agent-guard` | Tool use denied, but not shipped. |
| Explicit SFlow turn record | `boundary-turn` (shipped) | Records the `/sf-*` skill per Copilot session; native and paused turns record nothing. |
| Worktree review | phase entry admission, lifecycle decisions | `PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED`, `LIFECYCLE_WORKTREE_REVIEW_REQUIRED` detect changes afterwards. |

Deliberate constraint, kept: `scripts/check.mjs` forbids a blanket lifecycle guard in the plugin. A
native Copilot turn must not acquire an SFlow policy gate. Prevention in this specification
therefore applies to explicit SFlow turns by default.

## 4. Goals

- One contract per Story phase and turn, derived from pinned policy, identical everywhere it is
  shown or checked.
- Prevent forbidden file edits during explicit SFlow turns on hosts with `preToolUse`.
- Make approval turns write-locked, whatever the phase type.
- Detect forbidden shell-made changes immediately after the command, not at the next phase.
- Report the true enforcement level in every packet and in `doctor`.
- No regression for ordinary Copilot use, pause mode, human terminal work, or legitimate edits in
  code and test phases.

## 5. Non-goals

- A filesystem sandbox. Shell commands can write in ways a hook cannot classify; this specification
  detects those, it does not claim to prevent them.
- Gating native Copilot turns by default (see section 12 for the opt-in).
- New approval authority. The contract never authorizes anything; it only narrows what an agent's
  tools may change. Lifecycle commands keep every existing check.
- Restricting what a human does in their own terminal or editor.
- Changing any phase's policy. The contract states and enforces policy that is already pinned.

## 6. Terminology

- **Explicit SFlow turn:** a Copilot turn started with a `/sf-*` skill while SFlow is not paused,
  as `boundary-turn` already records it.
- **Native turn:** any other Copilot turn.
- **Turn mode:** what the explicit turn is for: `authoring`, `approval-only`, `session-only`,
  `read-only-review` or `read`.
- **Application path:** a working-tree path that `applicationPathContext` classifies as product
  source or tests, outside governed Story state and SFlow configuration.
- **Enforcement level:** `prevented`, `detected` or `advisory`, as defined in section 1.

## 7. Invariants

1. The contract is computed from pinned Story policy and the Story's current lifecycle state, never
   from a phase ID, label or agent name.
2. The contract only narrows. It never permits a change a lifecycle gate would refuse, and never
   weakens an existing gate.
3. Native turns, pause mode and human terminal actions behave exactly as before unless a repository
   opts in (section 12).
4. Governed Story state (`workflow.json`, approvals, receipts, packets) and protected process paths
   are never writable by agent edit tools in any turn; only SFlow commands change them.
5. In an explicit turn, a missing, stale or unreadable contract denies application-path writes with
   a remedy (fail closed). Outside explicit turns it is inert (fail open, as today).
6. Every denial names the exact allowed next step. A refusal that names no remedy is a defect.
7. SFlow reports `prevented` only when it has verified that its hook is installed for the host
   running the turn.

## 8. The contract

### 8.1 Derivation

For the bound Story, current phase and turn mode:

| Situation | Agent may edit | Lifecycle commands |
| --- | --- | --- |
| `artifact-only` phase, authoring turn | the phase's resolved artifact set (default `<item>/artifacts/<phase>/`) and SFlow-issued staging files | normal authoring commands |
| `source-and-artifact` phase, no open generation | its artifact set only; application paths are denied until `phase begin` opens a generation | `phase begin` and authoring commands |
| `source-and-artifact` phase, open generation | artifact set and application paths, minus protected paths | normal authoring commands |
| `sourceBoundary: test-automation` | as above, with application writes limited to test-automation paths | unchanged |
| Published (consumed) code generation | nothing in the repository (existing `agent-guard` rule) | submit or recover only |
| `approval-only` turn (`/sf-approve`, `/sf-reject`) | nothing | `status`, `choices`, `phase show`, `documents` reads, and the single approve or reject |
| `session-only` turn | nothing (existing rule) | session commands only |
| `read-only-review` agent | nothing (existing rule) | read and review-packet commands |
| No bound Story, or SFlow paused | not governed by SFlow | not governed |

Always denied to edit tools: protected process paths, `singularity/workflow.yml` and other
configuration, governed Story state, and anything outside the Story worktree that is inside
another governed repository. Paths outside every repository (for example temporary files) are not
governed by the contract.

SFlow-issued staging files are the exact paths SFlow returns for the agent to write, such as
source-review report staging and clarification response files. They are listed in the contract by
the command that issues them, not by pattern.

### 8.2 Record

`mutation-contract` v1, written by SFlow and read by the hook:

```json
{
  "schemaVersion": 1,
  "kind": "mutation-contract",
  "workId": "g1-hex",
  "phaseId": "planning",
  "generation": 1,
  "turnMode": "authoring",
  "policy": {
    "writeScope": "artifact-only",
    "sourceBoundary": "unrestricted",
    "requiresOpenGeneration": false,
    "generationIntent": null
  },
  "allow": ["singularity/work-items/g1-hex/artifacts/planning/"],
  "staging": [],
  "deny": {
    "applicationPaths": true,
    "protectedPaths": ["singularity/workflow.yml", "singularity/capabilities.yml"],
    "governedState": true
  },
  "lifecycle": { "allowed": "authoring" },
  "enforcement": { "level": "prevented", "host": "copilot-cli", "hook": "boundary-guard@2" },
  "binding": { "repositoryRoot": "…", "head": "…", "workflowSha256": "…" },
  "contractSha256": "…"
}
```

- Stored at `<git-dir>/singularity-flow/mutation-contract.json` for the Story worktree (private,
  mode 0600, never committed).
- Rewritten by every SFlow command that changes the phase, generation or turn: `start`,
  `phase enter`, `prepare`, `phase begin`, `phase publish`, `submit`, `approve`, `reject`,
  `reopen`, `recover --apply`, session attach, and the `boundary-turn` hook for the turn mode.
- `binding.workflowSha256` lets the hook detect staleness by hashing one small file, with no Git
  process on the edit path.

### 8.3 Where it is shown

- **Agent entry packets** (`phase enter`, `nextsteps`, `session current` with `--for-agent`): a
  `mutationContract` summary immediately after the `story` summary, with one sentence such as
  "This phase writes its plan only. Do not change application code; code changes start in
  Implementation after `phase begin`."
- **Composed phase prompt:** one "Changes allowed" line at the top of the phase contract section,
  inside the existing section so the declared section order is unchanged.
- **Handoffs:** the VS Code prefill and the approval result carry the same sentence.
- **Approval results:** `turnBoundary: "end"` plus the next phase's contract as display-only text.

## 9. Enforcement

### 9.1 Turn mode

`boundary-turn` (shipped, `userPromptSubmitted`) already records the explicit skill. It additionally
records the turn mode from a closed skill map: `sf-approve` and `sf-reject` are `approval-only`;
`sf-session` is `session-only`; skills that author a phase are `authoring`; every other skill is
`read`. Unknown skills are `read`. The record keeps its 30-minute expiry and is cleared at session
end and on native or pause turns, as today.

### 9.2 Edit tools (prevention)

The shipped `preToolUse` hook gains the edit-tool family. The matcher covers file-write tools by
name class: patch, edit, replace, insert, write, create, delete, move and rename, reusing
`isCopilotRepositoryMutation`. For each call during an explicit turn, the hook:

1. reads the turn record and the cached contract, and verifies `workflowSha256`;
2. resolves every target path from the tool arguments (`path`, `file_path`, `paths`, edit lists)
   against the call's cwd, rejecting symlink escapes the same way `regularWorktreeFile` does;
3. allows the call only if every target is allowed by the contract;
4. otherwise answers `{ "permissionDecision": "deny", "permissionDecisionReason": … }`.

Example reason in the incident: "This is an approval turn for g1-hex: the approval is the only
change it may make, and it has already succeeded. Planning is current and writes only
artifacts/planning/. End this turn; start Planning in a new chat with /sf-plan."

### 9.3 Shell (detection)

Shell commands are not parsed for writes. Instead:

- In `approval-only` and `session-only` turns, the existing lifecycle classifier denies any
  mutating SFlow command other than the turn's own, and any shell command that is not an SFlow
  read, before it runs.
- In other explicit turns, where the host offers `postToolUse`, SFlow compares application-path
  status with the turn's baseline after each shell command. On a forbidden change it returns a
  stop instruction naming the paths and the recovery route, and records the finding for the next
  phase entry. The baseline is one porcelain status taken when the turn starts.
- Where the host has no `postToolUse`, detection stays at the existing lifecycle gates and the
  contract says so.

### 9.4 Performance

- The edit-tool path spawns no Git process: one record read, one small file hash, path checks.
- Budget: p95 under 150 ms per guarded call on the reference machine; non-explicit turns return
  within 30 ms (record lookup only).
- The shell detection path may run one porcelain status per shell call, only in explicit turns.

### 9.5 Hosts

| Host | Edit tools | Shell | Level reported |
| --- | --- | --- | --- |
| Copilot CLI and VS Code with the Copilot CLI agent host | `preToolUse` | `postToolUse` where available | `prevented` for edits when the plugin hook is installed and current |
| VS Code native Copilot agent without hook support | none | none | `detected` |
| Other agent hosts whose hooks are wired | per host | per host | per verified installation |

`doctor` reports, per host it can see, whether the hook is installed and which version.

## 10. Approval turns

1. `approval-only` mode is set by the turn record (section 9.1).
2. After a successful approve or reject the result carries `turnBoundary: "end"`, and the skill
   ends the turn.
3. Approving a phase that is already approved returns a dedicated refusal,
   `PHASE_ALREADY_APPROVED`, naming who approved it and when, and saying the next phase is current
   and must start in a new turn. It offers no authoring step.
4. The agent form of the approve result is compact (under 2 KB), so hosts show it inline instead of
   spilling it to a file the agent never reads.

## 11. Disclosure

- The contract's `enforcement.level` appears in every agent packet and in VS Code's phase view.
- Documentation (`docs/topics/compact-phase-entry.md` and the Copilot topic) states plainly: with
  the hook installed, SFlow prevents forbidden edits in explicit SFlow turns. Without it, or for
  shell-made changes, SFlow detects them at the next step. It does not sandbox shell commands.

## 12. Native turns (opt-in)

Default: unchanged. Native turns are not gated, keeping the closed hook-map principle in
`scripts/check.mjs`.

Opt-in policy `copilot.mutationGuard: explicit-turns | governed-worktree` (default
`explicit-turns`). With `governed-worktree`, the same edit-tool check applies to native turns inside
a Story worktree whose current phase is `artifact-only` or whose code generation is not open. The
check.mjs rule changes from "never" to "only when the repository opts in". This is a decision for
the product owner (section 18).

## 13. Functional requirements

- **PMC-REQ-001** SFlow derives one mutation contract from pinned phase policy, lifecycle state and
  turn mode, as in section 8.1, without reading phase names.
- **PMC-REQ-002** Every lifecycle command listed in 8.2 rewrites the cached contract atomically.
- **PMC-REQ-003** Agent entry packets include the contract summary after the `story` summary.
- **PMC-REQ-004** The composed phase prompt states the allowed changes without changing the
  declared section order.
- **PMC-REQ-005** The shipped `preToolUse` hook denies forbidden file edits in explicit turns.
- **PMC-REQ-006** Approval and session turns deny every write and every lifecycle mutation other
  than their own.
- **PMC-REQ-007** In explicit turns, a missing or stale contract denies application-path writes
  with a remedy; native turns are unaffected.
- **PMC-REQ-008** Where `postToolUse` exists, a forbidden shell-made change stops the turn with the
  paths and recovery route.
- **PMC-REQ-009** Re-approving an approved phase returns `PHASE_ALREADY_APPROVED` with no next-phase
  authoring step.
- **PMC-REQ-010** The agent approve result is compact and ends the turn.
- **PMC-REQ-011** Packets, VS Code and `doctor` report the verified enforcement level.
- **PMC-REQ-012** Governed state and protected paths are never writable by agent edit tools.
- **PMC-REQ-013** The `governed-worktree` opt-in, if adopted, applies the same check to native turns
  only in repositories that enable it.

## 14. Acceptance criteria

- **PMC-AC-001 (incident replay)** In an explicit `/sf-approve` turn, after a successful approval, an
  edit to `src/App.jsx` is denied, and the reason names the current phase and the new-turn route.
- **PMC-AC-002** In an `artifact-only` phase's authoring turn, edits inside its artifact set succeed
  and edits to application paths are denied.
- **PMC-AC-003** In a `source-and-artifact` phase, application edits are denied before `phase begin`
  and allowed after it, and denied again once the generation is published.
- **PMC-AC-004** A custom workflow whose Planning is `source-and-artifact` may change source in
  Planning after `phase begin`.
- **PMC-AC-005** `sourceBoundary: test-automation` allows test-automation paths and denies others.
- **PMC-AC-006** Native turns and paused mode make the same edits as before, with no hook denial.
- **PMC-AC-007** Edits to `workflow.yml`, governed state and protected paths are denied in every
  explicit turn mode.
- **PMC-AC-008** A stale contract (workflow changed, no rewrite) denies application writes in an
  explicit turn and names `phase enter` as the remedy.
- **PMC-AC-009** With `postToolUse`, a `sed -i` on an application file in an `artifact-only` turn is
  reported immediately with its path.
- **PMC-AC-010** `approve` of an approved phase returns `PHASE_ALREADY_APPROVED`.
- **PMC-AC-011** The agent approve result is under 2 KB and carries `turnBoundary: "end"`.
- **PMC-AC-012** A packet reports `prevented` only when the hook is installed and current;
  otherwise `detected` or `advisory`.
- **PMC-AC-013** The edit-tool hook path spawns no Git process and meets the 150 ms p95 budget.

## 15. Delivery roadmap

### M1 — approval lock and edit-tool guard

Turn modes in `boundary-turn`; edit-tool matcher and contract check in the shipped hook;
`approval-only` and `session-only` denials; `PHASE_ALREADY_APPROVED`; compact approve result;
update the `check.mjs` hook-map rule to the new closed map. Covers the incident.

### M2 — contract record and disclosure

`mutation-contract` record family and atomic writers; packet, prompt and handoff text; enforcement
level in packets, VS Code and `doctor`; documentation.

### M3 — shell detection

Turn baseline and `postToolUse` detection, after verifying the pinned Copilot CLI version delivers
that event; findings carried into the next phase entry.

### M4 — generation-gated code edits and the opt-in

Application edits gated on an open generation in code phases. If the product owner adopts it, the
`governed-worktree` opt-in with its check.mjs change.

## 16. Test plan

- Unit: contract derivation for every row of 8.1; turn-mode map; path resolution including symlink
  and `..` escapes; staleness by `workflowSha256`.
- Hook: payload fixtures for each Copilot CLI edit-tool shape and VS Code tool names; deny and allow
  answers; malformed input still answers `{}` outside explicit turns.
- Integration: a scripted Story through `artifact-only` and code phases with explicit turns; the
  incident replay (PMC-AC-001); native and paused turns unchanged.
- Real host: one Copilot CLI session in an isolated `COPILOT_HOME` with the plugin installed,
  driving `/sf-approve` then a requested edit, using a fake or approved model as policy allows.
- Performance: hook latency measured on the reference machine; the intake Git-process ratchet
  unchanged.

## 17. Quantitative budgets

| Measure | Budget |
| --- | --- |
| Edit-tool hook, explicit turn | p95 ≤ 150 ms, 0 Git processes |
| Any hook call, native turn | p95 ≤ 30 ms |
| Agent approve result | ≤ 2 KB |
| Contract record | ≤ 4 KB |
| Story start Git processes | unchanged (ratchet 260) |

## 18. Risks and open decisions

| Risk or decision | Handling |
| --- | --- |
| Over-blocking a legitimate write a skill needs | Staging paths come from the commands that issue them; an inventory of every skill's writes precedes M1; denials name the remedy. |
| Host tool names change | The matcher uses name classes; hook fixtures pin current shapes; `doctor` flags an unknown host version. |
| Agents route edits through shell to evade the edit guard | Shell writes are detected (M3) and reported as such; the contract never claims to prevent them. |
| Hook not installed (direct skills only) | Level reported as `detected` or `advisory`; `doctor` shows how to install. |
| Decision: gate native turns? | Recommended default `explicit-turns`; `governed-worktree` only as a repository opt-in. Needs the product owner's choice. |
| Decision: deny or warn in M1? | Recommended: deny in `approval-only` and `session-only` turns from M1; deny application edits in `artifact-only` authoring turns from M1 as well. |

## 19. Rollout

- M1 ships enabled for explicit turns; it changes only what an explicit turn's agent may edit.
- Each milestone is independently revertible; the shipped hook answers `{}` when its record or
  contract code is absent.
- Release notes state the enforcement levels per host.

## 20. Definition of done

- All PMC acceptance criteria pass in the suite, and PMC-AC-001 also passes in a real Copilot CLI
  session.
- `doctor` reports the verified level on the maintainer's machine.
- Documentation states prevention versus detection per host.
- No regression in native turns, pause mode, or the start and phase-entry performance ratchets.
