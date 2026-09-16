# Spec-Driven Phase Reliability Specification

Status: implemented baseline

## Purpose

Make every phase of `spec-driven-standard` fail early, explain the correct owner, and preserve an
exact recovery command. A seeded or partially authored Markdown file is not a published generation,
and no approval surface may present it as one.

The governed lifecycle remains separated into authoring, publication, submission, and approval.
This specification does not make `/sf-submit` generate or publish content implicitly.

## Scope

The contract applies to all six phases:

| Phase | Generation owner | Primary evidence |
| --- | --- | --- |
| specification | `/sf-phase` | approved Specification |
| planning | `/sf-plan` or the phase authoring route selected by the router | approved Plan and clause/test map |
| implementation | `/sf-code` | source/test change set and Implementation summary |
| convergence | `/sf-converge` | deterministic convergence record |
| verification | `/sf-verify` | acceptance-bound verification evidence |
| release | `/sf-release` | convergence plus verification evidence |

When an entry point does not yet have a signed phase contract, it must route through `/sf-next`
instead of guessing an owner.

## Markdown integrity contract

1. Draft checking, publication preflight, and agent-brief generation use one line- and
   offset-preserving Markdown structure parser.
2. HTML-comment markers inside fenced or inline code are literal code, not comments.
3. A real unclosed HTML comment produces `artifact.comment.unclosed` with the opening line.
4. Comments cannot satisfy required headings or hide unresolved placeholders from one surface while
   exposing them to another.
5. The check covers the primary phase artifact and supporting Markdown artifacts before
   publication or approval.
6. Brief planning validates the complete source before writing any brief, so a failure cannot leave
   a partial downstream context set.

## Agent-brief contract

Approved-summary projections are closed contracts. Every preserved heading must occur exactly once
in the producer template and must contain authored text at publication time. Missing, empty,
ambiguous, or comment-hidden sections block configuration or publication with a precise diagnostic.

The Spec-Driven profile uses `fallback: block`; it never expands an empty `Agent brief` into the
whole artifact. Existing pinned Story records migrate deterministically without rewriting their
historical artifacts.

## Phase and session contract

`session current --json` is the bounded source for the selected Story, repository, phase, active
agent, and phase-agent readiness. Authoring skills then read `phase show <phase> --json` instead of
loading the unbounded Story-wide status payload.

An agent session is valid only for its exact Story and phase. Transitions rebind the session even
when adjacent phases use the same agent ID. Deterministic phases clear agent authority and do not
pretend that the prior phase agent authored their output. A deliberate same-phase agent override
remains valid because it is separately recorded and does not grant approval authority.

Every invalid binding returns both forms of the repair:

- Copilot: `/sf-session`
- Shell: `singularity-flow session attach <WORK-ID> --json`

## Spec-Driven input contract

- Planning, implementation, convergence, and verification consume bounded approved summaries.
- Required preserved sections are validated at configuration load and again against authored text.
- Release consumes the deterministic convergence artifact and the approved Verification summary.
- The Verification preserve heading
  `Negative, regression, security, and non-functional checks` is one quoted YAML scalar.
- The terminal fast-path milestone is reached only after both Verification and Release complete.

## Exact command contract

Action guidance carries structured fields end to end:

```json
{
  "executable": "singularity-flow",
  "argv": ["session", "attach", "WORK-ID", "--json"],
  "command": "singularity-flow session attach WORK-ID --json",
  "copilotCommand": "/sf-session"
}
```

UI surfaces execute `argv` directly. They never recover flags by reparsing display text. A supplied
display command that disagrees with structured argv is refused rather than normalized silently.

## Planning correction protocol

Planning runs `phase draft-check planning --json` before publication. A correction pass may repair
only structured findings from governed evidence. It is bounded to three distinct changed
fingerprints, stops on an unchanged fingerprint, and permits at most one publication retry after a
race-time `ARTIFACT_AUTHORING_INCOMPLETE`. It never deletes markers blindly, pads content, invents
facts, or starts a nested model.

## Compatibility and migration

Pinned Spec-Driven Story records are upgraded through the schema migration registry. The migration:

- repairs the historically split Verification preserve heading;
- adds the exact convergence input required by Release when absent;
- leaves custom profiles and historical artifact bytes unchanged.

New configuration is rejected before Story start when a preserved heading is absent, duplicated,
hidden by an unclosed comment, or backed by a dynamic template that cannot be validated safely.

## Acceptance criteria

- Every shipped Markdown phase template is checked for real unclosed comments.
- All six Spec-Driven phase templates have regression coverage.
- Comment-looking text in fenced and inline code remains valid.
- Draft check and agent-brief generation agree on headings and visible text.
- Code corrections route to `/sf-code`; deterministic convergence routes to `/sf-converge`;
  ordinary document generation routes to `/sf-phase`.
- Natural-language generation without signed phase context routes to `/sf-next`.
- Same-agent Verification-to-Release transitions still update the phase binding.
- Release receives convergence and Verification inputs for new and migrated Stories.
- Shell and Copilot actions are always shown together, and exact argv survives the VS Code journey
  surface without truncation or reparsing.

## Non-goals

- Automatic submission or approval.
- Treating a seeded draft as a published generation.
- Model-based repair of malformed lifecycle artifacts.
- Weakening sequence, publication, test, or approval gates.
