# SPEC-SFG v1 — SF Guard, part 2: agent and skill provenance

**Status:**
- **Decided:** 1 November 2026 (D1-D5, §13).
- **G0:** done in the Copilot CLI (1.0.105) and in VS Code (1.144), all but the `Local` session target (§1.1).
- **G1:** built. Recording, REQ-020 to REQ-024 (§5.1 says what was built).
- **G2 to G5:** not built.

**Part 1** is [SPEC-PSS v1](SPEC-PSS-v1-PRESENCE-SIGNED-STEPS.md): presence-signed person steps, M1 built. Both parts are SF Guard. Clause IDs here are `[SFG:…]`; `[PSS:…]` refers to part 1.

**Grounded on:** main `da52dc766`. Every `file:line` refers to that commit.

**The user's decisions (1 November 2026):**
- SF Guard covers **both halves**: people sign their person-only steps (part 1), and the work agents do is attributed (this part).
- Work by an agent or skill the workflow does not declare is **allowed but labelled**, never refused. "Nothing should get blocked."
- With SF Guard on, attribution covers the **whole repository**, not only Story work.

## 0. Summary

When a repository turns SF Guard on, every file edit and shell command Copilot makes there is recorded with the Copilot session, the agent and the skill it came from, and the Story and step it belongs to. Changes that no recorded Copilot call explains are labelled "unattributed". Each change is classed as:
- declared by the workflow;
- outside the workflow (agent X, skill Y);
- unknown;
- unattributed.

The labels appear wherever a person decides: in review packets before approval, in the final check (advisory), in receipts, in `guard status`/`guard report` and in VS Code. They are bound into the review packet the person signs (part 1), so an agent cannot change them afterwards without detection. Nothing is refused for being off-workflow. Person-only steps stay refused for agents exactly as today (1a3f18d56, e9fd1a04a).

Honest headline, after G0 (§1.1):
- **Skills:** Copilot CLI shows them as a `skill` tool call (`toolArgs.skill`), whether the person typed `/skill` or the model loaded it by itself.
- **Subagents:** a subagent's own calls carry `agentId`, `agentType` and `parentAgentId`.
- **The top-level agent:** Copilot never names it in a payload. It is known only because its agent-scoped hooks fire, which is D4's stamping hook.

Attribution is therefore strong evidence, not proof. §3 says exactly where it can be fooled.

## 1. Ground truth: what Copilot tells SFlow

**Sources:**
- the Copilot CLI hooks reference (Sources);
- the VS Code hooks guide (Sources);
- SFlow's hook code;
- the live probe of 18 October 2026 (VS Code agent host, Copilot 1.0.95): hook stdin was `{ sessionId, timestamp, cwd, toolName, toolArgs }`, one call per run (memory note "batched preToolUse");
- the ACP transcripts of the 1 November live runs.

SFlow registers five hooks: `userPromptSubmitted`, `preToolUse` (all tools), `postToolUse` (shell tools only), `sessionEnd` and `subagentStart` (`plugin/hooks.json:4`, `:7`, `:10`, `:13`, `:16`), each with a 10 s timeout.

| Signal | Surface | Carries | Class |
| --- | --- | --- | --- |
| `sessionId` / `session_id` on every hook | CLI, VS Code agent host | which Copilot session | **Reliable**: written by the host, which the agent can't alter. It is used as a key (`src/copilot-repository-boundary.mjs:25`) |
| `toolName`, `toolArgs` on `preToolUse`/`postToolUse` | CLI, VS Code agent host | what each call does | **Reliable** for what Copilot reports. A script's own writes are invisible |
| Agent or skill on `preToolUse`/`postToolUse` | CLI (G0); VS Code pending | inside a subagent: `agentId`, `agentType` (the agent's name), `parentAgentId` (the parent's `sessionId`); a skill load as its own call, `toolName: "skill"`, `toolArgs.skill` | **Reliable** (G0): the host writes them. Top-level calls carry no agent field. The `skill` call records that a skill was loaded, not that it was followed |
| `subagentStart` `agentName` (+ `agentDisplayName?`) | CLI | the spawned subagent's name | **Reliable** that the host started that agent. The model picks which one, by name. Read at `src/agent-hooks.mjs:55-57` |
| Top-level agent picked with `--agent` or VS Code's agent picker | CLI (G0); VS Code pending | — | **Absent** (G0): on no event, not in the environment. `subagentStart` fires only when a subagent is spawned, never for the `--agent` selection, so the comment at `src/agent-hooks.mjs:80` is wrong. Known only through D4's agent-scoped hooks |
| Agent-scoped hooks (`hooks` in `.agent.md` frontmatter) | CLI (G0); VS Code documented, pending | every event of that agent: `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `subagentStart`/`subagentStop`, `agentStop` | **Reliable** (G0): they fire for the agent selected with `--agent` and when that agent runs as a subagent, and never for another agent's calls. **Spoofable** if an agent rewrites agent files on disk (§3), hence the drift label |
| `userPromptSubmitted` `prompt` | CLI, VS Code agent host, ACP clients | the text a turn starts with | **Reliable only without `agentId`** (G0). A subagent's task text, which the parent model wrote, also arrives as `userPromptSubmitted`, carrying `agentId`. Prefer the `skill` tool call for skill identity |
| A skill the model loads mid-turn | CLI (G0); VS Code pending | `toolName: "skill"`, `toolArgs: { skill }` | **Reliable** (G0): the same call as a slash-invoked skill. The model chooses to load it |
| ACP `session/new` `modes` | ACP clients | agent, plan or autopilot mode only | Reliable, but no custom-agent identity |
| VS Code LM tool calls (`#sflow…` tools) | VS Code extension | input and an opaque `toolInvocationToken` | Reliable that the call came from VS Code chat. **Agent absent** (`apps/vscode/src/extension.ts:793`, `apps/vscode/src/workflow-intent-runtime.ts:35`) |
| `@sflow` participant requests | VS Code extension | `command`, `prompt` | Reliable for the participant's own commands. No agent picker identity (`apps/vscode/src/sflow-chat.ts:1349-1351`) |
| Copilot telemetry spans (`invoke_agent`) | CLI, VS Code | agent spans | **Excluded**: the user's rule "no telemetry in the work path", and it needs settings consent |
| SFlow's own stored records (turn records, `session.json`, observed writes) | machine-local | everything above, after the fact | **Spoofable**: files the agent's OS user can write (§3) |
| Git working tree and commits | repository | what changed | **Reliable** for content. Says nothing about who made a change |

