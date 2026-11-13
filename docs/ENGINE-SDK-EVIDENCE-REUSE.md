# Retained execution reuse

The namespace Engine now provides `evidence-reuse.context` and binds the existing
`decision.evidence-reuse` operation to its own conditional human-decision owner. An artifact phase
can reuse an earlier approved phase's actual passing test execution when the complete command and
repository selection and the current source inventory match. It does not become a test execution
by the receiving phase or an acceptance decision for an application criterion.

## Ownership and compatibility

- The kernel owns reason and expiry rules, source-free lifecycle status and the separately
  versioned namespace decision projection. Native reason, expiry and revocation behavior is
  compared with 24 outcomes captured from the original `70876ea3c` implementation. Original
  native attempt IDs, Git commits, records, hashes, presence admission and command labels remain
  in their native compatibility owner.
- The SDK coordinates context reads, authenticated human authorization, final source checks,
  conditional recording, publication, submission, independent approval and recovery.
- SDA retains original decision, publication, submission, vote, check and source observations
  with their actual conditional receipts. A receipt acknowledges the same decision after a lost
  reply; changing the reason cannot create a second standing decision for the same receiving
  command and repository.
- SGOS remains the execution owner. Candidates name the original task ID, result digest, process
  closure, structured report, source snapshots and original approving generation. They do not
  invent native `TA-` IDs or put namespace hashes in Git commit fields.

New records use `sflow-namespace-evidence-reuse/v1`; the retained publication policy is
`evidence-reuse/v1`. Its report explicitly records `testsExecutedByReceiver: false`,
`environmentRechecked: false` and `failuresWaived: false`. It preserves the original producer,
command, repository, tests, task and human reuse decision. The original publication and check
profiles keep their meanings.

## Using the namespace host

1. Execute and publish the producer's actual checks, submit its packet and obtain its real human
   approval. Local or preflight-only results and raw workflow counts are ineligible.
2. Read `evidence-reuse.context` with the receiving `phaseId`. It returns actual candidates,
   source-match observations, required authorities and registered actions. Both configured and
   explicitly accepted additive Story commands qualify.
3. Under an authenticated human reviewer, call `decision.evidence-reuse` using the exact returned
   `attemptId`, receiving `phaseId`, substantive `reason` and optional bounded `expires` date.
   The original execution and current source are read again before acceptance.
4. Prepare and author the receiving artifact, then prepublish and publish it. Prepublish reports
   `reused-not-executed`. A real current check run takes precedence over reuse.
5. Submit and independently approve the receiving packet. Source, producer generation, exact
   command, revocation and expiry are checked again before these new effects.

A complete reuse set must cover every configured command and participating repository. Failed,
skipped, cancelled, unstructured, superseded or mismatched executions cannot fill a gap. Changed
source, revoked or expired authorization, or a changed command returns actual current-check and
reuse-context actions. Genuine missing-file, permission and storage timeout errors retain their
original identity and details. Required visual decisions and other policy owners remain separate.

Original receipts and approved publications replay with no source checkout, private draft, clock
or executor. New authorization and consumption require the actual current source ports. Source
contents, uploaded documents and images retain their existing storage/locality contracts.

## Deliberate profile limits

This profile serves artifact-only receiving phases. Code receivers still require their own Code
execution owner. Recovery agreements whose current profile explicitly forbids reuse retain that
contract; cohort/environment-sensitive reuse needs its separate agreement and execution owner.
Non-test commands cannot be relabelled as tests. This delivery does not complete those remaining
risk, cohort, live application-review or required external execution/evidence owners.

The `testing/reuse` SDK export exposes pure bounded value helpers and typed provenance. An
`active` lifecycle status alone does not establish current source, authentic execution or human
acceptance. Host construction and the registered proof owners retain those responsibilities.

## Mac qualification

The delivery passes 236 distinct affected Mac checks with no skips or cancellations, including
all-three-store journeys, additive commands, changed source/argv, independent authority,
revocation, expiry at submission and approval, lost acknowledgements, preserved storage errors,
source-free approved replay, 106 architecture guards, native compatibility and an offline
installed consumer with strict NodeNext declarations and an empty `PATH`.

The unchanged 34-check installed qualifier ran alone in 52.4 seconds within its original
120-second parent and 60-second child limits. VS Code typechecking, the unchanged 2,011-site
Git audit and all thirteen original bundle ceilings pass; the gateway is 852/852 modules. Source
validation passes 4,348 checks. No Windows, live provider,
production installation, real Story mutation or main merge is part of this qualification.

The registry has 88 operations: 42 default native bindings and 78 namespace bindings before
optional check/repair execution. See the [active completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md)
for the remaining Phase 5/7 work; neither phase is marked complete.
