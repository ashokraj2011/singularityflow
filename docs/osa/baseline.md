# OSA Stage 0 — baseline manifest

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md), section 13 Stage 0 and plan section 2.
**Recorded:** 16 November 2026.
**Status:** Stage 0 record. It claims no Stage 1 work.

The other Stage 0 records are listed in [README.md](README.md).

## 1 Starting commit and worktree

| Item | Value |
|---|---|
| Branch | `osa-s0`, a separate OSA branch. The Engine SDK branch `codex/engine-sdk-foundation` was not merged, read or modified. |
| Starting commit | `d7a976821` "SPEC-OSA v1.1: the revised one-step-author spec". |
| What the starting commit contains | main `6343414ae`, plus the one-click direct upgrade (merge `5c9e03923`), the 2026-11-16 batch (merge `b0f271f08` with its budgets `f94293919` and `7d22580da`), OSA v1 stage 1 (merge `f43ff5615`) and the v1.1 specification. |
| Worktree at start | Clean: no staged, unstaged or untracked files. |
| main since then | main moved to `ea398577f`, which adds two test-wording fixes (`4fdba2151`, `9ce7b5742`) and the session-current budget `4,273,500` (`ea398577f`). It is **not merged** here, on the coordinator's instruction. Stage 1 starts from main or merges it. |

Two targeted tests fail at `d7a976821`, and main fixes both. Stage 1 must start from a commit that contains `ea398577f`.

| Test | Failure at `d7a976821` | Fixed on main by |
|---|---|---|
| `test/lazy-command-handlers.test.mjs` | The session-current closure measures 4,273,495 bytes against its 4,273,400 ceiling | `ea398577f`, which sets the ceiling to 4,273,500 |
| `test/refusal-story-next.test.mjs`, "the decision list for a step the Story lacks" | The test expects `prepare`; the merged code (from `6343414ae`) routes to the decision list for the current step | `9ce7b5742`, which makes the test assert that route |

## 2 Verified prerequisites

**What "verified" means:** every commit below is an ancestor of `d7a976821` (`git merge-base --is-ancestor`, checked for all 51). The "Reproduced by" column names the test files each change added or changed.

Stage 0 re-ran none of these suites except the targeted files listed in [README.md](README.md). The owner's rule of 16 November is that heavy runs come at the end. The batch integration recorded its slow journeys A–E passing with no todo; that is the integration's record, not a Stage 0 run.

| Prerequisite | Commits | Merged as | Reproduced by |
|---|---|---|---|
| review-next | `fb368d49b` | `94f68ff86` | `test/review-next-step.test.mjs`, `test/review-every-step-cli.test.mjs`, journey B |
| kernel-step-route | `5baaba5d1` | `199c65df8` | `test/kernel-step-routes.test.mjs`, journeys A and B (Verify) |
| turn-renew | `7436ec3ff` | `487f0ea09` | `test/copilot-turn-renewal.test.mjs`, journey E |
| refusal-next-step | `1cfb2c986`, then `7a2bbf482` (open next version, on the batch) | `833da4c1b` | `test/refusal-story-next.test.mjs`, `test/refusal-epic-next.test.mjs`, journey C |
| chat-prefill | `483b58ab2`, `5bf807851`, `a260ab766` | `8f2a72a0c` | `test/vscode-chat-prefill.test.mjs`, `test/copilot-hook-launcher.test.mjs` |
| decisions-clarity | `c1070ae42`, `75f33a66e` | `ed625f1f9` | `test/decision-card-plain-words.test.mjs`, `test/decision-advice.test.mjs`, `test/copilot-cli-decide-card.test.mjs` |
| plain-language | `840e3fc2d`, `8c68a0b14`, `8ac43fb0f` | `558cb92cb` | `test/plain-language.test.mjs` (baseline `benchmarks/plain-language/baseline.json`) |
| journey-tests | `417d14e29`, `1f275b252`; KNOWN_BAD emptied `adc9e90e5` | `5d27c41c8` | `test/journey-routes.test.mjs`, `test/journey-stories.test.mjs` |
| reset-keeps-checkouts | `fde832f41`, `2b4e387d7`, `c53927fd4` | `1522efebe` | `test/factory-reset.test.mjs`, `test/story-worktree.test.mjs` |
| upgrade-direct | `3ba178073`, `e0273f760`, `c41473184`, `cf05ae4d2` | `5c9e03923` | `test/configuration-history-removed.test.mjs`, `test/workspace-configuration-refresh.test.mjs`, `test/agents-home.test.mjs` and others |
| review-visual-evidence | `1dfce60d0`, `197f25f31` | on main before `6343414ae` | `test/review-visual-evidence.test.mjs` |
| OSA v1 stage 1 (stop the loops) | `13066fe33`, `f749b5fed`, `4787ce1ef`, `e5570c373`, `3c998fbed`, `322fca509`, `ce1b89ecc`, `6ac7dff21`, `f5f9c9460` | `f43ff5615` | `test/step-being-written.test.mjs`, `test/step-routes-stage1.test.mjs`, journeys F and G |
| 16 November hotfixes | `e1574fa2d` (review record after a rollover), `95e25ed06` and `651086f40` (review inputs after a rollover), `56dfa031e` (successor edit permission), `01361a0ca` and `6343414ae` (misspelt step names) | on main | `test/review-every-step-cli.test.mjs`, `test/unknown-step-refusals.test.mjs` |

