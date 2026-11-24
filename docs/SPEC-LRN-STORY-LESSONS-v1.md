# Story lessons (LRN) — v1: every Story leaves lessons, and the next Story reads them

**Specification ID:** `LRN-v1`

**Status:** Proposed, not built.

**Owner, 2026-11-24:** "We have so many learning in each run about the code base, testing methods what work and what
doesnt ..how we make sure that this is part of the learning and next story it will not have the same mistake ..kind of
countinous learning"

**Builds on:**
- the engineering knowledge store (`src/knowledge.mjs`, `singularity/knowledge/`). Its records are append-only and
  scoped. Its kinds are insight, gotcha, decision, constraint and uncertainty. It can resolve and supersede records, and
  its recall is deterministic;
- the bounded, untrusted projection of that store (`src/knowledge-projection.mjs`);
- the records a Story already keeps:
  - test runs (`src/local-test-runs.mjs`);
  - refusals and their recovery (`src/refusal-remediation.mjs`, `src/cli-failure.mjs`);
  - review findings, disputes and overrides (`src/finding-overrides.mjs`, `src/review-dispute-words.mjs`);
  - failing tests sent back to the code step (`src/failing-tests-return.mjs`);
  - files outside the plan (`src/departure-records.mjs`);
  - the environment a run used (`src/run-environment.mjs`);
- the repository's test command suggestions (`src/test-command-suggestions.mjs`);
- the machine-wide Story index (`src/story-index.mjs`);
- the owner's rule that the World Model and knowledge are guidance and never authority.

---

## 1. Why

A Story learns things that the next Story has to learn again:
- which test command works in which folder, and which one hangs;
- which refusal kept coming back, and what cleared it;
- what reviewers flag in these files;
- which file always has to change with which;
- what the environment needs before anything runs.

The knowledge store can hold all of this, with scope and provenance. But today:
- only an Initiative writes to it, by harvesting its approved documents;
- only an Initiative step reads it, and only when `harnessImports.knowledge.enabled` is set;
- a Story writes nothing to it, and a Story step reads nothing from it unless its agent asks the context broker;
- `singularity-flow knowledge record` by hand is the only way in.

So the same mistakes repeat, Story after Story.

## 2. What a person sees

At the end of a Story, one line, never a question:

```text
SFlow kept 3 lessons from this Story: run apps/vscode tests with npm run test:vscode · changing workflow-transfer.mjs
needs its presentation too · reviewers flag unbounded reads in src/knowledge/. Drop any you don't want.
```

The next Story's code step starts with them in its prompt, for the files it plans to change. The Story's closing
summary says:

```text
Used 3 earlier lessons. No earlier mistake happened again.
```

## 3. The rules

**LRN:REQ-001, what SFlow notices.** When a step ends (approved by a person or automatically), SFlow reads that step's
records and notices lessons with no model:

