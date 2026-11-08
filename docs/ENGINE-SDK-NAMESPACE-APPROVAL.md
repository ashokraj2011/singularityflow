# Human approval through explicit namespace ports

`hosts/namespace-approval` implements the registered `phase.approve` operation for the initial
primary-document profile. It uses shared records and content, an application-authenticated identity
port, and a clock. It needs no private draft, original laptop, source checkout, Git or model provider.
Installed Git approval retains its existing implementation, authority and public output.

```js
import { createNamespaceApprovalEngine } from '@singularity-flow/engine-sdk/hosts/namespace-approval';

const engine = createNamespaceApprovalEngine({
  records, content, scope: { projectId }, workId, authority,
  access: authenticatedApplicationAccess,
  clock: applicationClock
});
const review = await engine.run('phase.review', { phaseId });
// Present the verified documents, obtain the human's explicit confirmation of this exact binding.
const confirmation = await askHumanToConfirm(review.manifest.reviewBinding);
await engine.run('phase.approve', { phaseId, confirmation });
```

The application supplies the human interaction and maps the reviewed binding to
`{ workId, phase, generation, reviewPacketSha256 }`. Reading a manifest, opening documents or model
output does not constitute human confirmation. The access port must authenticate the human and
supply current `phase.approve` permission. Its `principalId`, identity and agent are trusted host
facts, never operation inputs. Service identities cannot approve. A read-only reviewer agent cannot
record a phase approval; a human may approve without selecting an authoring agent.

## Exact evidence and one authority rule

The shared submission reader verifies the actual immutable review packet, publication, artifact,
configuration and lineage. It can inspect a historical accepted submission without treating it as
a currently submitted approval opportunity. An old submission pointer does not submit a successor
generation. Missing, corrupt and unsupported records remain distinct from an unsubmitted phase.

The approval writer stores an immutable `sflow-namespace-primary-approval-artifact-set/v1` and
`sflow-namespace-phase-approval-vote/v1`. They bind the exact submitted packet, actual artifact
content reference, configuration pin, authenticated human and audit agent, original canonical
revision, timestamp, authority group, self-approval disclosure and resulting threshold. Storage
revisions are opaque; no Git commit, test execution, visual witness or application acceptance is
fabricated. The canonical phase keeps a typed reference to that vote.

The kernel uses the existing pinned group membership, self-approval and distinct-human quorum
rules. Explicit principals also prevent a person gaining independence by changing their email.
Required groups need the distinct reviewers the policy specifies. Before counting active votes,
the reader checks their immutable bytes and canonical metadata and recomputes their authority and
quorum in accepted order. An unverified legacy vote needs its actual owner; it is never counted
from a caller-supplied flag.

A vote below threshold leaves the phase awaiting approval. Reaching threshold records approval
and advances the ordinary sequential workflow in the same conditional transaction. The final phase
sets `status: closed` and `currentPhase: null`. Historical phase/document reads remain available.
This completes a reviewed-document workflow, not a claim of delivered or tested application code.

## Retry, concurrency and takeover

The submitted packet, authenticated reviewer, normalized request, canonical revision and authority
basis select a stable candidate. A prepared candidate retains its original identity and timestamp.
Permission and actor checks run again before acceptance, and the final write requires the captured
Story, authority and configuration revisions. Revocation preserves the candidate. A changed person
cannot accept another person's preparation. A legitimate concurrent vote requires fresh quorum
evaluation against the new canonical basis; the old candidate remains retained and cannot overwrite
the newer state.

After acceptance, the same authenticated human can acknowledge the original receipt on another
host without new approval permission or a clock sample, including after the writer is fenced.
The original audit agent stays on that receipt even if the current prompt uses another agent.
Changing the authenticated human identity is refused. An explicitly supplied stale confirmation
is still refused. Retrying cannot append another vote or acquire another required group's authority.

The v1 SDK result acknowledges the original accepted transaction: its `revision`, threshold and
`currentPhase` describe that vote's outcome. A previous below-threshold vote can be acknowledged
after another person completes the phase; it does not claim the Story is still awaiting approval.
Read current state before selecting a new action. Real storage errors and timeout details survive
unchanged. A lost acknowledgement is reconciled through the retained candidate and original receipt.

## Remaining scope

This advances Phase 7 with real namespace human approval and sequential completion. Full application
code and test execution, source review, checklists, witnesses, presence, automatic approval,
branch/loop/choice routing and other additional policies require their actual operation owners.
The initial profile returns `ENGINE_PORT_UNAVAILABLE` for those requirements instead of accepting
readiness booleans or silently following a linear route. Existing-project migration and installed
authority cutover remain Phase 8; final cleanup, distribution and performance remain Phase 9.

## Mac qualification

191 distinct checks across 13 affected files passed on macOS with Node 26.12.0. The final
93-case set passed without failures, cancellations or skips; overlapping earlier cases are counted
once. Tests use actual empty-store enrollment, configuration approval, Story creation, private
authoring, publication, submission and human approval. Two authored phases complete with an
independent reviewing principal on filesystem, SQLite and application-journal backends. Permission
changes, changed people, concurrent votes, lost acknowledgements, fencing, malformed/future records
and original read/write errors retain their required outcomes.

The installed npm archive completes and acknowledges the real document Story in independent
empty-PATH processes with native Git/process imports refused. Installed NodeNext declarations and
negative examples passed. Existing native CLI/SDK approval output, selection receipts, partial
thresholds, duplicate reviewers and post-commit recovery retain their compatibility checks.

Source validation passed 3,823 checks across 191 skills. VS Code typechecking, the unchanged
2,011-site Git ownership audit and all 13 existing bundle budgets passed. The gateway remains at
851 modules and the extension at 152, without raised ceilings. The SDK preview contains 49
registered operations, 113 owned modules and 1,160,458 runtime bytes. These are artifact counts,
not a complete application-Story latency measurement or completion of the remaining milestones.
No Windows, hosted CI, live provider, installed-authority change, real Story migration, push or
merge was performed.