**What OSA v1 stage 1 delivered (it counts in this baseline and is not redone):**

| v1.1 baseline item | Commit | Where |
|---|---|---|
| One "being written" test | `13066fe33` | `stepBeingWritten` in `src/phase-generation-need.mjs:45`. Its nine replacement sites are listed in [decision-inventory.md](decision-inventory.md) §2. |
| The entry follows the permission | `f749b5fed` | `src/agent-output.mjs:487-491` |
| No recover fallback | `4787ce1ef` | `src/phase-mutation-contract.mjs:112` and `:194-198`; `src/review-continuation.mjs:42-50` |
| Step commands name the work command | `e5570c373` | `src/command-skills.mjs:266`, plus the refusal `nextAction` objects |
| Submit refuses while a version is open | `13066fe33` | `PHASE_VERSION_BEING_WRITTEN` at `src/state.mjs:5614-5620` |
| No containment beside a refusal that writes the step | `3c998fbed` | `src/refusal-remediation.mjs:219` |
| sflow-code text | `322fca509` | `plugin/skills/sflow-code/SKILL.md:21` |
| Journeys through the guard, plus journeys F and G | `ce1b89ecc` | `test/helpers/route-follower.mjs` (`guardedStory`, `personViews`), `test/journey-stories.test.mjs` |

**Outstanding dependencies at Stage 0:** these KNOWN_BAD entries are still open in `test/helpers/journey-scripts.mjs`:

| KNOWN_BAD entry | What it covers | Stage |
|---|---|---|
| `osa-stage-2` | Journey F: "Start version 3?" is never asked after rework | 2 |
| `osa-stage-3` | Journey G: the validation offer `/sf-outcome` against the views | 3 |
| `osa-stage-3-c9` | Journeys A and B: a kernel-built step's publication is handed to `/sf-publish` | 3 |
| `osa-stage-3-refusal` | Journey D: the failed-test card against the views | 3 |

## 3 Supported runtimes