**[SFG:REQ-001] Probe before building.** G0 runs a logging hook (key names and lengths only, never values) in a throwaway repository. It records which of the absent and conflicting rows above actually carry identity on the user's Copilot CLI version and in VS Code: a top-level `--agent` session, a picker-selected custom agent, a subagent, an agent-scoped hook, and a skill invoked by slash versus loaded by the model. The design below works either way. If identity is absent, the label says "agent unknown", never a guess.

### 1.1 G0 results (1 November 2026)

**Setup:**
- Copilot CLI 1.0.105, one pinned model, in a throwaway repository.
- An isolated `COPILOT_HOME` holding only the account fields; the token stayed in the keychain, and the home was deleted after the probe.
- Three hook sources:
  - a user hook in `$COPILOT_HOME/hooks`;
  - a repository hook in `.github/hooks`;
  - agent-scoped hooks in `alpha.agent.md`.

  Each logged key names and identity fields only, always allowed, and never changed a call.
- Two custom agents, `alpha` (scoped hooks) and `beta`, and one skill, `probe-skill`.

**Runs** (6 premium requests in total; a subagent added none):
- `--agent alpha` delegating to `beta`;
- `/probe-skill`;
- a prompt that makes the model load the skill;
- an ACP session with two turns;
- a resumed session.

| Signal | Surface | Observed | Fields |
| --- | --- | --- | --- |
| Top-level agent on any event | CLI `--agent` | **No** | top-level payloads carry only the base fields below |
| `subagentStart` for the `--agent` selection | CLI | **No**, only for spawned subagents | `agentName`, `agentDisplayName`, `agentDescription`, `agentId`, `agentType`, `parentAgentId`, `transcriptPath` |
| Agent-scoped hooks, agent selected with `--agent` | CLI | **Yes**, every event | the same payloads as user hooks |
| Agent-scoped hooks, the same agent run as a subagent | CLI | **Yes**, and never for another agent's calls | the subagent payloads, below |
| Calls inside a subagent | CLI | **Yes**, identity on every event | `agentId`, `agentType` (= agent name), `parentAgentId` (= parent `sessionId`) |
| Subagent's own `sessionId` | CLI | a new id per subagent | — |
| Skill by `/probe-skill` | CLI | **Yes** | `preToolUse`/`postToolUse` `toolName: "skill"`, `toolArgs.skill: "probe-skill"`; the prompt is the raw `/probe-skill`, and `transformedPrompt` adds only `<current_datetime>`, with no `<skill-context>` |
| Skill loaded by the model, unnamed in the prompt | CLI | **Yes**, the same `skill` call | as above |
| Subagent task text as `userPromptSubmitted` | CLI | **Yes**, with `agentId` | so a prompt carrying `agentId` is model-written |
| `sessionId` across turns, one session | ACP | stable | — |
| `sessionId` after `--resume` | CLI | **stable**, `sessionStart.source: "resume"` | — |
| `sessionEnd` | ACP | fires after **every prompt**, not once per session | `reason: "complete"` |
| `/agent alpha` over ACP | ACP | **not a command**: it went to the model as text | — |
| In-session `/agent` switch | CLI TUI | **Not tested**: the terminal UI couldn't be driven headless | — |
| Agent identity in the hook environment | CLI | **No** | `COPILOT_CLI`, `COPILOT_CLI_BINARY_VERSION`, `COPILOT_CLI_RESOLVED_DIST_DIR`, `COPILOT_HOME`, `COPILOT_HOOK_DIR` (the directory of the config that fired), `COPILOT_PROJECT_DIR` |
| Repository hooks | CLI | fire once the folder is trusted (`--trust-folder` or `trustedFolders`) | — |

**Base fields seen:**
- `sessionStart`: `sessionId, timestamp, cwd, source, initialPrompt`
- `userPromptSubmitted`: `+prompt`
- `userPromptTransformed`: `+prompt, transformedPrompt`
- `preToolUse`: `+toolName, toolArgs`
- `postToolUse`: `+toolName, toolArgs, toolResult`
- `agentStop`: `+transcriptPath, stopReason, stop_hook_active`
- `sessionEnd`: `+reason`

