---
id: source-grounded-review
title: Independent source-grounded review
aliases: [review-source, source-review, specification-review, planning-review]
questions:
  - Why does source review ask a question I already answered?
  - What human clarification does the reviewer read?
  - How do I repair rejected source line and quote citations?
commands: [review-source]
related: [approvals, workflow-authoring, story-lifecycle]
version: 7
---

## Purpose and prerequisites

`/sf-review-source <phase>` independently reviews a published scope or planning generation;
it does not approve, advance or rewrite the author's artifact. The phase's responsibilities,
not its name, determine the review kind, including copied/custom workflows.

Use this topic when a phase's published generation needs independent source review: that review
must be recorded before the phase can be submitted. Work in the Singularity Flow checkout of the selected
Story. The phase must have a published generation; a private draft is never reviewed.

## Use it from each surface

- **Shell:**
  - `singularity-flow review-source context <phase> --json` reads the review packet: pinned sources,
    the authored artifact, clarifications, the canonical `reportSchema` and the `reportTemplate`.
  - `singularity-flow review-source check <phase> --report-file <stagingPath> --json` is a read-only
    format, citation and binding preflight. It makes no commit, push, human decision or approval.
  - `singularity-flow review-source submit <phase> --report-file <stagingPath>` rejects malformed
    packets before mutation and retains valid independent review evidence, including real gaps.
  - `singularity-flow review-source decision-context <phase> --work-id <WORK-ID> --finding <ID> --reason <TEXT> --json`
    prepares an exact human decision packet without mutation. After human confirmation, execute
    its returned `decide` command with `--confirm <packetSha256>`. Changes to the report, generation,
    finding, reason, identity or authority invalidate that confirmation.
  - `singularity-flow review-source status <phase> --json` re-evaluates the latest report, source and
    artifact hashes, and human decisions.

  Run `singularity-flow review-source --help` for the exact forms supported by this build.
- **Copilot:** `/sf-review-source` is the Copilot route for this review flow. `/sf-review-source <phase>`
  reads the context, fills the report, stages it at the returned Git-private path, checks it and
  retains it once. `/sf-review-source status <phase>` only reads status. For pending human exceptions,
  use `/sf-review-decide <phase> --finding <ID> --reason <TEXT>` in a separate turn. It shows the exact
  packet, requires human confirmation, and records only that disposition. Legacy `/sf-review-source decide`
  hands off without deciding. The independent reviewer remains read-only; neither an exception decision
  nor a reason attests visual acceptance, approves the phase or advances the Story.
- **VS Code:** when the current Story phase's published generation still needs source review, the
  Singularity Flow sidebar shows it as "Published generation N — source review required" with a
  **Review <phase> against its sources** action. That action opens Copilot Chat with
  `/sf-review-source` prefilled for you to complete and send; clicking it does not review, retain or
  submit anything. The extension has no separate command that runs the review itself.

## Guided workflow

1. Read the packet with `singularity-flow review-source context <phase> --json`, or start
   `/sf-review-source <phase>`. If it returns `canReview: false`, relay its `continuation` handoff
   and stop: the successor has not been published.
2. Read every pinned source, the authored artifact and every clarification, and record each
   clarification record ID in `clarificationsReviewed`.
3. Fill `reportTemplate` against `reportSchema`, keeping its exact binding, and stage it at the
   returned Git-private path.
4. Run `singularity-flow review-source check <phase> --report-file <stagingPath> --json`.
   Repair packet errors in this review turn, at most twice with changed packets. Use the returned
   `repair` fields; never repeat an unchanged failure.
5. Retain the packet with `singularity-flow review-source submit <phase> --report-file <stagingPath>`,
   including any honest gaps.
6. Follow the returned `continuation`, described below.

## Human answers in the review packet