| Runtime | Role | Source |
|---|---|---|
| Node 22 (22.14.0 on this machine, `/opt/homebrew/opt/node@22`) | Every landing is tested on it (owner's rule of 16 November; spec section 14). Stage 0's targeted runs and its performance baseline used it. | `package.json` `"engines": { "node": ">=22" }` |
| Node 26 (26.12.0, the managed runtime) | The full suite runs on it weekly. A stage is complete only after the weekly Node 26 run that follows it passes. | `distribution/node-runtime.lock` (darwin/linux/win32, 26.12.0); the hook launcher prefers `node-v26.*` from the managed runtime (`plugin/hook-launcher.sh:215-218`) |
| Host | Mac only (darwin arm64, 10 CPUs, 24 GiB). Windows, hosted CI and live Copilot runs are outside implementation qualification. The live Copilot row is the owner's daily paid Story run. | spec section 14 |

Optional newer runtime APIs: Node 22.14 has no `module.registerHooks`. The performance baseline therefore counts modules with `module.register`, which is available on 22.

## 4 Existing ceilings

These are the ceilings OSA must not raise to pass (AC-022, plan Stage 5). The "measured" values were taken at `d7a976821` by Stage 0 with the same graph walk the test uses.

**Lazy command handlers** (`test/lazy-command-handlers.test.mjs`)

| Ceiling | Value | Measured at `d7a976821` | Slack |
|---|---|---|---|
| Lifecycle handlers' eager files (start, session, choices, inputs, prepare, review-source, submit, approve, phase-lifecycle) | ≤ 473 files (`:75`) | `commands/submit.mjs` 470 (the largest) | 3 files |
| Lifecycle handlers' eager source bytes | ≤ 9,694,550 (`:663`) | `commands/phase-lifecycle.mjs` 9,688,981 (the largest) | 5,569 bytes |
| Root dispatch (`cli-entry.mjs`) | ≤ 40 files (`:672`), ≤ 869,150 bytes (`:772`) | 39 files, 868,734 bytes | 1 file, 416 bytes |
| Session current | ≤ 221 files (`:791`), ≤ 4,273,400 bytes here, 4,273,500 on main (`:1029`) | 221 files, 4,273,495 bytes | 0 files; over by 95 bytes here, 5 bytes of slack on main |

These closures already contain `phase-generation-need.mjs`: start, session, choices, inputs, prepare, review-source, submit, approve, phase-lifecycle, session current, nextsteps and phase-entry. Root dispatch and `copilot-hook-runtime.mjs` do not.

**Cold CLI bundle** (`test/cli-bundle.test.mjs`, `scripts/build-cold-cli-bundle.mjs`)

| Ceiling | Value |
|---|---|
| Coarse chunks | ≤ 21 outputs (`:93`; also enforced by `src/bundled-cli.mjs`) |
| Hook bundle | ≤ 8 MiB and ≤ 650 modules (`:105-106`) |
| CLI and hook cold parse | < 3 MiB each (`:107-108`) |
| Bundled CLI command | ≤ 28 module files; `--version` ≤ 8 (`:611-612`) |
| Bundled hook action | ≤ 16 module files, and no compatibility chunk (`:704-705`) |
| hook-context chunk (phase-review reads) | < 7,750,000 bytes (`:451`) |

The families decide which chunk a module lands in; the first family that reaches a module statically claims it. `stepBeingWritten`, `nextPhaseGeneration` and `generationSkillForPhase` land in `cold-core.mjs` today, and `deriveMutationContract` in `cold-hooks.mjs`.

**VS Code bundle** (`benchmarks/dx/vscode-bundle-budgets.json`)

| Ceiling | Value |
|---|---|
| Total JavaScript | ≤ 28,900,000 bytes |
| `extension.cjs` | ≤ 1,446,000 bytes, ≤ 155 modules |
| `gateway-runtime.cjs` | ≤ 7,730,000 bytes, ≤ 882 modules |
| `lazy-panels-runtime.cjs` | ≤ 3,556,148 bytes, ≤ 316 modules |
| `help-runtime.cjs` | ≤ 670,000 bytes, ≤ 136 modules |
| `support-runtime.cjs` | ≤ 455,000 bytes, ≤ 111 modules |
| `runtime-prewarm.cjs` | ≤ 114,803 bytes, ≤ 25 modules |
| Smaller runtimes | as listed in the file |

**Other bounds that are tested**

| Bound | Value | Where |
|---|---|---|
| AST ratchets | Must not grow | The plain-language baseline (`benchmarks/plain-language/baseline.json`), the GAL Git bypass baseline (`scripts/git-bypass-baseline.json`), the SDA inventory (`benchmarks/sda/inventory.json`) and the source-inspection ratchet |

**Test timeouts and deadlines**

| Timeout or deadline | Value | Where |
|---|---|---|
| Copilot hooks | 10 s each (`timeoutSec`) | `plugin/hooks.json` |
| Copilot turn window (`MAX_AGE`) | 30 min; renewed only by a delivered person's answer | `src/copilot-mode.mjs:204` `TURN_WINDOW_MS`; `src/copilot-mutation-guard.mjs:31` |
| Test child processes | `childTimeout(ms)`: ×4 (`SINGULARITY_FLOW_TEST_TIMEOUT_SCALE`) for limits of 10 s or more, capped at 10 min | `test/helpers/child-timeout.mjs` |
| Slow lane | Tests of 30 s or more, or declaring 120 s or more, run only with `SINGULARITY_FLOW_TEST_SLOW=1` | `test/helpers/slow-lane.mjs` |
| Journey timeouts | A 1,800 s, B 1,200 s, D 1,200 s, E 900 s, F 1,800 s, G 1,200 s | `test/journey-stories.test.mjs` |
| Aggregate runner | 16 shards, 4 workers, 30 min shard deadline | `scripts/run-test-aggregate.mjs` |
| Read worker | at most 2 workers and 64 requests; 300 s maximum age, 60 s idle | `src/read-worker-client.mjs` |

## 5 Kernel location

See [kernel-location.md](kernel-location.md).
