---
name: sflow-review-source
description: Independently check a published Story specification or plan against pinned sources and exact clause-to-test mappings, then submit the cited review packet.
disable-model-invocation: true
argument-hint: "<specification|planning>"

---

# Review source coverage

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show the exact reviewed hashes, cited gaps, exclusions, questions, and test exceptions before any human approval. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow review-source context <phase> --json`. Require the selected phase to be `specification` or `planning`, with a current published generation and a complete pinned source inventory. If any listed source is unavailable or truncated, stop and report it. Documents under `unreadableSources` (links, PDFs or images without text, machine-local, empty, too large, over the review budget) are not cited; each becomes an `unreadable:<DOC-id>` decision for a human, which carries over to later reports and generations of this phase while the document is unchanged.
2. Select the independently pinned governed agent named by `requiredReviewerAgentId` with `singularity-flow agent --agent <that-id>`. Have that agent read the packet and its exact cited files. The specification or plan author cannot be the reviewer. The reviewer must not edit source, artifacts, tests, workflow records, or approvals.
3. Produce the JSON report with the exact `binding` from the context command. For specification rows, cite `sourceId`, one-based `line`, exact `quote`, `S#` scenario, and full clause IDs, or propose an `excluded` row with reason or a `question` row. A scenario grounded only in an unreadable document gets a `covered` row with that `sourceId` and an `attestation` of where in it, instead of `line`/`quote`; it becomes an `attested:<row-id>` decision. For planning rows, assess every approved clause's exact source paths and planned test paths and expose every `not-applicable` reason. List blocking semantic gaps with source citations. Never infer that zero validator findings prove semantic correctness.
4. Stage the report only at the Git-private path returned by the context command. Run `singularity-flow review-source submit <phase> --report-file <that-path>`. The command must validate the source and artifact hashes and retain the review separately from the author's artifact. If the agent cannot establish independent reviewer provenance, stop; the author may not self-certify by writing a packet.
5. Show the retained report hash, mapped sources and clauses, blocking findings, pending exclusions, unanswered questions, and test exceptions. Route corrections to the artifact author and exclusions, attested rows, unreadable sources, or test exceptions to the authorized human reviewer with `singularity-flow review-source decide <phase> --finding <ID> --reason <TEXT>`. After a correction, review the new exact generation again. The read-only reviewer must not submit, approve, or advance the phase; select the configured phase agent again before the next phase action.
