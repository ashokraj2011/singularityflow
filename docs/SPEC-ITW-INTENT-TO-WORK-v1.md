# Intent to work (ITW) — v1: say what you want; SFlow plans the steps and does the work

**Specification ID:** `ITW-v1`

**Status:** Proposed, not built.

**Owner, 2026-11-24:**
- "intent to work. ..when someone /sf-task or something it will automatically spinup workflow using the intent and do
  the work"
- "why do we need workflows ..let it be dynamic"
- "it can check the marketplace for skills also"

**Builds on:**
- step intents (`STEP_INTENTS` in `src/phase-roles.mjs`), from which `src/step-intent-settings.mjs` derives each step's
  settings;
- the workflow walk, which finds loops and stops before anything starts;
- Story workflow snapshots ([WFA](WFA-WORKFLOW-SNAPSHOTS.md));
- automatic approval of clean steps;
- software kinds (`src/software-kinds.mjs`);
- the skill library;
- trusted marketplaces and their conversion review ([MCR](SPEC-MCR-MARKETPLACE-CONVERSION-REVIEW-v1.md)).

---

## 1. Why

Starting work today means choosing a base, an intake and a workflow (`/sf-start`), and someone has to have written that
workflow first. `/sf-auto` runs work by itself, but it needs capability IDs and a hash confirmation for each flight. A
person who wants a bug fixed should be able to say so and get the fix, with the same guardrails.

## 2. What a person does

```text
/sf-task fix the login timeout on slow networks
```

SFlow answers with one line and starts:

```text
Plan: code → tests → you approve the code → pull request. Say "add a design step" to change it.
```

It then does the work in the same chat, step after step. It stops only where a person must decide: an approval the team
rules give a person, or a real question. `/sf-task` on its own carries on from where it stopped, and the work ends with
the pull request.

## 3. The rules

**ITW:REQ-001, the front door.**
- `/sf-task <words>` in Copilot: VS Code, Copilot CLI and IntelliJ.
- `singularity-flow task "<words>" [--kind KIND] [--json]` in the terminal shows the plan and writes nothing; `--start`
  starts it.
- `/sf-task` with no words continues the person's open task.

**ITW:REQ-002, the kind of task.**
- The agent says which kind the words describe: `fix`, `feature`, `change`, `tests`, `docs`, `investigate` or `chore`.
- SFlow refuses a kind it does not know.
- When the words fit two kinds equally, the person is asked once, with the kinds as choices.

**ITW:REQ-003, the steps, composed.** SFlow builds the steps from the kind, the same way every time:

| Kind | Steps (by step intent) |
|---|---|
| fix, chore | intake → code → test |
| change | intake → plan → code → test |
| feature | intake → requirements → plan → code → test |
| tests | intake → code (the tests) → test |
| docs | intake → document |
| investigate | intake → design (investigate) → report |

- Each step's settings come from its intent, as for any workflow that says what its steps are for.
- The composed steps are walked before anything starts: a plan that would loop or stop is never started.
- The agent may suggest a larger plan for a large task, for example adding design to a feature. The person sees it in
  the plan line.

**ITW:REQ-004, the team's rules.** `tasks:` in `singularity/workflow.yml` replaces whole workflows with a few rules that
always apply:
- `always`: steps or approvals every task of a kind gets. Defaults:
  - every code change gets a test step;
  - a person approves the delivered code;
  - a person approves a plan where there is one.
- `paths`: touching these files adds a step or a reviewer, for example a security review for `src/auth/**`.
- `use`: a kind (or paths) that must follow a named workflow, for example `release: Classic delivery`.
  - An existing workflow is then used as it is.
  - Workflows stay for work a team must do the same way every time.

The rules are checked last. They only add steps or raise approvals; nothing a person or an agent says removes one. "Skip
the tests" on a code change is refused with the rule's words. The rules change like any configuration: a reviewed
proposal.

**ITW:REQ-005, approvals.**
- SFlow approves each step that is clean, as it does today.
- A person approves what the rules give a person, and nothing else.

**ITW:REQ-006, the Story's own workflow.**
- The composed steps become the Story's workflow, frozen into its snapshot like any pinned workflow. They are never
  written to `workflow.yml`, so a task needs no configuration proposal.
- `workflow check`, the walk and the audit read it as they read any Story's workflow.
- A Story reopened on another laptop has the same steps.

**ITW:REQ-007, the Story.**
- Its ID is a Jira key when the words or `--work-id` name one. Otherwise it is the next free `<prefix>-<n>`; the prefix
  is `tasks.idPrefix`, default `TASK`.
- Its base is the repository's default branch.
- Its intake is the person's words and anything they attached.