`singularity-flow review-source context <phase> --json` returns original pinned sources,
the exact authored artifact, and `clarifications` retained by that generation's publication.
Planning also receives the approved scope generation's checkpoint. Each record is checked
against its published artifact metadata, workflow reference, Story/phase/generation identity,
human actor, SHA-256 and committed bytes. A loose draft, another Story's record or a later
generation's answers cannot replace it. Missing or altered pinned bytes fail explicitly.

The reviewer reads every question/answer and records each record ID in `clarificationsReviewed`.
This field starts empty in `reportTemplate`: a template cannot claim the answers were read.
The review binds the exact checkpoint hashes; a changed binding requires a fresh review.
Reviews with no published clarification keep their previous report shape and binding.

Answered clarifications can refine ambiguous source wording. Deferred answers remain undecided.
Neither silently amends intent nor waives required tests, independent review or human approval.
The reviewer must reconcile all pinned evidence before asking again or declaring a contradiction,
and cite phase, generation and question ID in the rationale. For example, if plural “test cases”
was explicitly clarified as one positive-value test, plural wording alone is not a new gap.

## Correction and human decisions

### Requirement completeness and repair before publication

Scope-producing phases receive a shared obligation-first rubric, including renamed/custom steps
and legacy requirements artifacts. Initiative requirement producers receive it through their
declared outputs. The author splits compound requests into independently observable obligations
and records source → REQ/AC → assertion → verification intent in the existing artifact sections.
This is not a new mandatory table, semantic pass certificate or extra publication gate.

The rubric applies to UI, API, event/message, batch/job, CLI, library and mixed interfaces. It
does not invent an endpoint, control, error message, limit or screenshot requirement. An explicit
request for a button must be preserved; a backend-only request does not acquire UI obligations.
Existing acceptance criteria count as coverage, and related obligations can share clauses.

Before prepublish, the author repairs clear, source-settled omissions in the current editable
draft, updates affected scenarios and verification intent together, and rechecks changed content.
The returned repair-loop policy and configured budget still apply: no unchanged retries or budget
reset. Exhaustion stops automation, not authorized manual repair. Material ambiguity and scope
changes use the pinned clarification or human-decision route; settled answers are not asked again.
Neither this guidance nor a requirements-only turn grants application-code editing permission.

The reviewer assesses the whole normative artifact. A blocking omission must explain how an
implementation could satisfy the existing coverage yet violate the exact source commitment.
Pure wording improvements are advisory; genuine omissions, contradictions and unverifiable
obligations remain blocking. Specified tests or screenshots are not execution evidence.
Reviewers repair their own packet/citations, not the author's artifact. Real published defects
still use the authorized successor route, preserving existing publications and decisions.

Previously composed prompts and pinned reviewer instructions receive current guidance at
delivery; their stored bytes, digests, generation and approval history are not rewritten.

### Exact citations without a review dead end

`citationGuide` lists every specification scenario and clause, including clarified scenarios such
as S2. Citation line numbers are **1-based lines of the pinned extracted `sources[].text`**, not the
JSON packet, original attachment layout, specification, or clarification record. Quotes must be exact
non-empty substrings of one source line, at most 1024 characters. Do not paraphrase or combine lines.
Copilot's bounded agent view puts even short source texts in Git-private, native-readable text files
without changing their bytes. Read those files using the native file tool's line numbers. The
ordinary JSON context retains its original text fields; the agent view references each text once.

`check` returns exact row/finding field paths and a bounded `repair` guide. A quote found on exactly
one source line gets a proposed line-number edit, bound to the checked report and source digest.
Nothing is edited automatically. Multiple matches require independent selection; absent matches
require rereading the source, never fuzzy replacement. Stage/retain refusals preserve these hints.
Changed inputs require a fresh context, not citation transplantation.
The read-only `check` also accepts `--for-agent --json`, and the returned staging protocol uses it,
so Copilot receives an inline action and exact private-file references even in a non-terminal shell.
This is output shaping only; it does not relax the context entry or mutation permissions.

