---
id: source-grounded-review
title: Independent source-grounded review
aliases: [review-source, source-review, specification-review, planning-review]
questions:
  - Why does source review ask a question I already answered?
  - What human clarification does the reviewer read?
commands: [review-source]
related: [approvals, workflow-authoring, story-lifecycle]
version: 1
---

`/sf-review-source <phase>` independently reviews a published scope or planning generation;
it does not approve, advance or rewrite the author's artifact. The phase's responsibilities,
not its name, determine the review kind, including copied/custom workflows.

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

If the artifact already follows a recorded answer, retain a corrected independent review of
the same generation; earlier reports remain in append-only history. A real artifact gap needs
author correction and another review, not a fabricated pass. Only an ID actually returned in
`pendingDispositions` can be used with `singularity-flow review-source decide <phase> --finding
<ID> --reason <TEXT>`. Questions and reviewer blockers are not waivable through that command.

Use `review-source check <phase> --report-file <stagingPath> --json` before retaining a packet,
then the supported `review-source submit` form. Reading answers or retaining a review is not
phase submission or approval. `/sf-review-source` is the Copilot route for this review flow.