**ITW:REQ-008, doing the work.**
- In the chat, SFlow runs each step after the last, with the turn continuations it uses today. It stops at a person's
  approval or a question.
- The approval page or Decide card opens where it does today.
- After the person's answer, `/sf-task` continues. No step needs a typed step ID.

**ITW:REQ-009, changing the plan.**
- "Add a design step" or "skip the plan" re-composes the steps from the current one forward. Done steps stay, and the
  rules still apply.
- The change is recorded with who asked for it.

**ITW:REQ-010, skills for each step.**
- For each composed step, SFlow looks for skills that fit, by:
  - the step's intent, matched to a marketplace skill's `pdlc-task` through the table conversion uses
    (`AGENT_TASK_INTENTS`);
  - what the task touches: the repository's software kinds (web, backend, mobile and so on) and the person's words,
    matched to the skill's tags.
- Sources, in order:
  1. the repository's skill library;
  2. trusted marketplaces, read at the commit the repository trusts.

  An untrusted marketplace is never read.
- A marketplace skill marked approved or `ga` is offered directly. One marked proposed or beta needs the person's yes.
- A marketplace skill not yet in the repository costs one yes the first time, with its exact text shown, as any import.
  It is then in the library, and the next task uses it without asking.
- The plan line names the skills it uses: "code → tests (with web-e2e-test-generation from acme, new here: add it?)".
- The exact skill text a Story uses is frozen into its snapshot.

**ITW:REQ-011, a marketplace agent as the plan.** When one marketplace agent's stages cover the task, SFlow offers that
agent's workflow as the plan, through the conversion review. Its steps then replace the composed ones, with the team
rules still applied.

**ITW:REQ-012, words.**
- The plan is one line.
- No commit, digest or step ID is shown to a person.
- An investigation ends with its report and offers a follow-up `/sf-task` when the report finds work to do.

## 4. How it relates to what exists

- `/sf-start` stays the explicit route: base, intake and workflow chosen by hand.
- `/sf-auto` stays for bounded runs with nobody at the keyboard. A later version may let `/sf-task` hand a plan to it.
- Workflows stay, and are optional. A `use` rule, or the person ("use Feature"), picks one.
- With [SSB](SPEC-SSB-STORY-STATE-BRANCH-v1.md), the composed workflow lives with the rest of the Story's state.

## 5. Acceptance

- **A1:** In a repository with no workflow of its own, `/sf-task fix …`:
  - composes intake → code → test;
  - starts a Story with a generated ID;
  - runs to the code approval with no other command.
- **A2:** The same words and the same repository give the same plan.
- **A3:** A `paths` rule for `src/auth/**` adds its step when the task touches auth, and only then.
- **A4:** "Skip the tests" on a code change is refused with the rule's words. No rule is ever removed by a task.
- **A5:** A `docs` task has no code step; an `investigate` task ends with a report.
- **A6:** In a web project with a trusted marketplace:
  - the test step offers `web-e2e-test-generation`;
  - its first use asks one yes with its text shown;
  - the next task uses it without asking.
- **A7:** A proposed or beta skill needs a yes. An untrusted marketplace is never read.
- **A8:** `use: { release: classic-delivery }` makes a release task follow that workflow unchanged.
- **A9:** The Story's snapshot holds the composed steps and the skill texts. A second laptop resumes the same steps.
- **A10:** A journey test walks `/sf-task` to the pull request on VS Code and the Copilot CLI. The Story fuzzer composes
  tasks of every kind, and the invariant checks hold.

## 6. Milestones

| Milestone | Scope | Size |
|---|---|---|
| M1 | Kinds, the composer, team rules, the Story's own workflow, `singularity-flow task` (REQ-002 to 007) | about 1 week |
| M2 | `/sf-task` in Copilot: running step after step, continuing, changing the plan (REQ-001, 008, 009, 012) | about 3 days |
| M3 | Skills from the library and trusted marketplaces, first-use import, a marketplace agent as the plan (REQ-010, 011) | 3 to 4 days |
| M4 | VS Code's Start a task box, journeys, the fuzzer, one real run | about 2 days |

About 2 to 2½ weeks.

## 7. Open questions for the owner

1. **The ID prefix** when no Jira key is given. Default `TASK`.
2. **Default approvals.** Default: a person approves the plan (where there is one) and the delivered code; SFlow
   approves every other clean step. The rules can raise this.
3. **A new marketplace skill's first use.** Default: one yes, with its text shown. The alternative is to use approved
   skills from a trusted marketplace with no yes.
4. **The kinds.** Default: fix, feature, change, tests, docs, investigate and chore.