For an unmapped scenario, independently reconcile its source and pinned answers. Add a covered row
only if they genuinely support it; acknowledge clarification IDs separately. Otherwise retain a
blocking finding, not fabricated coverage. `retentionReady: true` permits retaining an honest
`correction-required` review: it does not approve the phase. The check returns the exact retain
route, or the recheck route to use **after** repairing the private packet. No source/artifact edits,
human dispositions or approval are performed by citation repair. These rules follow review
responsibilities across seeded, renamed and custom workflows, not particular phase names.

If the artifact already follows a recorded answer, retain a corrected independent review of
the same generation; earlier reports remain in append-only history. A real artifact gap needs
author correction and another review, not a fabricated pass. Only an ID actually returned in
`pendingDispositions` can be prepared with `singularity-flow review-source decision-context <phase>
--work-id <WORK-ID> --finding <ID> --reason <TEXT> --json`, then decided using the returned exact
`--confirm` command after human review. Questions and reviewer blockers are not waivable through that command.

Use `review-source check <phase> --report-file <stagingPath> --json` before retaining a packet,
then the supported `review-source submit` form.

## A concrete next action, including successor drafts

Review context and status include `continuation`: the exact Shell and Copilot action, its owner,
published generation and target generation. A real artifact correction returns to the phase author
with `singularity-flow prepare <phase>` and that phase's configured authoring skill. A pending human
disposition instead names the exact finding to decide; a ready review names submission. The fast
path, phase document display, submission readiness and next-step planner use the same handoff.

Successfully preparing an in-progress document successor reserves authoring without incrementing
the published generation. Draft checks and prepublication inspect the prospective generation,
not the retained publication. Prepare retries keep the reservation and preserve existing content.
No private draft is reviewed as a publication: context returns `canReview: false` and the authoring
handoff until the successor is published, and review check/retention refuse old-generation packets.
Earlier publications and reviews remain preserved. Submitted evidence still needs an authorized
return, and code successors retain their guarded generation boundary. These rules use the phase's
contract, including copied, renamed and future custom phases, rather than built-in phase names.

## State and safety

- Reading answers or retaining a review is not phase submission or approval. Source review never
  approves, advances or rewrites the author's artifact.
- `context`, `check` and `status` read state. `submit` retains review evidence, and `decide` records
  an authorized human decision; neither submits the phase.
- Reviews are append-only: earlier reports, publications and reviews remain preserved.
- A review is bound to exact checkpoint hashes. When the binding changes, a fresh review is required.

## Troubleshooting

- **The review asks a question you already answered.** The reviewer reads only the clarifications
  retained by that generation's publication. A loose draft, another Story's record or a later
  generation's answer is not in the packet. If the artifact already follows a recorded answer,
  retain a corrected review of the same generation rather than asking again.
- **`canReview: false`.** The successor is still a private draft. The phase author prepares and
  publishes it; then review the new generation.
- **Check or retention refuses the packet as old.** Read `context` again and review the current
  published generation.
- **`check` reports `retentionReady: false`.** Follow `repair` for exact format/citation fields;
  repair and recheck in the same review turn within the two-repair budget. Do not retain invalid
  citations, restart authoring, or ask the person to invent a quote. If still invalid, report the
  precise remaining fields and match ambiguity. A genuine semantic gap is retainable evidence,
  not a reason to falsify a covered row.
- **`decide` refuses the finding.** Only IDs returned in `pendingDispositions` can be decided.
  Questions and reviewer blockers need an answer or an author correction instead.
- **Pinned bytes are missing or altered.** The review fails explicitly; do not cite a source that
  could not be read.
- If a Copilot or VS Code action is unavailable, use the CLI form above; do not guess a command from
  the label.

## Related topics

Continue with `sflow explain approvals`, `sflow explain workflow-authoring`, `sflow explain story-lifecycle`.
