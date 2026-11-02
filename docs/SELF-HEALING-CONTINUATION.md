# Self-healing continuation

Every phase uses the installed `repair-continuation-v1` contract: observe the exact failure,
diagnose it, preserve the draft, repair admitted work, verify the changed condition, and recheck
the original gate. The contract applies to seeded, imported, duplicated and future custom workflows;
it is resolved by the kernel rather than copied into each YAML definition.

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

Test-definition drift is diagnosed before requesting a new pin. Keep a repair that preserves the
existing definition when an incidental configuration edit is unnecessary; never discard intentional
human changes or narrow the tests. Necessary definition changes still need their exact human review.
Repeated requests reuse the same pending request without a new commit. The handoff offers a Copilot
review route separately from acceptance in the person's terminal.

If the current definition is verified to match its original pin again, the unaccepted re-pin request
stays in history and is reported as inactive rather than another pending decision. This records no
acceptance and changes no pin. Unreadable definitions retain their pending review and diagnostic.

## Evidence and limits

Failed execution diagnostics retain up to three distinct, redacted, bounded examples from that
invocation's structured report before temporary reports are restored. They identify the SFlow host
runtime separately; a different test toolchain must still be established from the run's own records.
Examples are diagnostic data, not commands, authority, accepted risk, or passing test evidence.

The existing pinned repair policy and durable journal remain authoritative. A relevant source,
runtime, dependency or evidence condition must change before retrying. Unchanged retries,
oscillation and budget resets are refused. Exhaustion ends unattended retries; it preserves work
and returns the manual/owner continuation instead of making manual correction impossible.
A diagnostic pass does not advance the Story. Publication/submission performs and retains its
fresh required execution; approval remains a separate human decision.

Fresh and cached Story/Initiative prompts receive the current contract at delivery without rewriting
their recorded bytes. Auto authoring receives the same guidance inside its ratified task boundary;
its existing repair admission, scope, attempt limits and human decisions remain in force.
