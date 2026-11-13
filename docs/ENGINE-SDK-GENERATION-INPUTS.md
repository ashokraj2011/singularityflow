# Namespace generation and input boundaries

`phase.begin`, `phase.prepare` and `phase.inputs` share the real device-local preparation owner.
Beginning an already open generation retains its original intent. Editing its artifact does not
create another generation. Each operation checks its own permission and the pinned author,
configuration, current Story and repository bindings. Shared lifecycle state is unchanged.

The namespace begin result has the explicit `sflow-namespace-generation-intent/v1` profile with
`baselineRevision`. Its digest names the actual retained generation intent (Code) or preparation
context (document phases). The existing native Git result keeps `baselineCommit` and its exact
fields. A namespace revision is never presented as a Git commit.

`phase.inputs` returns `sflow-phase-input-manifest/v2` for namespace storage. It identifies the
actual prepared artifact, retained local input context and declared resource references. Approved
input references are authenticated through their original publication and independent approval
proofs. The audit contains resource metadata; attachment contents stay in their separate local
store. A missing attachment still requires re-upload on that device.

`dryRun: true` checks the resources without preparing an artifact, opening a generation, retaining
an audit or changing shared/private progress. Missing, permission and timeout errors remain real
errors. Preparation is not authorship, passing tests, publication or human approval.

Mac qualification passes 47 affected checks: the existing native begin/input contracts, ordinary
private preparation, all three namespace backends, retained Code begin, missing-content errors
and rejection of malformed input manifests. [Reviewed source adoption and rollover](ENGINE-SDK-SOURCE-OPENINGS.md)
now have a separate namespace owner; deterministic convergence has its own delivered producer.
Other required producers remain explicit completion-ledger work.

The human-witness hash, checklist, record and active-result rules now have one pure kernel owner.
The native adapter retains file reads and its existing recovery rendering. Frozen pre-extraction
results, native witness continuations and retained-evidence checks pass 25 cases on this Mac.

Final Mac checks also pass nine native CLI/SDK parity cases, 88 architecture checks, 4,136 source
checks, schema/type checks, Git process ownership and all 13 unchanged bundle budgets. The
unchanged installed-package qualifier passes all 34 checks in 66.6 seconds, run alone within its
original 120-second parent and 60-second child limits. No Windows, hosted CI, live provider,
installed application mutation or main merge was run.