**Consequences for the design:**
- Agent-scoped stamping (D4) works in the CLI. Because a declared agent's scoped `preToolUse` fires for each of its own calls, it can stamp every call, not only the session.
- A subagent is named by the host on every call. The top-level agent is named only through its stamp, and an unstamped top-level session is "agent unknown".
- The skill is the last `skill` call before the change in that `sessionId`. A prompt carrying `agentId` is never read as the person's.
- An ACP `sessionEnd` must not close SFlow's session record. Today's `sessionEnd` hook treats it as the end of the session.
- **Still open:**
  - VS Code. Its Copilot harness reads the same hook files and agent-scoped hooks (the VS Code hooks guide); the results below confirm it.
  - The in-session `/agent` switch.

**VS Code results (1 November 2026, VS Code 1.144), first turn (1 premium request).** The session target was Copilot, and the hook environment showed `AI_AGENT=github_copilot_vscode_agent` and `COPILOT_EXP_COPILOT_CLI_*`.

| Signal | Surface | Observed |
| --- | --- | --- |
| Repository hooks (`.github/hooks`) | VS Code, Copilot target | **Fire**, with the CLI's base fields: `sessionStart` (source `new`), `userPromptSubmitted`, `preToolUse`/`postToolUse`, `agentStop` (`end_turn`) and `sessionEnd` (`user_exit`) |
| Skill loaded by the model | VS Code | **Yes**, the same as the CLI: `toolName: "skill"`, `toolArgs.skill: "probe-skill"` |
| Tool names | VS Code, Copilot target | `bash`, `glob`, `apply_patch`, `skill`, the CLI's own set |
| Agent identity for the default agent | VS Code | **No**, the same as the CLI |
| `sessionId` reuse | VS Code | A `sessionEnd(user_exit)` when the window opened, then `sessionStart(source: new)` 16 minutes later, both with the **same** hashed `sessionId`. Per-session maps ([SFG:REQ-022]) must key on the session plus its start, not the id alone |

- **Session target `Local`:** not tested.
- **A second turn** used 1 more premium request.
  - The agent picker stayed on the default agent. The person answered Copilot's `ask_user` question, which is visible to hooks as `toolName: "ask_user"` and works in VS Code, unlike over ACP. Copilot then ran `echo after-switch` in the same session.
- **Third turn, with `alpha` picked in the same chat (1 premium request): agent-scoped hooks CONFIRMED in VS Code.**
  - `alpha.agent.md`'s own hooks fired on every event of that turn: `userPromptSubmitted`, each `preToolUse` and `postToolUse` (`skill`, `bash`, `apply_patch`), and `agentStop`. Each fired next to the matching repository hook, with the same payload fields.
  - The switch kept the **same `sessionId`**, and no `sessionStart` fired at the switch. So the stamp has to be read per call, or per prompt, never only at `sessionStart`. That is what [SFG:REQ-020] already does.
  - Still untested in VS Code: the `alpha` → `beta` subagent, and the `Local` session target.
  - D4 (stamping hooks) is confirmed on both surfaces.
- **Two runs started through VS Code's own buttons (a prompt file and a skill, 2 premium requests).**
  - **Subagents in VS Code: CONFIRMED, the same as in the CLI.**
    - The parent's `preToolUse` is `toolName: "task"` with `toolArgs.agent_type: "beta"`.
    - `subagentStart` carries `agentName`, `agentDescription`, `agentId` and `parentAgentId`.
    - Every subagent event carries `agentId`, `agentType: "beta"` and `parentAgentId`, under the subagent's own `sessionId`.
    - The subagent's task arrives as `userPromptSubmitted` with `agentId`.
    - `subagentStop` closes it.
  - **A subagent loads skills itself:** `beta` invoked `subagent-probe` on its own. So the skill is per subagent session, which [SFG:REQ-024] must use.
  - **VS Code's expanded skill prompt:** when a skill is invoked explicitly, VS Code's Copilot target sends "The user explicitly invoked the "/X" skill" with `<skill-context name="X">` in `userPromptSubmitted`, unlike the CLI. So the skill is visible in the prompt there as well as in the `skill` tool call.
  - **Agent chosen when the chat opens:** with `alpha` picked before the chat began, its scoped `sessionStart` fired too.
  - **Prompt files:** a VS Code prompt file (`.prompt.md`) run on the Copilot target arrives only as the text `/name`. Its body and its `agent:` front matter are not applied.
  - **Skipped tool calls:** a tool call the person skipped logs `preToolUse` with no `postToolUse`. Attribution must treat a missing post as "not run".
  - **Still untested:** the `Local` target. Runs started on Local reopened on the Copilot target.

## 2. What today's code already does