| What happened | The lesson | Kind |
|---|---|---|
| A test command failed, then another passed on the same code | "In `<folder>`, run tests with `<command>`. `<failed command>` fails: `<first line of its error>`." | insight and gotcha |
| The same refusal code came up two or more times in the step, then cleared | The refusal's words and the command or change that cleared it | gotcha |
| A reviewer's finding was fixed | "Reviewers flag `<finding>` in `<files>`." | gotcha |
| A person disputed or overrode a finding | "`<check>` is wrong about `<files>`: `<the person's reason>`." | constraint |
| Failing tests sent the work back to the code step | Which test broke, and the file the fix changed | gotcha |
| A file outside the plan was needed | "Changing `<file A>` usually needs `<file B>`." | insight |
| The environment stopped a run, then the run passed | The setup that made it pass (Node version, a variable's name, never its value) | constraint |

Each lesson is one or two lines of plain words. It names the files or folders it is about, the steps it helps (code,
test, review and so on), and the Story and step it came from.

**LRN:REQ-002, the agent's own lessons.** A Story's code and test summaries may end with a `Learnings to carry forward`
section of at most three lines. When the step is approved, SFlow harvests it with the store's own harvest of approved
documents (`harvestableEntries`), and marks it as the agent's words. A missing section adds nothing.

**LRN:REQ-003, kept without a stop.**
- Noticed lessons are kept as soon as they are noticed, with the trust `noticed`.
- A lesson a person keeps, edits or writes has the trust `confirmed` and ranks first.
- Keeping a lesson never asks a question, never adds an approval and never holds a step.

**LRN:REQ-004, Drop.**
- Each lesson offers Drop:
  - in the Story's end line;
  - in VS Code's Lessons list;
  - as `singularity-flow lessons drop <K-ID>`;
  - in Copilot by number ("drop 2").
- A dropped lesson is resolved, never deleted. It records who dropped it and when, and is never recalled again.
- The same lesson noticed again later is not kept again.

**LRN:REQ-005, where lessons live.**
- Lessons live in `singularity/knowledge/` on the Story's branch, in the Story's own commits, so they reach the team
  with the Story's pull request.
- With [SSB](SPEC-SSB-STORY-STATE-BRANCH-v1.md), lessons stay on the code branch: they are for people, like
  `docs/stories/`.

**LRN:REQ-006, provenance.** The store today takes only an approved document revision as provenance. LRN adds a second
kind: a Story record, named by work ID, step, record kind and record digest. A noticed lesson's provenance must be a
record that exists at that digest, or it is refused.

**LRN:REQ-007, scope.**
- A lesson's scope names its paths and the repository, as the store's scopes do.
- LRN adds `steps`: the step intents the lesson helps.
- This is a schema version of the knowledge record. Older records read as scoped to every step.

**LRN:REQ-008, what a step is given.**
- Each Story step's prompt gets the active lessons whose paths meet the files its plan names or its changes touch, and
  whose steps include its intent.
- They come from the base branch, from the Story's own branch, and from this person's other open Stories on this
  machine (the Story index).
- Confirmed lessons come first, then the most recent.
- At most 10 lessons and 2 KB.
- They go in the section that already carries repository knowledge. The token-reduction contract's section IDs are
  frozen, and the section is evicted whole when the budget is short, never cut mid-lesson.
- Each lesson cites the Story it came from by work ID and step, never by a digest.

**LRN:REQ-009, guidance, never authority.**
- No lesson blocks, refuses, approves or counts as evidence.
- A missing, unreadable or damaged store gives one warning, and the work goes on.
- Lessons reach the agent as quoted data in the store's untrusted form (`untrusted-knowledge-json-lines-v1`), never as
  instructions.

**LRN:REQ-010, a test command lesson.** A test command lesson for a folder joins the suggestions a missing or failing
test command offers. It never changes the repository's configured test command by itself.

**LRN:REQ-011, staying true.**
- A lesson is marked out of date when any of these happens:
  - its files are deleted or renamed;
  - more than half of their lines have changed since it was kept;
  - a later run contradicts it (the command it gives fails where it said it passes).
- An out-of-date lesson is still listed, but recalled only with "may be out of date".
- A contradicted lesson is superseded by the new one SFlow notices, through the store's own supersede.

**LRN:REQ-012, did it work.**
- Each lesson carries the signature of the mistake it is about: the refusal code and its paths, the failing command,
  the finding and its files, or the environment stop.
- When a later Story makes the same mistake while the lesson was in its prompt, the lesson counts a repeat.
- The Story's closing summary says how many lessons it used and how many earlier mistakes happened again.
- A lesson repeated twice is offered to the person as a team rule ([ITW](SPEC-ITW-INTENT-TO-WORK-v1.md) REQ-004) once
  team rules exist. Until then it is pinned: always recalled for its files.

**LRN:REQ-013, safety.**
- A lesson is scanned for secrets with `src/secrets.mjs` before it is kept. One that holds a secret is refused, and the
  refusal says which line.
- An environment lesson names a variable, never its value.
- A lesson shows no commit, digest or personal identifier to a person.

**LRN:REQ-014, where a person sees lessons.**
- **VS Code:**
  - a Lessons list (the Library, with Workflow Studio's other assets) that filters by file, Story and kind, with Drop,
    Keep and Edit;
  - the Story's end line;
  - in the Code Explainer's Explore mode, "Lessons about this file" in the inspector.
- **Copilot (VS Code, Copilot CLI, IntelliJ):** the end line, with numbers to drop by.
- **Terminal:**
  - `singularity-flow lessons [--path P] [--story ID] [--json]` reads them;
  - `lessons drop`, `lessons keep` and `lessons edit` change one.

## 4. How it relates to what exists

- Initiatives keep their harvest and their opt-in recall unchanged. A lesson an Initiative harvests can reach a Story
  step when their scopes meet.
- `knowledge record`, `knowledge resolve` and `knowledge import` stay as they are. `lessons` is a person's view of the
  same store.
- The Repository brief and the code-intelligence knowledge (`src/knowledge/`) describe the code as it is. Lessons
  describe what happened when people and agents worked on it.
- The decision list, approvals and the gate never read lessons.

## 5. Acceptance

- **A1:** In a Story whose test step first ran `npm test` (it fails) and then `npm run test:unit` (it passes):
  - SFlow keeps a test lesson for that folder;
  - the next Story's code step for a file in that folder has it in its prompt;
  - a Story in another folder does not.
- **A2:** A refusal that came up twice and then cleared is kept as a gotcha, with the words that cleared it.
- **A3:** Drop resolves the lesson. It is never recalled again, and the same lesson noticed again is not kept again.
- **A4:** A lesson whose file is rewritten is marked out of date. A recalled test command that now fails is superseded
  by the one that passes.
- **A5:** A damaged `singularity/knowledge/` gives one warning, and the Story runs to its pull request unchanged.
- **A6:** A lesson holding a token-shaped value is refused before it is written. An environment lesson holds no value.
- **A7:** A second laptop that checks out the base branch after the pull request merged gets the lessons.
- **A8:** A Story that repeats a mistake its prompt warned about counts a repeat, and the closing summary says so.
- **A9:** VS Code's Lessons list and the Code Explainer's inspector show the lessons for the selected file. Drop works
  from both.
- **A10:** No lesson shown to a person holds a hash or a personal identifier.
- **A11:** A journey test walks two Stories on VS Code and the Copilot CLI. The second step's prompt holds the first
  Story's lesson. The Story fuzzer and the invariant checks hold with lessons on.

## 6. Milestones

| Milestone | Scope | Size |
|---|---|---|
| M1 | Noticing from records, the agent's own section, Story provenance, the `steps` scope and its schema version, secrets (REQ-001, 002, 003, 006, 007, 013) | about 4 days |
| M2 | Recall into Story steps, the test command suggestions, staying true (REQ-008, 009, 010, 011) | about 3 days |
| M3 | Drop and Keep, the end line in VS Code and Copilot, the Lessons list, the Code Explainer section, `singularity-flow lessons` (REQ-004, 005, 014) | about 3 days |
| M4 | Repeats and the closing summary, journeys, the fuzzer, one real two-Story run (REQ-012) | about 2 days |

About two weeks.

## 7. Open questions for the owner

1. **Keeping lessons.** Default: SFlow keeps them, and a person drops any they don't want. The alternative is a person
   confirms each lesson before it is used.
2. **Who sees them.** Default: shared with the team in the repository. The alternative is private to each person, on
   their machine.
3. **A Story that is abandoned.** Default: its lessons stay on this machine and are recalled for this person, and they
   reach the team with the next Story that touches the same files. The alternative is to drop them with the Story.
4. **How much a step is given.** Default: at most 10 lessons and 2 KB per step.
