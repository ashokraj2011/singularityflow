# Self-healing continuation

Every phase uses the installed `repair-continuation-v1` contract: observe the exact failure,
diagnose it, preserve the draft, repair admitted work, verify the changed condition, and recheck
the original gate. The contract applies to seeded, imported, duplicated and future custom workflows;
it is resolved by the kernel rather than copied into each YAML definition.
The installed policy revision is `phase-local-repair-v2`. Updating it invalidates an active
automatic reservation's old policy binding without refunding its consumed attempt.

## Failure handling

| Failure | Continuation |
| --- | --- |
| Incomplete artifact, traceability or evidence | Its configured producer repairs the current draft, or regenerates a kernel-owned output, then rechecks. |
| Failing tests, runner, dependency or runtime | Inspect the exact execution and bounded failure examples. Repair within the admitted scope, verify the cause changed, then run the fresh required gate. A runtime repair can keep source unchanged. |
| Missing or malformed structured report | Repair the reporter/result contract; process success alone supplies no passing evidence. |
| Unknown failure | Diagnose from retained facts, then name its owner and exact action if it cannot be resolved within the current contract. |
| Scope, clarification, approval or risk decision | Prepare the supported owner action. Continue other admitted repairs while the decision is pending. |
| Published or upstream input integrity | Preserve both versions and use authenticated restoration, an authorized successor or the owning authority. |
| Credentials or unavailable external prerequisite | Name the required owner action and retain the continuation; never fabricate access or a successful result. |

`resolution.repairContinuation` describes the tasks and their owners. Required-test refusals carry
`remediationPlan.repairContinuation`, and their agent action starts diagnosis instead of ending the
authoring turn merely because tests failed. These projections grant no mutation permission.
A publication-only or independent-review turn still hands authoring to its configured producer.
An original integrity finding keeps its identity even when nested source-code hints name an
ordinary quality defect; those hints cannot create a repair permission or risk exception.

Each task has a stable case ID bound to the Story, phase, generation, intent and finding. It separates
the phase detecting a defect from the phase owning the affected input, and names the repair executor,
required authority, verification gate and interrupted transition. Two clauses do not share a case
merely because the same check reported them. A successful diagnostic command does not resolve a case.
Unknown or external failures retain a named owner task and a resume point.

Recovery copies and input restoration target the current consuming phase. They never offer a
checkpoint of an approved earlier phase. Authenticated upstream bytes can be restored; a content
change still goes to that input's authority through its linked issue or amendment.

Submitted work always has an authorized same-phase correction route, including older pinned and
future custom workflows whose business send-back list omits themselves. The existing reviewer uses
`reject <current-phase> --to <current-phase> --reason <reason>`; the author then repairs a successor.
This does not change the configured earlier send-back targets, invalidate prior phase approvals,
waive a repair budget, grant source-edit permission or let an agent reject on the human's behalf.
Scope-only supporting-path accounting still uses its narrower plan decision when no new authoring
is needed. The UI and CLI share these lifecycle predicates.

Test-definition drift is diagnosed before requesting a new pin. Keep a repair that preserves the
existing definition when an incidental configuration edit is unnecessary; never discard intentional
human changes or narrow the tests. Necessary definition changes still need their exact human review.
Repeated requests reuse the same pending request without a new commit. The handoff offers a Copilot
review route separately from acceptance in the person's terminal.

If the current definition is verified to match its original pin again, the unaccepted re-pin request
stays in history and is reported as inactive rather than another pending decision. This records no
acceptance and changes no pin. Unreadable definitions retain their pending review and diagnostic.

Scope-only approval holds belong to the plan's approvers. An exact test-support path may be
accounted for under an existing test-only clause with a narrow plan amendment. This changes no
clause, primary test, test result or submitted artifact, and never admits product source into a
test-only delivery. Known holds are returned before an approval receipt or full document packet
is created, with the decision-list command on all available surfaces. Human visual witnessing
remains separate from automated tests and scope accounting.
Owed evidence is reported separately; it blocks phase approval only when the approval gate says so.

## Evidence and limits

Failed execution diagnostics retain up to three distinct, redacted, bounded examples from that
invocation's structured report before temporary reports are restored. They identify the SFlow host
runtime separately; a different test toolchain must still be established from the run's own records.
Examples are diagnostic data, not commands, authority, accepted risk, or passing test evidence.
Repair progress uses normalized failing test names, failure examples, counts and verified runtime
identity. Report timestamps, report file hashes, shifted stack line numbers and unrelated edits do
not establish progress. A new failing assertion can establish a changed condition without granting
another budget or crediting a pass.

The existing pinned repair policy and durable journal remain authoritative. A relevant source,
runtime, dependency or evidence condition must change before retrying. Unchanged retries,
oscillation and budget resets are refused. Exhaustion ends unattended retries; it preserves work
and returns the manual/owner continuation instead of making manual correction impossible.
A diagnostic pass does not advance the Story. Publication/submission performs and retains its
fresh required execution; approval remains a separate human decision.

Fresh and cached Story/Initiative prompts receive the current contract at delivery without rewriting
their recorded bytes. Auto authoring receives the same guidance inside its ratified task boundary;
its existing repair admission, scope, attempt limits and human decisions remain in force.

Recovery actions are installed command specifications, delivered as structured argv and rendered
through the shared command guide. Error prose is never parsed into executable instructions. The
source audit permits no legacy prose-only recovery commands. Workflow simulation now includes
same-phase correction alongside business send-back routes; native tests still qualify actual
command execution, permissions, evidence and platform behavior.
