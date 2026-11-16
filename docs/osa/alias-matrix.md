# OSA Stage 0 — writing aliases and their contracts

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md): D1, D2, section 10, REQ-024, REQ-025, REQ-027 and AC-019. Plan §2 item 5 freezes command semantics.

**Base:** `d7a976821`. "Lx" is line x of `plugin/skills/sflow-<name>/SKILL.md`; all other paths are repository paths. This is a reading of the skill files, `plugin/skills/registry.yml`, `src/command-skills.mjs`, the guard's turn rules and the journey follower. Nothing was run.

## Summary

| Class | Meaning | Invocations |
|---|---|---|
| **A** current-step alias | "Work on this step"; it can route into the shared coordinator | `/sf-code` on a code step; `/sf-phase` on a step whose work command is `/sf-phase`; `/sf-implement` on a code step; `/sf-converge` on a model-written convergence step |
| **B** parameterized alias | Current-step work whose arguments change the target or scope; an adapter must keep them | `/sf-code <step> [<what to change>]`; `/sf-phase <step>`; `/sf-specify` and `/sf-plan` at a step their fast-path verb owns; `/sf-verify [scope]` on a verification step; `/sf-call <AGENT>` matching the step's agent; `/sf-scenario-repair <defect>` |
| **C** standalone contract | Keeps its own registered behaviour; only its step-authoring use may delegate | `/sf-run`; `/sf-converge` (kernel-built convergence and adjudication); `/sf-code-docs`; `/sf-next` (sync, decisions, chat reset, kernel actions); `/sf-session`; `/sf-resume <ID or branch>`; `/sf-call` with a mismatched agent |
| **D** ambiguous today | Needs a precise clarification rule or the D1/D2 change | the four groups below |

**The class D cases:**
- `/sf-code` on a step that is not code, and `/sf-phase` on a code, configured-skill or convergence step: each relays to the other, which contradicts D1.
- `/sf-code <step>` or `/sf-phase <step>` naming a step that is not current: the step is ignored as a target and recorded as "asked for".
- `/sf-next` at an authoring step: it relays `/sf-code`, which contradicts D2.
- `/sf-call` with no agent name or no Story; bare `/sf-resume` (the route SFlow issues); `/sf-run` at the authoring boundary; fast-path verbs in a work type without a fast path.

## 0 Rules shared by every alias