- **Turn records exist only for explicit SFlow turns.** A turn record is written only when the prompt names an SFlow skill (`src/copilot-repository-boundary.mjs:101-128`, skill detected at `:107`). Outside one, a plain or paused prompt has only the person-step check, and every other call passes untouched (`src/copilot-repository-boundary.mjs:138-143`, `:159-166`; `src/copilot-mutation-guard.mjs:1509-1511`).
- **Observed writes are also explicit-turn only.** The XPL2 recorder captures each allowed edit's paths, byte digests and argument-explained lines, with writer `{ kind: 'copilot-turn', session, turn, skill, agent }`. It runs only inside explicit turns (`src/copilot-mutation-guard.mjs:1474-1497`). The store keeps one JSONL segment per day under `<git dir>/singularity-flow/xpl2/observed-writes/`, holds 14 days, is discardable and "never authority" (`src/comprehension/xpl2/observed-writes.mjs:1-6`, limits at `src/comprehension/xpl2/observed-write-recorder.mjs:20-24`). Its one reader is `explain --subject line` (`src/comprehension/xpl2/line-writer.mjs:49`).
- **The agent binding is one per checkout, not per Copilot session.** `session.json` lives at `.git/singularity-flow/session.json` (`src/session.mjs:30`). `subagentStart` overwrites its `nativeCopilotAgent` and, for an author agent, its `agent` (`src/session.mjs:162-179`). Two Copilot sessions in one checkout share it.
- **Draft ownership is that binding.** A draft counts as `governed-agent` when the checkout's session names this Story and step (`src/phase-draft-check.mjs:76-98`). It shows which agent was selected, not which agent typed.
- **Labels already have a precedent.** Picking an agent whose `phases` don't include the step is allowed, and records `phaseCompatibilityOverride` (`src/session.mjs:130-150`). A Copilot agent with no Flow mapping is recorded "for audit" (`src/agent-hooks.mjs:101-105`).
- **Related, open:** in the live reruns, agent-written drafts were offered `--authored human --channel manual-in-place`. It is investigated on its own; attribution would expose that mismatch by itself (§7).

## 3. Threat model and honest limits

**[SFG:CON-001] What attribution can see:** every tool call Copilot reports to the hooks, with its host-provided session. Plus whatever agent and skill identity §1 marks reliable.

**[SFG:CON-002] What it cannot prove,** stated wherever labels are explained:
- An agent that writes through a script or another program (`node fix.mjs`, `python -c …`) shows up as one shell command plus a Git change. Reconciliation (§6) still makes the change visible, as the shell command's or as "unattributed". It is never credited to a declared agent's edit tool.
- Changes by non-Copilot tools, other IDEs or the person are "unattributed", never "person". Only a presence signature (part 1) proves a person.
- An agent can rewrite SFlow's machine-local records: turn records, `session.json`, observed writes. A forged record can claim a declared agent wrote lines it didn't. Mitigation: records are settled against file bytes (only argument-explained lines count as verified, `observed-write-recorder.mjs:1-11`), and they are frozen into the signed packet at submission (§8). Records written by a patched or replaced SFlow can't be detected locally; part 1's remote check is the backstop for the signed parts only.
- An agent can write an agent file that copies a declared agent's agent-scoped hook. Mitigation: `sessionStart` and `subagentStart` compare the on-disk declared agent files with the approved catalog's `agentSha256` (recorded at `src/session.mjs:148`), and label the session "agent files changed" on a mismatch.
- With SFlow paused (`~/.singularity-flow/copilot-mode.json`, `src/copilot-mode.mjs:63-66`) no turn records are made. With SF Guard on, recording continues while paused, and the label says "paused".

**[SFG:CON-003] "No agents can bypass".** The labels a person signs over can't be removed or changed without breaking that signature (§8). Labels never refuse, so there is nothing to bypass. What an agent could do is mislead the labels *before* submission. CON-002 bounds how far, and the Git reconciliation keeps every changed line visible however it was written.

## 4. What "declared by the workflow" means

**[SFG:REQ-010] For a Story step,** these are declared:
- the step's agent: `defaultAgent`, from the catalog's `defaultFor` (`src/config.mjs:1965`), or another catalog agent whose `phases` include the step (`src/session.mjs:122`, `:130`);
- APM agents listed for the step (`apm.agents.<id>.steps`/`defaultFor`, `schemas/workflow-definition.schema.json:562-578`);
- user-defined agents (`/sf-call`) the Story's catalog pins;
- the Story's pinned skills: skill-kind steps' `skillBinding` (`schemas/workflow-definition.schema.json:733-734`), the step's `authoringSkill` (`:510`, `:841`), and attached skills (`attachments.yml`). Pinning is already checked (`src/state.mjs:9483-9486`);
- SFlow's own skills and bundled agents (`sflow-workflow`, `sflow-utility`, `sflow-source-reviewer`, `src/copilot-repository-boundary.mjs:20`), in their turn modes;
- MCP tools listed for the agent and step (`templates/workflow.yml:381-396`).

**[SFG:REQ-011] Outside a Story (whole repository),** these are declared:
- any agent in the approved configuration's catalog, including APM and user-defined agents;
- any skill in its approved skill library or attachments;
- SFlow's own skills.

The Story-specific rules don't apply there.

**[SFG:REQ-012] Not declared,** labelled "outside the workflow":
- any other custom agent (for example from `~/.copilot/agents` or another plugin);
- any other skill;
- a catalog agent working on a step it isn't listed for;
- plain Copilot with no custom agent and no skill (decision D1).

A Copilot agent mapped to a Flow agent through `agent-mappings.yml` (`templates/agent-mappings.yml`) counts as that Flow agent.

### 4.1 As built (G2)