| Rule | Where |
|---|---|
| A turn's skill is the first `/sf-…` token, or a host `<skill-context name=…>`. Arguments are read only by the rules below. | `src/copilot-repository-boundary.mjs:41-48`, `:228`, `:246-251` |
| **Turn modes:** `session` and `resume` are session-only. `code` and `phase` are authoring (the authoring catalogue). Nine other names are authoring. `next` is kernel-only. Everything else is read. | `src/phase-mutation-contract.mjs:56`, `:81` (catalogue `src/authoring-skills.mjs:28-36`), `:92`, `:27-28`, `:94`, `:98` |
| Authoring turns may edit under the step contract and start sub-agents. Kernel-only and session-only turns get `PHASE_MUTATION_DELEGATION_NOT_ALLOWED`. | `src/phase-mutation-contract.mjs:171-174`, `:191-192`, `:204`, `:222`; `src/copilot-mutation-guard.mjs:2284-2288` |
| Kernel-only turns are told never to inline an authoring skill or edit files. | `src/copilot-mutation-guard.mjs:345-346` |
| **Shell commands:** authoring and kernel-only turns share one rule set (any registered mutation except approve, reject and a person's own steps). Session-only turns may run only `session`, `agent`, `resume` and `workspace use/switch`. | `src/copilot-mutation-guard.mjs:817-867`, `:771-772` |
| `run` with extra positionals or `--repair-on-fault` is denied in every turn. | `src/copilot-mutation-guard.mjs:670-671` |
| A step change during a turn turns an authoring or kernel-only turn into a read turn. | `src/copilot-mutation-guard.mjs:237-239` |
| **Task completion** is requested for the authoring catalogue plus `call`, `implement`, `specify`, `plan`, `verify` and `scenario-repair`. A first argument of `context`, `stage`, `check`, `status`, `show`, `preview`, `prepare` or `publish` turns it off. | `src/copilot-repository-boundary.mjs:59-66` |
| **"Asked for" recording:** words typed after the command are recorded only for `sf-code` and `sf-phase`. Single-step words and Work IDs are excluded; **step names are not**. | `src/asked-for.mjs:21`, `:25`, `:65-70`; `src/copilot-repository-boundary.mjs:24`, `:258-260` |
| A command with no mapped skill falls back to `/sf-next`. | `src/copilot-guidance.mjs:33-36`; `test/copilot-guidance.test.mjs:30` |
| **Which skill writes a step:** code → `/sf-code`; other → `/sf-phase`; deterministic convergence → `/sf-converge`; configured catalogue skill → that skill. | `src/code-delivery-policy.mjs:312-344`, `:367-373` |
| A `prepare` or `phase` route may name only its default skill, `/sf-code`, `/sf-converge` or a catalogue skill. So `/sf-specify`, `/sf-plan`, `/sf-implement`, `/sf-verify`, `/sf-scenario-repair` and `/sf-code-docs` are never issued for step commands. | `src/safe-command-guidance.mjs:380-413`; `test/vscode-refusal-wiring.test.mjs:516-518` |

## 1 Identity, registry and turn

All 14 folders are `plugin/skills/sflow-<name>`. Each frontmatter has:
- `name: sflow-<name>`;
- `agent: agent`;
- `disable-model-invocation: true`.

No frontmatter declares an alias. Delegation is declared only in the registry.

| Command | argument-hint (L6) | registry.yml | Turn | Task completion | "Asked for" | Issued by SFlow as a route |
|---|---|---|---|---|---|---|
| `/sf-code` | `[code-generation focus]` | :111 generative | authoring | yes | yes | Yes: code steps. `phase begin/rollover` → `/sf-code <step>` (`command-skills.mjs:265-266`, `copilot-guidance.mjs:126-129`). Also `decision test-command`, `departure`, `result` (`command-skills.mjs:95`, `:233`, `:235`) |
| `/sf-phase` | `[generation focus]` | :221 generative | authoring | yes | yes | Yes: document steps, and the default for `prepare` and `phase` (`command-skills.mjs:262`, `:268`) |
| `/sf-implement` | `[implementation focus]` | :191 delegation, delegates to sflow-code | authoring | yes | no | Only as the fast-path `sflow implement` (`fast-path.mjs:240-243`) |
| `/sf-specify` | — | :128 generative | authoring | yes | no | The fast-path `sflow specify` (`command-skills.mjs:21`) |
| `/sf-plan` | — | :129 generative | authoring | yes | no | The fast-path `sflow plan` (`command-skills.mjs:22`) |
| `/sf-verify` | `[test scope or environment]` | :274 generative | authoring | yes | no | The fast-path `sflow verify` (`command-skills.mjs:24`) |
| `/sf-call` | `<AGENT-NAME> [focus]` | :168 delegation, delegates to sflow-code | authoring | yes | no | Prose only (`src/commands/call.mjs:102`). The CLI `call` family maps to `sf-call-add` (`command-skills.mjs:154`) |
| `/sf-run` | `[task focus]` | :248 mutation, `kernelModelPolicy: never` | authoring | no | no | The help table only (`command-skills.mjs:74`) |
| `/sf-converge` | — | :132 generative | authoring | no | no | Yes: the fixed writer of deterministic convergence (`code-delivery-policy.mjs:324-325`); `story adjudicate/adjudications/converge` (`command-skills.mjs:431-433`) |
| `/sf-code-docs` | `[file or declaration focus]` | :115 repair | authoring | no | no | Never (only listed in the `phase` family, `command-skills.mjs:139`) |
| `/sf-scenario-repair` | `[approved scenario defect]` | :114 delegation, delegates to sflow-code | authoring | yes | no | Never |
| `/sf-next` | — | :219 mutation, `kernelModelPolicy: conditional` | kernel-only | no | no | Yes: `sync <WORK-ID>` (`command-skills.mjs:248`), the fallback, chat resets |
| `/sf-session` | — | :252 interactive | session-only | no | no | Yes, when no Story is bound; `/sf-session --refresh` (`copilot-guidance.mjs:122-123`) |
| `/sf-resume` | `<WORK-ID> [--fetch]` | :245 interactive | session-only | no | no | Yes, but **bare** `/sf-resume` (`test/command-skills.test.mjs:291`) |

## 2 Arguments, entry and where each stops

| Command | Arguments and their meaning | First command | Where it stops or relays |
|---|---|---|---|
| `/sf-code` | Free text is focus, recorded as "asked for". `<step>` (issued by rollover) is **not** used as a target, because the entry is a bare `phase enter`; it is recorded as an instruction. A single-step word turns off task completion. | `phase enter --compose --for-agent --json` (L12) | No binding: `/sf-session` or `/sf-workspaces`, stop (L12). Not a code step: relay the routes (L20). Unchanged publication: relay `next` and stop (L21). Never submit or approve (L28). |
| `/sf-phase` | as `/sf-code` | as `/sf-code` (L12) | If `effectiveAuthoringSkill` is not `/sf-phase`: relay it and stop (L20). retained-generation: relay `next`. Policy not verified: `/sf-validate` then `/sf-recover` (L20). Code findings go to `/sf-code` (L27). |
| `/sf-implement` | Focus, passed to `/sflow-code` (L17) | `/sf-code`'s entry, by delegation | Runs `/sflow-code` once and stops when it returns. Never publishes or submits again (L17). |
| `/sf-specify` | none; the router names `<PHASE>` (L19) | `specify --json` (L19) | not-routed: relay `next[]`. Recovery first. Approval: stop. The first NOW must be `prepare <PHASE>`, otherwise relay. Not ready: `recover … --phase` (L19-L24). |
| `/sf-plan` | none | `plan --json` (L19) | As `/sf-specify`. Never submit or approve (L27). |
| `/sf-verify` | Test scope or environment. The step is "its Boundary phase" (L19). | `nextsteps --for-agent --json`, then `phase show`, then `phase enter <phase> --compose` (L19-L21) | Stops at recovery, pending publication, approval or completion. Relays a writer other than `/sf-phase`. Never submits (L28, L30). |
| `/sf-call` | `<AGENT-NAME>` is checked against the step's agent (L23-L25). Focus is passed on. | Delegated. **The follower derives `/sf-start`'s entry** (`test/helpers/route-follower.mjs:100-101`). | Code step → `/sf-code`; document step → `/sf-phase` (L18-L19). Wrong agent: start with `/sf-start <WORK-ID> --agent <AGENT-NAME>` (L24-L25). |
| `/sf-run` | "Arguments are authoring emphasis only"; never `--task` (L19) | `nextsteps --for-agent --json`, then `singularity-flow run` (L19) | Asks before `--yes` on submit. At the authoring boundary it loads the returned skill once (L21). Stops at human approval. |
| `/sf-converge` | none; adjudication takes an item ID, a disposition and the person's reason (L21) | `converge --json` (L18) | Deterministic: prepare, adjudicate, publish with `--authored deterministic --channel kernel-generator`, then stop (L21). Rework, amendment or inspection: relay and stop. Model-written: author it (L22). |
| `/sf-code-docs` | File or declaration focus | `status --for-agent --json` (L19) | "this skill documents code steps only" (L19). Never publishes; offers `/sf-code` (L24). |
| `/sf-scenario-repair` | The approved scenario defect plus focus (L16) | `/sf-code`'s entry, by delegation | Delegates once. Retesting belongs to `/sf-scenario-check` (L22). |
| `/sf-next` | none; it uses the bound Story | `nextsteps --for-agent --json` (L11) | Earlier-step chat: relay the chat resets (L18). `ACTIVE_SUBJECT_MISMATCH`. At most one action; decisions are relayed (L19). **On `/sf-code` or any `prepare` route: do not run it, report `Next in Copilot: /sf-code` (L21).** |
| `/sf-session` | none (opens the Story here, or shows a table); `<WORK-ID>`; takeover; `--refresh`; `--workspace W --repository R`, kept exactly (L11, L24) | `session open --for-agent --json` or `session takeover <ID>` (L11) | Asks for an exact ID. "End the turn; do not continue into Story work" (L29). |
| `/sf-resume` | A Work ID or branch (`requirePositional`, `src/commands/shared/start-context.mjs:82`); `--fetch`; `--allow-dirty` | `pause status --json` (L12), then `resume <arguments> --json` (L19) | Relays the chat resets (L21). "Continue only in the active phase" (L25), but the turn is session-only. |

## 3 Standalone meanings

| Command | Standalone meaning today | Contract to keep (REQ-027, AC-019) |
|---|---|---|
| `/sf-code`, `/sf-phase` | None beyond writing the step | Focus text, "asked for" recording, the step argument (to become a target with `PHASE_DRAFT_NOT_ACTIVE` for a step that is not current, `src/phase-entry-context.mjs:50-54`) |
| `/sf-implement` | The fast-path doc calls it the `implement` router; it never runs it (`docs/topics/fast-path-verbs.md:31`) | Focus; delegation to the code author |
| `/sf-specify`, `/sf-plan` | Fast-path routers with milestones (`src/fast-path.mjs:197-283`) | Router checkpoints: `not-routed`, `recovery`, `approval`, `model-generation`, `deterministic-generation` |
| `/sf-verify` | The verification checklist: each AC mapped to evidence, `@ac` tags checked, a verdict recorded (L23-L26) | Scope argument; the checklist |
| `/sf-call` | Runs the user-defined agent the Story was started with; there is no ad-hoc "call any agent" | Agent identity check and its mismatch message |
| `/sf-run` | A guided run of one step: it can submit (with `--yes` after asking), previews the convergence advance and stops at approval (`src/cli.mjs:5991-6038`). Apps use `/sf-run-app`. | No positional task; submit only after asking |
| `/sf-converge` | Kernel-built convergence and the person's per-item dispositions | Adjudication inputs and their record |
| `/sf-code-docs` | Doc comments only; it never publishes | Its no-publish rule (today only the skill text holds it) |
| `/sf-scenario-repair` | Delegation to `/sf-code` that keeps assertions | Retesting stays `/sf-scenario-check`'s |
| `/sf-next` | One lifecycle action: sync, kernel actions, decision and chat-reset relays | Sync and chat-reset behaviour; human decisions relayed |
| `/sf-session` | Selects and attaches a Story | Selectors, takeover, refresh |
| `/sf-resume` | Resumes an explicit target | The required positional; `--fetch`, `--allow-dirty` |

## 4 Error meanings an adapter must keep

| Command | Codes and states |
|---|---|
| `/sf-code` | `CODE_DELIVERY_TEST_COMMAND_REQUIRED`, `successor-confirmation-required`, `not-admitted`, unchanged publication, `ARTIFACT_AUTHORING_INCOMPLETE`, `testRunRisk`, the `/sf-recover` retry (L21-L28); `PHASE_MUTATION_TURN_EXPIRED` naming `/sf-code` (`test/phase-mutation-contract.test.mjs:2971`) |
| `/sf-phase` | `policyVerified`/`policyReason`, writer relay, `retained-generation`, `successor-preparation-required`, `not-admitted`, `ARTIFACT_AUTHORING_INCOMPLETE` |
| `/sf-specify`, `/sf-plan`, `/sf-converge` | The router checkpoints above; `fastpath.not-configured`, `verb-not-configured`, `phase-not-owned`, `publication.pending` (`src/fast-path.mjs:205`, `:223`, `:257`); for converge also adjudication `cancelled` |
| `/sf-verify` | `policyVerified`, writer relay, `ARTIFACT_AUTHORING_INCOMPLETE` |
| `/sf-call` | The agent-mismatch message (it has no code); the delegate's codes are passed through |
| `/sf-run` | The CLI's approval, convergence and submit holds (`src/cli.mjs:5994-6038`); `FAULT_COMMAND_REQUIRED` (`src/fault-repair.mjs:1872`), CLI only |
| `/sf-code-docs` | Not a code step; documentation `complete` or `not-applicable` |
| `/sf-next` | `ACTIVE_SUBJECT_MISMATCH`, `publication_pending` sync, `ARTIFACT_AUTHORING_INCOMPLETE`; `PHASE_MUTATION_DELEGATION_NOT_ALLOWED` with the new-chat review route (`src/copilot-mutation-guard.mjs:2286-2287`) |
| `/sf-session` | `settled` and undo via `/sf-decide`, `remediationPlan`; `SESSION_OPEN_*`, `STORY_TAKEOVER_*` (`src/commands/session-open.mjs:25-111`, `session-takeover.mjs:61-109`) |
| `/sf-resume` | `contextBoundary`; `STORY_SOURCE_CONFLICT`, `REMOTE_BRANCH_NOT_FOUND`, the dirty-tree refusal (`src/commands/shared/start-context.mjs:106-108`, `:126`, `:136`) |

## 5 Tests that pin each command today

| Command | Tests |
|---|---|
| code / phase | `plugin.test.mjs`, `journey-routes.test.mjs:18-42`, `review-next-step.test.mjs`, `scs-m4-asked-for.test.mjs:21-40`, `workflow-task-completion.test.mjs:71-84`, `phase-repair-loop.test.mjs`, `phase-mutation-contract.test.mjs:2161,2971`, `exit-ratchet.test.mjs` with `fixtures/skill-exits.json` |
| implement | `plugin.test.mjs:1361-1389`, `skill-efficiency.test.mjs:40`, `journey-routes.test.mjs:29-30` |
| specify / plan | `plugin.test.mjs:415-436`, `claim-authoring-surfaces.test.mjs:56` |
| verify | `plugin.test.mjs:537-548`, `vscode-refusal-wiring.test.mjs:516`, `nextsteps.test.mjs:223` |
| call | `vscode-user-agent-folder.test.mjs:126-132`, `phase-mutation-contract.test.mjs:1661-1672`, `workflow-task-completion.test.mjs:75,245` |
| run | `plugin.test.mjs:1281-1290`, `phase-mutation-contract.test.mjs:2075-2087` |
| converge | `plugin.test.mjs:675-690`, `phase-mutation-contract.test.mjs:1866-1873`, `authoring-skills.test.mjs:82` |
| code-docs | `plugin.test.mjs:390-392`, `workflow-task-completion.test.mjs:82` |
| scenario-repair | `phase-mutation-contract.test.mjs:1668-1672`, `workflow-task-completion.test.mjs:75` |
| next | `plugin.test.mjs:305-310,341-345,1250-1278`, `direct-skills.test.mjs:110`, `phase-mutation-contract.test.mjs:1675-1690`, `copilot-guidance.test.mjs:30` |
| session | `plugin.test.mjs:931-975`, `native-copilot-efficiency.test.mjs:18-23`, `copilot-guidance.test.mjs:33-42` |
| resume | `plugin.test.mjs:742-744,1459-1470`, `command-skills.test.mjs:283-291`, `copilot-guidance.test.mjs:68` |

## 6 Skills that relay to each other today

| From | To |
|---|---|
| `/sf-phase` | `/sf-code`, `/sf-converge`, `/sf-release` or the configured skill (L20); code findings → `/sf-code` (L27) |
| `/sf-code` | The entry's route for a step that is not code (L20). It also states that `/sf-next` cannot author. |
| `/sf-next` | `/sf-code` or the step's skill, never writing itself (L21). Pinned by `test/plugin.test.mjs:309` and `:341`. |
| `/sf-verify` | Any writer other than `/sf-phase` (L20) |
| `/sf-code-docs` | Offers `/sf-code` (L24) |
| `/sf-resume` | `/clear`, then `/sf-next` (L21) |
| `/sf-call` | Must never name `/sf-next` (`test/vscode-user-agent-folder.test.mjs:129`) |

## 7 Contradictions to resolve (Stage 4 inputs)

1. **`/sf-run`:** the registry gives it a deterministic-mutation contract, but the guard gives it an authoring turn, and L21 loads a writing skill in that turn.
2. **`/sf-code-docs`:** the registry says "Never publish", but its authoring turn allows `phase publish` (`src/copilot-mutation-guard.mjs:867`). Only the skill text forbids it.
3. **`call`, `implement`, `scenario-repair`:**
   - The registry boundary is "machine", but their delegate `/sf-code` needs a Story.
   - `/sf-call`'s registry entry names only sflow-code, but its body also delegates document steps to `/sf-phase`.
4. **The follower resolves `/sf-call`'s delegate to `/sf-start`** (`test/helpers/route-follower.mjs:100-101`). No test catches it: the closure test checks only skills in `COMMAND_SKILLS` (`test/journey-routes.test.mjs:38-41`).
5. **`docs/topics/fast-path-verbs.md:31`** calls `/sf-implement` and `/sf-verify` the Copilot forms of their routers. Neither runs its router; `test/plugin.test.mjs:543` enforces that for verify.
6. **The help table and the route validation disagree.** `src/command-skills.mjs:138-139` lists specify, plan, implement, verify, scenario-repair and code-docs under `prepare` and `phase`, but `src/safe-command-guidance.mjs:380-413` rejects them there.
7. **Step names are recorded as instructions.** The issued routes `/sf-code <step>` and `/sf-phase <step>` put the step name where "asked for" recording reads it (`src/asked-for.mjs:25` does not exclude step names). It must then be accounted for with `departure account` (`src/asked-for-records.mjs:215-216`). No test.
8. **Typed step names are ignored as targets.** The entries are bare (L12), and the follower drops the step (`test/helpers/route-follower.mjs:145`).
9. **Session routes drop targets.**
   - `resume WORK-123 --fetch` is issued as a bare `/sf-resume` (`test/command-skills.test.mjs:291`).
   - `session open … --workspace/--repository --refresh` is issued as `/sf-session --refresh` (`test/copilot-guidance.test.mjs:35-38`), although the session skill keeps the selectors.
10. **`/sf-resume` L25 asks for work its turn forbids.** L25 says to continue in the active step, but session-only turns must end (`src/phase-mutation-contract.mjs:191-192`). `/sf-session` and `/sf-resume` use different CLI paths (`session open/takeover` against `resume`).
11. **D2 is held back in three places.** The kernel-only `/sf-next` cannot write, and the skill text, the guard and the tests all hold that.
12. **`next` means two things.** `/sf-run` calls `singularity-flow run`, which runs `nextCommand` (`src/cli.mjs:6003`), while `/sf-next` forbids `singularity-flow next` (L19).
13. **The aliases are not equivalent to `/sf-code`.**
    - Focus typed after `/sf-implement`, `/sf-call` or `/sf-scenario-repair` is not recorded as "asked for".
    - `/sf-run`, `/sf-converge` and `/sf-code-docs` get no task completion.
14. **There are two "is this a code step" tests.** `/sf-code-docs` checks `generationPolicy.task: code` (L19); `/sf-code` uses `generatesCode`, which also accepts a code artifact kind (`src/code-delivery-policy.mjs:202-207`).
15. **The delegation mechanism is unspecified.** The canonical skills have `disable-model-invocation: true`, and the aliases say "Run" or "Delegate once". The only tested mechanism is a `task` sub-agent inside the alias's authoring turn (`test/phase-mutation-contract.test.mjs:1666-1671`).

## 8 Compatibility tests AC-019 still needs

Nothing pins these invocations today:
- `/sf-code <step>` and `/sf-phase <step>`, for target binding and "asked for" recording;
- `/sf-phase` on a code step, and `/sf-code` on a document step, end to end;
- `/sf-call` with no name, and with a mismatched name; the follower's `/sf-call` entry;
- `/sf-verify` on a step that is not a verification step;
- a bare `/sf-resume`; `/sf-session --refresh` with selectors;
- `/sf-run` at the authoring boundary;
- fast-path verbs in work types without a fast path.

## What to reuse, and what is missing

**Reuse:**
- the turn-mode table, which becomes the role map from skill to principal role;
- `generationSkillForPhase`, which becomes the step's work command in the host map;
- the safe-command validator, kept as an explicit validator;
- `COMMAND_LINE_SKILL_ROUTES`, which becomes the versioned action-to-command map, with the help table brought into line.

**Missing:**
- a step target argument for `/sf-code` and `/sf-phase`;
- an authoring turn for `/sf-next`'s current-step work (D2, REQ-025);
- one session-opening path for `/sf-session` and `/sf-resume`;
- a stated delegation mechanism for the aliases;
- AC-019's compatibility tests (§8).