- **The declared set:** `src/presence/declared-set.mjs`, pure. `sfGuardDeclaredSet({ agents, librarySkills, mappings, phase })` takes the configuration's agent catalog (repository, APM, user-defined, plugin and bundled agents alike).
  - **For a step:** the agents listed for it (its `phases`, `defaultFor`, an agent with no phases, or the step's `defaultAgent`), SFlow's own agents, the step's `authoringSkill` or skill-step binding, and the library skills attached to its agents for that step.
  - **For the repository:** every catalog agent, every library skill and attachment.
  - **Names:** an agent answers to its catalog ID, its file's name, its frontmatter name, and every Copilot agent `agent-mappings.yml` maps onto it. SFlow's own skills (`sf-*`, `sflow-*`) are always declared.
- **Settling (REQ-012):** `sfGuardSettle(writer, declared)` turns G1's provisional class into `declared`, `outside-workflow` or `unknown-agent`, at read time, so records are never rewritten.
  - No agent and no skill: outside the workflow (D1).
  - No agent with SFlow's own skill: declared, since SFlow's skills run as SFlow's agents.
  - No agent with another declared skill: `unknown-agent`.
  - A named agent: declared only when the set has it and its skill (if any) is declared.
  - An older explicit turn's writer (format @2) reads as its bound agent.
- **Stamping (D4):** `guard enable` writes the stamp into each agent file this repository owns, in the same reviewed change as the signed opt-in; `guard stamp-agents` (a person's own step, unsigned) writes any missing or edited.
  - Workflow Studio's `agent.stamp` runs last in a change set. A file with no hooks of its own gets one exact block before its closing `---` and no other byte changes (`src/presence/stamp-block.mjs`), so a framework agent keeps its packaged identity, which reads the file without the block (`src/agents.mjs`). A file with hooks of its own gets the stamp beside them.
  - The hook entry carries `command` (with `windows`), the key G0 saw fire in agent files on both hosts, and the Copilot CLI hook file's `bash` and `powershell`, the same line.
  - APM's agent files are left to their package and read "agent unknown".
- **Drift (CON-002, AC-011):** `guard` leaves the approved bytes of each stamped agent file in `<common git dir>/singularity-flow/guard/stamped-agents.json`. Each person's prompt compares the working tree with them, and the session's records carry `agentFilesChanged` (the agent IDs) while a file differs. `guard status` lists each agent file as `stamped`, `not-stamped` or `changed`.

## 5. Attribution records

**[SFG:REQ-020] One record per call.** With SF Guard on, every Copilot `preToolUse` that edits a file or runs a shell command in the repository records:
- `session`: a 16-character hash of the host's session id;
- `turn`;
- `agent`: the identity per §1, or none;
- `agentSource`: `agent-hook` (a declared agent's stamp), `subagent` (Copilot's own `agentType`), `binding` (the checkout's Story binding, inside an SFlow skill) or `none`;
- `skill` and `skillSource`: `prompt`, `skill-call`, `continued` (REQ-024), `parent` (a subagent's parent) or `none`;
- `subject`: the Story and step if the path is in an active Story checkout, else `repository`;
- `classification`: per §4. G1 records a provisional class (`declared`, `outside-workflow`, or `pending` where a declared agent used a skill only G2's declared set can judge); G2 settles it.

It covers plain prompts and paused sessions too. Reads are not recorded. The edit capture is today's XPL2 recorder, generalised: new format `xpl2-observed-write@3`, and the same limits.

**[SFG:REQ-021] Shell commands.** A shell call records the command's digest (never its text, which may carry secrets), its cwd, and the HEAD and index fingerprint before it runs. `postToolUse` records the fingerprint after. Changes between the two are claimed by that command. No Git process runs in the hook: fingerprints come from `stat` of tracked paths already noted, and any further changes are settled at reconciliation (§6).

**[SFG:REQ-024] Skill continuation, and subagents.** Two cases the review of ACP's per-prompt `sessionEnd` (`f2078e87e`) found today's turn records miss.
- **Plain follow-up prompts.** A skill often stops to ask the person, and the person's answer comes back as a plain prompt, so today it runs outside the skill's turn. In every recorded Story run, the agent then authored and published a whole step in that plain prompt. The rule: within the same session, a plain prompt continues the last explicit `/sf-` turn's attribution until another `/sf-` prompt starts, or that turn's step is published or submitted. It's labelled `skill: <name> (continued)`, not "outside the workflow". Only attribution continues, so this changes no hook decision ([SFG:REQ-042]).
- **Subagents.** A subagent's calls carry the subagent's own session id. They're attributed through `parentAgentId` to the parent session's turn and skill, with the subagent's `agentType` as the agent.

**[SFG:REQ-022] Agent per session.** A small per-session map, keyed by the hashed session id, next to the turn records, replaces the single `session.json` slot for attribution. `session.json` keeps its current role, so draft ownership is unchanged.

**[SFG:REQ-023] Size, and out of the way.**
- Records are machine-local and kept 14 days, as today. They hold digests and line ranges only, never contents.
- They print nothing and never change a hook's decision. Every error is swallowed and recorded as a gap.
- They are never telemetry, and never leave the machine except inside a Story's packet summary (§7).

### 5.1 As built (G1)

- **The recorder:** `src/comprehension/xpl2/sf-guard-recorder.mjs`. Like the XPL2 recorder it extends, the hook bundle loads it from source (node: imports only), so the hook chunks don't carry it. The boundary hooks (`src/copilot-repository-boundary.mjs`) call it after they have answered, and never change the answer.
- **The "on" check (REQ-060):** no Git process.
  - The checkout is found from its `.git` entry. A linked worktree's `.git` file leads to its common directory.
  - SF Guard is on when the last `enable` or `disable` in the checkout's `singularity/presence.json` is `enable`, or when `<common git dir>/singularity-flow/guard/state.json` says so. `singularity-flow guard` writes that file after it reads the verified policy, which covers an approved configuration on its own branch.
  - Signatures aren't checked here: an unsigned "on" only records more.
- **The session map (REQ-022):**
  - The map is `<copilot-boundaries>/<sha256(session id)>.attribution.json`. It exists only where SF Guard is on, so every other session pays one `lstat` per tool call.
  - A real `sessionEnd` (any reason but ACP's per-prompt `complete`) ends it. VS Code's next prompt on the same id then starts a new map with its own start.
  - Idle maps are pruned after 12 hours.
- **Stamps (D4):**
  - A declared agent's `.agent.md` runs `singularity-flow hook agent-stamp <AGENT> <EVENT>`. `sfGuardStampingHooks(agent)` writes that frontmatter, per prompt by default, and it answers `{}` even where SFlow isn't on PATH.
  - Stamps are appended to `<hash>.attribution-stamps.jsonl`, keyed by the prompt's or the call's digest, so a stamp that arrives after the plugin's hook (as G0 saw) still matches.
  - Writing the hooks into each declared agent's file comes with G2's declared set.
- **Edits:** XPL2 records at format `xpl2-observed-write@3`, still readable at `@2`.
  - An explicit turn's writer (`copilot-turn`) gains an `attribution` object.
  - A plain or paused prompt's edits are recorded as `copilot-session`, with the same object.
- **Shell calls (REQ-021):** each one is recorded in `<git dir>/singularity-flow/attribution/<day>.jsonl` (format `sfg-attribution@1`, 1 MiB per day, 14 days):
  - the command's SHA-256, never its text;
  - its cwd;
  - HEAD and index fingerprints before and after.

  A call with no `postToolUse` before `sessionEnd` is recorded `ran: false`. A shell call that publishes or submits the step ends REQ-024's continuation.
- **Gaps (REQ-023):** a recording failure leaves a line in `<common git dir>/singularity-flow/guard/gaps.jsonl`. `guard status` shows them with G3.
- **Measured (REQ-070),** Node 26 on macOS, the same edit call with SF Guard off and on:
  - in the hook process, the added p95 is 4.6 ms per edit, 4.5 ms per prompt and 1.1 ms per read;
  - through the real hook process (about 80 ms of Node start), the added p95 is 3 ms per edit.
- **One cost the spec didn't foresee:** the shell launcher skips Node while `copilot-boundaries` is empty. A session map keeps it non-empty, so in an SF Guard repository each tool call starts the hook runtime, about 80 ms, as an explicit SFlow turn already does. While a map exists, other sessions on the machine pay it too.

## 6. Reconciliation with Git

**[SFG:REQ-030]** At a step's submission, at `guard report`, and on request, the change set is compared with the recorded calls, line range by line range. The change set is a Story's against its base, or the working tree's and the unpushed commits' for the repository. Each changed range gets exactly one of:
- **declared**: a verified write by a declared agent and skill;
- **outside-workflow**: a verified write by an undeclared agent or skill, or by plain Copilot (D1);
- **shell**: changed during a recorded shell command (agent and skill as §1 allows);
- **unknown-agent**: a verified Copilot write whose agent isn't known;
- **unattributed**: no recorded call explains it. That covers a person, another tool, a script outside Copilot, a lost record, or recording off;
- **pre-guard**: written before SF Guard was turned on.

Unverified lines (the arguments don't explain them) are never credited (`observed-write-recorder.mjs:6-9`). They become `unattributed`.

**[SFG:REQ-031]** Reconciliation reads Git once per request, through the existing Git execution layer, and is bounded. A capped report says it is partial, never "all declared".

### 6.1 As built (G2)

- **Command:** `singularity-flow guard reconcile [--json]` is a read open to any turn (`src/presence/reconcile.mjs`). In a Story checkout it reconciles the Story since its base (its work interval's source base, else the step's baseline, else the commit the Story started from; G3 added the last, since a specification step has neither and its branch is already pushed), with that step's declared set; anywhere else, the working tree and unpushed commits since the upstream commit (else HEAD), with the repository's.
- **Git:** a fixed three reads per request (`sfGuardChangeSet` in `src/git.mjs`): the upstream commit, one zero-context patch to the working tree (renames as delete and add), and the untracked files. Never one per file or line.
- **Per changed line**, from the current bytes on disk:
  - the observed writes' byte chain (XPL2's `attributeLineWriter`, start unknown) credits a verified write's writer, settled per §4.1;
  - a line in an unverified change reads `unattributed` (AC-007);
  - otherwise, `shell` when the file last changed while a recorded shell call ran (its window, start to end, within 2 s; G1 records now carry `startedAt`, and older ones count the minute before they ended) (AC-005);
  - otherwise, `pre-guard` when the Story's pin predates SF Guard, or the file last changed before the signed opt-in;
  - otherwise, `unattributed` (AC-006).
- **Bounds:** 500 files, 20,000 lines, 1 MiB a file, 400 ranges in the report. A capped report carries `partial`, never "all declared". Removed lines are counted, not classed.
- **Records an agent writes:** with SF Guard on, `upstream-issue raise` and `story intent-amendment propose` run by a Copilot shell call with no `--authored` are recorded as `governed-agent` (`sfGuardRunningAuthorship`, from the session maps' running shell calls, where the scope step admits it). The hook refuses an agent's `--authored human` on either, with the agent's own command first, except a raise in the person's own `/sf-decide`, whose words are theirs.

## 7. Labels and where they show

**[SFG:REQ-040] Wording:**
- "Produced outside the workflow: agent X, skill Y (N lines in M files)";
- "Agent unknown (N lines)";
- "Unattributed (N lines)".

Labels sit beside the work they describe and never replace it. Declared work shows a small "declared" tick, never a list.

**[SFG:REQ-041] Where labels show:**
- **Review packets:** an `attribution` block with counts and ranges, added at submission (`src/story-lineage.mjs:392`). The person sees it before approving.
- **Approval card:** the counts, on part 1's card, before Touch ID.
- **Final check** (`src/evidence/terminal.mjs:244`): advisory only. It never blocks and never asks for a decision.
- **Evidence receipt** (`src/evidence-receipt.mjs:106`): the attribution digest, re-verified on replay.
- **`guard status`:** on or off, recording health, and the last gap.
- **`guard report [--since] [--story ID]`:** the whole-repository view outside Stories.
- **VS Code:** Story views and a Guard panel (G5).
- **The draft's authorship:** if a draft's attribution contradicts its claimed producer (for example `--authored human` with declared-agent writes), the packet shows both. That covers the live reruns' authorship finding.

**[SFG:REQ-042] Never blocks.** No refusal, prompt or gate ever depends on a label. The one exception is the existing person-only refusals, which are part 1's and unchanged.

### 7.1 As built (G3)

- **The block** (`src/presence/attribution.mjs`, `attributionBlock`): `sfg-attribution/1`, with `status` (`complete`, `partial` or `unavailable`), the Story's pin, the base, line, file and removed-line counts, `counts` per class, the top 8 non-declared `items` (class, agent, skill, `continued`, lines, files, `agentFilesChanged`), `itemsOmitted`, `rangesOmitted`, `partial`, and an `authorship` contradiction when a step claimed as `human` or `external-tool` has agent writes recorded. Its own `sha256` is the digest of the rest. Full ranges stay in `guard reconcile` and `guard report --story`.
- **At submission** (`createStoryReviewPacket` in `src/story-lineage.mjs`): the block joins the packet as `attribution` when the Story was pinned `required` or the repository has SF Guard on now. So `reviewPacketSha256`, which an SF Guard approval signs, seals it (REQ-050). The `story-submission-packet` family is unchanged: the field is optional, older readers rehash the stored body and so verify it, and older packets replay as before. A failure is an `unavailable` block and never stops the submission.
  - Each line settles against the declared set of the step that wrote it (the write's `subject`), else the submitting step's.
  - The Story's own SFlow records (everything under its work-item directory but `artifacts/`, and `.sflow/`) are left out.
  - A published artifact is read through its **authored view** (`authoredView` in `reconcile.mjs`): publication puts SFlow's metadata block (and an artifact may carry approved inputs blocks) around the author's bytes and ends the file with a newline. The view removes whole-line managed blocks exactly as `authoredArtifactText` does, maps each published line to its authored line (managed lines are not classed), and matches the author's recorded write by the view's digest, with or without that one final newline. A block inside a line of text leaves the file read as it stands.
- **The approval card:** `attachPersonPresence(prepared, record, { cardLines })` puts `attributionCardLines` (the counts on one line, then the top 3 items) on M2's card before Touch ID, from the verified packet.
- **The review:** `phaseReview` carries `attribution` and `attributionLabels` from the verified packet, and the terminal review prints them under "SF Guard labels".
- **The evidence receipt:** the core gains `attribution` (`status`, `sha256`, `verified`, `counts`), from the packet alone, so receipts of packets without labels are unchanged. The observations gain `attributionSeal`: `sealed` (a counted approval signs this packet and its file still hashes to its digest), `not-yet-approved`, `altered` or `absent`. The line reads "SF Guard labels: … · sealed by N counted approval(s)".
- **The final check:** `runGovernanceGate` adds advisory warnings, one per step whose latest labels are not all declared, from workflow.json's projections (no Git read). Never an error.
- **The remote check (AC-009):** for each counted approval, its sealed packet must still be on the Story and hash to its digest (labels included). Otherwise `PSS_PACKET_ALTERED`, with the route: restore it from history, or the approver approves the new packet again. Already so on the base: a note.
- **`guard status`** adds `recording` (whether this checkout records, the recent gap count and the last gap). **`guard report [--since DATE|7d|12h] [--story WORK-ID]`** (a read in any turn) groups this machine's observed writes and shell calls by class, agent and skill, Story by Story, and with `--story` lists the Story's sealed labels step by step with each packet's standing. VS Code's Guard panel (G5) reads the same `sfGuardReport`.

## 8. Binding into the signed review (part 1)

**[SFG:REQ-050]** The `attribution` block and its digest are part of the review packet, so they are covered by `reviewPacketSha256`, which part 1's statement signs. After approval:
- changing a label breaks the signature;
- a removed label is detected on replay and by the remote check.

Before submission, CON-002 applies. With part 1 off, the labels still show, but nothing seals them.

**[SFG:REQ-051]** A Story pins the attribution policy at start, as it pins the presence policy ([PSS:REQ-040]), so turning SF Guard on mid-Story labels only later work. Earlier work shows as `pre-guard`.

## 9. Turning it on

**[SFG:REQ-060]**
- **One switch:** attribution is part of SF Guard's signed `enable` ([PSS:REQ-040], `singularity/presence.json`), with no switch of its own (D2). Off by default.
- **Not opted in:** behaviour is exactly today's. No new hook work beyond one cheap check.
- **Turning it off** is signed, as part 1 requires.
- **Infrastructure:** nothing blocks on it. Recording failures are gaps. GitHub is never read here.

## 10. Performance

**[SFG:REQ-070]** The hooks already run on every tool call, within a 10 s timeout. Added work:
- **The "on" check:** one `stat` of the policy file under the hook's resolved root, cached per session and cwd for the turn. No Git process in the hook, and no repository scan.
- **Recording:** only edit and shell calls. Reads add nothing.
- **Edit capture:** today's bounded file reads (32 files, 1 MiB each).
- **Shell fingerprints:** `stat` only.
- **Code loading:** the recorder stays loaded from source, outside the hook bundle's chunks (`observed-write-recorder.mjs:14`), so the hook-context closure (7,725,000 ceiling, nearly full) doesn't grow. Measure each milestone and raise only what the measurement shows.
- **Target:** under 15 ms of added p95 per edit call on macOS, under 40 ms on Windows. G1 measured 4.6 ms in-process and 3 ms through the hook process on macOS (§5.1). Windows is unmeasured.

## 11. Milestones

| ID | Delivers | Needs | Exit |
| --- | --- | --- | --- |
| G0 | The probe of REQ-001 on the user's Copilot CLI and in VS Code | — | **Done** 1 November 2026 in the CLI and in VS Code, all but the `Local` session target (§1.1) |
| G1 | Recording (REQ-020 to 024): the per-session agent map, plain and paused turns, shell fingerprints, the "on" check | part 1 M1 (the policy file) | AC-001 to AC-004, the latency target. **Built** (§5.1) |
| G2 | The declared set (§4) and reconciliation (§6) | G1 | AC-005 to AC-007. **Built** (§4.1, §6.1), with the stamping hooks and the drift label |
| G3 | Labels in packets, receipts, the final check, `guard status` and `guard report` (§7) | G2, part 1 M2 (signed approval) | AC-008 to AC-010. **Built** (§7.1) |
| G4 | Whole-repository labels outside Stories through D3's route; the agent-file drift label | G2 | AC-011 |
| G5 | VS Code Guard panel and Story views | G3 | AC-012 |

G1 and G2 can run alongside part 1's M2. G3 waits for M2's signed packets.

## 12. Acceptance criteria

| ID | Scenario | Observable result |
| --- | --- | --- |
| [SFG:AC-001] | SF Guard off; a plain-prompt edit | No record, and hook output identical to today |
| [SFG:AC-002] | SF Guard on; a plain-prompt edit with no custom agent | A record with `agent: none`, `skill: none`, classed per D1 |
| [SFG:AC-003] | An `/sf-code` turn as the step's agent edits a source file | A record classed `declared`, with skill `sf-code` and the step's agent |
| [SFG:AC-004] | An unmapped custom agent from `~/.copilot/agents` edits | A record with that agent, `outside-workflow`; nothing refused |
| [SFG:AC-005] | An agent writes a file with `node -e` | The lines are classed `shell` (that command), never `declared` |
| [SFG:AC-006] | A person edits in another editor | `unattributed`, never `person` |
| [SFG:AC-007] | A forged observed-write record claims lines its arguments don't explain | Those lines are `unattributed` |
| [SFG:AC-008] | Submission of a step with mixed work | The packet's `attribution` block shows the counts; the approval card shows them before Touch ID |
| [SFG:AC-009] | The label is edited after approval | Replay and the remote check report the packet digest mismatch |
| [SFG:AC-010] | The final check on a Story with off-workflow work | Advisory lines only, and the Story closes |
| [SFG:AC-011] | A declared agent's file is rewritten on disk | The session's records carry "agent files changed" |
| [SFG:AC-012] | The VS Code Guard panel | The same counts as `guard report`, from the same reader |
| [SFG:AC-013] | Recording fails (full disk, unreadable store) | The hook decision is unchanged, and `guard status` names the gap |

## 13. Decisions

**Decided by the user (1 November 2026):**
- Both halves.
- Allow but label.
- Whole repository when on.
- **D1:** plain Copilot counts as outside the workflow, labelled once per turn.
- **D2:** one switch. Attribution comes with SF Guard's signed `enable`.
- **D3:** (a) machine-local records plus `guard report`. The `prepare-commit-msg` trailer is offered later, because a commit hook is a standing change to the repository's Git setup, it interacts with `core.hooksPath` (`src/commands/secrets.mjs:41`), and `--no-verify` skips it.
- **D4:** stamping hooks. SFlow writes an agent-scoped stamping hook into each declared agent's `.agent.md` (catalog, APM-deployed, bundled), plus `subagentStart`.
  - **G0 confirms this works in the CLI** for an agent selected with `--agent` and for that agent run as a subagent. A stamp per call is possible.
  - The in-session `/agent` switch and VS Code's picker stay unconfirmed until the VS Code kit runs. Until then, an unstamped top-level session reads "agent unknown".
- **D5:** G0 ran first; for its results, see §1.1.

## Sources

- GitHub Copilot CLI documentation, "CLI hooks reference": payload fields per event; `subagentStart` `agentName`; subagent `agentId`/`agentType` "when known".
- VS Code documentation, "Agent hooks in VS Code (Preview)": agent-scoped `hooks` in `.agent.md` frontmatter; `PreToolUse` fields.
- SFlow memory notes: the batched preToolUse live probe (18 October 2026), XPL2, Copilot activity metrics, and "no telemetry in the work path".
