# SKP implementation status

This tracks implementation of *SPEC-SKP v0.2 — Skill Phases and Bring-Your-Own Workflows*. It is an evidence ledger, not a feature-enable switch. A locally inspected skill is untrusted data; its hash establishes byte identity, not authority or host containment.

| Milestone | Current status | Evidence and boundary |
|---|---|---|
| M0 — compatibility and closed readers | Protective guard and versioned readers implemented; milestone incomplete | Version-2 workflow validation refuses skill-producer fields instead of silently treating them as template phases. Version-3 definitions, version-11 Story records, version-3 WFA amendment snapshots, and version-3 skill workflow bundles have registered readers and migrations; historical records retain their identity and gain no invented audit evidence. This does not prove every M0 acceptance case. `test/skp-compatibility.test.mjs`, `test/mig-golden.test.mjs`, `test/mig-read.test.mjs`. |
| M1 — inspection and contract compilation | Safe capture and terminal-local inactive finalization implemented; milestone incomplete | `skill inspect` reads one explicit local directory without Git, network, model, or execution and returns candidate-only findings. Approved inspection captures exact retained Git blobs before mirror cleanup, checks original asset hashes and copies bytes synchronously without caller Buffer hooks. Private byte seals cannot establish approval, consent or containment. WCA uses a separate versioned pre-consent subject and post-consent closure hash; explicit artifact-only producer classification plus real one-use terminal review can finalize an inactive proposal. The pure confirmed-contract compiler retains its semantics. Live-directory inspection is not qualified against hostile ancestor swaps and cannot masquerade as approved capture. `test/skp-package-seal.test.mjs`, `test/skp-approved-mirror-capture.test.mjs`, `test/wca-skp-finalization.test.mjs`, `test/wca-skp-submission.test.mjs`. |
| M2 — retained Story execution and evidence | Retention, evidence, and hardened AC-053 adoption implemented; milestone incomplete | Stories pin complete approved packages and compiled bindings. The accepted reader verifies bytes, digests, interpretation, configuration provenance, and immutable amendment lineage without a live-folder/latest-name fallback. Reviewed adoption changes exactly one package and reopens only proven affected phases; unknown dependency impact is refused. Other packages and unaffected approvals remain pinned. New decisions carry bounded offline-verifiable configuration ancestry and immutable rejection-review bindings. Existing lifecycle owners retain prior-output receipts, declared artifact membership, publication, and human-approval evidence. Skill preparation, generation, publication, submission, and approval remain refused with `SKP_HOST_ENFORCEMENT_UNAVAILABLE` pending M5; no executable pilot is claimed. `test/skp-snapshot.test.mjs`, `test/skp-amendment-audit.test.mjs`, `test/skp-amendment-plan.test.mjs`, `test/skp-amendment-snapshot.test.mjs`, `test/skp-amendment-transaction.test.mjs`, `test/skp-state-lifecycle.test.mjs`. |
| M3 — BYO and mixed-workflow recipes | Read-only recipes, role validation, and portable transfer implemented; milestone incomplete | `workflow skills-recipe` previews intake → selected approved phases → conformance from exact approved configuration. Code requires explicit earlier acceptance criteria and planning owners; findings/evidence are not criteria. The source-bound digest and separately authorized ordinary proposal route grant no execution. Bundle v3 retains manifests, binary/CRLF bytes, compiled bindings and transitive MCP agent/Story-phase dependencies; complete server scopes are preserved without adding scheduled workflow steps. Source and bundle reader share the traversal, with disconnected-object refusal and Story/Initiative namespace separation. Historical v1/v2 identities and original closure semantics remain stable; import still refuses destination permission widening. Approved-destination import/copy plans bind authority kind, remote fingerprint, observed commit and source commit; a fresh owner plan and the existing proposal owner recheck that destination before mutation, including byte-identical authority changes. Installed hosts, ordinary command scripts and external resources remain prerequisites. Actual skill lifecycle runs depend on M5. `test/skp-workflow-recipe.test.mjs`, `test/skp-transport.test.mjs`, `test/workflow-transfer.test.mjs`, `test/workflow-transfer-cli.test.mjs`. |
| M4 — guided shared authoring | Six-stage editing, shared/private persistence, structural simulation, workflow-only changes, exact selected-Story usage and terminal-local proposals implemented; milestone incomplete | Shared drafts retain exact Git CAS/revision/assets; private encrypted recovery and proven-dead local lock repair remain separate. Preview captures fresh approved authority even inside caller-provided overlays. Workflow-only edits/forks preserve unrelated raw policy and do not repin Stories. Structural simulation is hypothetical and bound into Preview. Valid ordinary packages and explicitly classified artifact-only SKP packages have separate live terminal review. SKP review binds agent body/default mapping to retained request and emitted bytes, then retains pre-consent and finalization identities in a new closed snapshot family. Staged bytes/modes, changed paths, committed tree and base-parent fences prevent unreviewed writes. Submission is not approval, activation or execution. Mediated-host confirmation, broader simulation, installed-host/crash/Linux/Windows recovery, shared-object/history inventory and native runner qualification remain incomplete. `test/wca-compiler.test.mjs`, `test/wca-skp-finalization.test.mjs`, `test/wca-skp-submission.test.mjs`, `test/wca-submission.test.mjs`, `test/wca-staged-proposal.test.mjs`, `test/vscode-workflow-drafts-skill-classification.test.mjs`, `test/vscode-workflow-drafts.test.mjs`, `test/vscode-workflow-drafts-recovery.test.mjs`, `test/vscode-workflow-drafts-lock-recovery.test.mjs`. |
| M5 — host/platform qualification | Not implemented | `src/skp-host-admission.mjs` checks structured operation-bound enforcement evidence but is **not connected to a qualified host adapter** and cannot establish a sandbox itself. Real pre-effect read/write/tool/egress/control/process enforcement and delivery acknowledgement must be tested on supported installed hosts before launch. |
| M6 — pilot/promotion | Not started | Requires actual end-to-end approved Story runs and measured release evidence. |

The phase engine can retain and inspect a versioned skill-backed Story, but no current CLI or Copilot command launches, publishes, or approves an imported skill as a phase. A selected skill is not an execution grant. Do not interpret this status as SKP pilot readiness.

AC-053's reviewed adoption path uses `singularity-flow story skill-version status|preview|propose|decide` (Copilot: `/sf-story-skill-version`). Preview is read-only and returns an exact digest; proposal and reviewer decision are separate confirmed commits. The decision must bind the prior accepted Story reference, the newly approved package and compiled binding, the dependency impact, and eligible human reviewers. A threshold approval creates an immutable WFA revision with parent and genesis lineage in the same governed Story publication; rejected or still-pending proposals leave the original pin intact. The accepted reader rechecks the proposal, impact, every approval reviewer record, decision, retained bytes, and full revision chain. Affected approvals require a new published generation before submission; evidence proven independent is preserved byte-identically. The route adopts one changed skill package per amendment, including Stories that select multiple skills. It does not resolve unknown dependencies by guessing and does not authorize skill execution before M5 qualification.

The two M2 audit gaps are now closed for new decisions. They retain bounded raw Git commit ancestry from the prior configuration commit to the accepted same-authority revision. The reader verifies hashes and parent links offline, including in a fresh clone without configuration objects. Rewritten, incomplete, oversized, or ambiguous history is refused without latest-name fallback. Rejected summaries bind immutable review bytes and human identity; reload detects edits, downgrade, summary deletion, and whole evidence-namespace deletion. Historical decisions remain readable in their original dialect without newly invented proofs. `test/skp-amendment-audit.test.mjs`, `test/skp-amendment-transaction.test.mjs`.

## Delivered commands

- Local candidate: Shell `singularity-flow skill inspect <LOCAL-DIRECTORY> --json`; Copilot `/sf-skill inspect <LOCAL-DIRECTORY>`.
- Current approved catalog: Shell `singularity-flow skill approved <ID> --json`; Copilot `/sf-skill approved <ID>`.
- Exact Story pin: Shell `singularity-flow skill doctor <ID> --story <STORY> --phase <PHASE> --json`; Copilot `/sf-skill doctor <ID> --story <STORY> --phase <PHASE>`.
- BYO preview: Shell `singularity-flow workflow skills-recipe <NEW-ID> --label <TEXT> --phases <APPROVED-PHASES> --json`; Copilot `/sf-workflows skills-recipe <NEW-ID> --label <TEXT> --phases <APPROVED-PHASES>`.
- Exact workflow dependencies: Shell `singularity-flow workflow export|import ...`; Copilot `/sf-workflows export|import ...`. Import requires preview and explicit confirmation.
- Shared draft catalog: Shell `singularity-flow workflow author list --json`; Copilot `/sf-workflows author list --json`.
- Shared revision: Shell `singularity-flow workflow author read WFD-<ID> --json`; Copilot `/sf-workflows author read WFD-<ID> --json`. These drafts are not active workflows.
- Exact saved-package preview: Shell `singularity-flow workflow author preview WFD-<ID> --revision <N> --json`; Copilot `/sf-workflows author preview WFD-<ID> --revision <N> --json`.
- Installed Story structural simulation: Shell `singularity-flow workflow simulate <WORKFLOW-ID> --json`; Copilot `/sf-workflows simulate <WORKFLOW-ID> --json`. The report is hypothetical and read-only, not a Story execution or readiness grant.
- Navigation-only approved choices: Shell `singularity-flow workflow author catalog --kind quality-command --limit 32 --cursor 0 --json`; Copilot `/sf-workflows author catalog --kind quality-command --limit 32 --cursor 0 --json`. A visible reviewer or operation ID grants neither membership nor execution.
- Bounded approved-configuration usage: Shell `singularity-flow workflow author where-used <SKILL-ID> --limit 32 --cursor 0 --json`; Copilot `/sf-workflows author where-used <SKILL-ID> --limit 32 --cursor 0 --json`. Exact package references and ID-only agent declarations are distinct. Subsequent pages require the returned source digest with `--expected-source`; Story/history/provider-principal coverage is not claimed.
- Exact selected-Story usage: Shell `singularity-flow workflow author where-used <SKILL-ID> --story <STORY> --ref refs/heads/<BRANCH> --commit <GIT-OID> --snapshot-revision <N> --json`; Copilot `/sf-workflows author where-used <SKILL-ID> --story <STORY> --ref refs/heads/<BRANCH> --commit <GIT-OID> --snapshot-revision <N> --json`. Ref, commit and snapshot selectors are optional assertions on one explicit Story; there is no fetch, Story scan or latest-package fallback.
- Separate review proposal: Shell `singularity-flow workflow author submit WFD-<ID> --revision <N> --json`; Copilot `/sf-workflows author submit WFD-<ID> --revision <N> --json`. A headless invocation returns a terminal handoff; only a fresh live terminal review can submit. No caller-written confirmation flag or receipt substitutes for that event.

Code recipes also require `--planned-claims required --clause-phases <CRITERIA> --claim-owners <CODE=PLAN>`. See [workflow authoring](topics/workflow-authoring.md) for examples.

## Remaining work

1. Implement/integrate authenticated mediated-host confirmation and broader shared-agent/template/skill edits; qualify installed-host/crash/Linux/Windows private recovery. Exact ordinary shared-phase edits now bind every declared consumer in the captured catalog, but do not cover global Story/history inventory or native provider-principal/revocation qualification. Simulation now projects prospective package-amendment invalidation; historical receipt validation and contract/parser/adapter/runtime changes remain separate. Terminal-local inactive finalization is not full M4 readiness.
2. Qualify live-directory capture against hostile ancestor swaps and implement a real M5 host adapter with native enforcement and exact delivery evidence. Keep execution closed meanwhile.
3. Run actual two-client shared-authoring and mixed/code/non-code Story pilots and collect M6 release evidence.

## September 27 source-side completion pass

The user confirmed that no approved isolated runner or Windows/Linux test hosts are available.
No imported-skill execution or release qualification is enabled by this pass.

- **Shared phase review:** explicit `wca-shared-phase-impact/v1` requests replace exact ordinary
  raw phases through fresh Preview and the existing separately authorized proposal writer.
  Complete bounded reverse catalog impact, effective overrides and all affected workflow
  simulations are bound into review. Only selected phase YAML changes; app files, approved refs
  and Story pins remain unchanged. Agent/template/skill/effect mutations are not supported.
  `test/wca-shared-phase-changes.test.mjs`, `test/wca-compiler.test.mjs`.
- **Broader structural simulation:** the existing skill amendment planner identifies affected,
  preserved and unknown phases for prospective single-package changes. Hypothetical fresh
  publication/review invalidates only dependent evidence and preserves proven-independent
  approvals. Unknown dependencies and unavailable generations refuse reuse. Retained historical
  submission readers continue checking their stored reports, not today's simulation output.
  `test/wca-simulation.test.mjs`.
- **Qualification and pilot tooling:** `npm run qualification:skp` is read-only;
  `npm run test:platform:skp` runs fixed bounded checkout fixtures. Its source-bound, content-free
  report distinguishes actual local Git/CLI/PTY observations from native installed-host and
  human evidence. `npm run test:release:skp` returns 2 for missing qualification. The pilot plan
  records prerequisite and denominator/timing/merge/Passport fields without creating a pilot
  result. Source-checkout commands have no product Copilot equivalent; Copilot may explicitly
  run these shell commands but cannot qualify itself. `test/skp-qualification.test.mjs`.

The real adapter is still missing. The registered model provider is Copilot CLI: its current ACP
permission/post-run checks do not prove pre-effect read, egress, credential or control-plane
containment. Local staged-prompt verification is not exact host delivery acknowledgement.
Connecting supplied evidence labels to lifecycle admission would not fix those missing controls.
M5 requires an approved existing host/runner and observed enforcement; M6 requires actual human
clients and end-to-end accepted Stories. The test harness is tooling, not their completion.

## Delivered terminal-local skill finalization

1. A versioned pre-consent subject binds the exact retained draft, approved source,
   package bytes, contract/policy and reviewed effect scope, without depending on future consent
   or the final Preview digest.
2. A separate finalization hash domain binds the consumed subject, confirmed binding and
   emitted candidate closure. Do not make the final Preview hash an input to a binding that the
   same Preview contains; this would be self-referential rather than an exact review identity.
3. The existing direct-terminal action owner consumes real one-use consent to the reviewed
   subject. Fresh source checks precede finalization and proposal writes. A proposed producer
   requires the exact explicit local classification below, never silent approved eligibility. Finalization cannot infer
   native enforcement, installed-host qualification, activation or execution permission.

In **Team & skills**, select **Request artifact-only local review classification** for the exact
new skill; the default is no classification. Its advanced JSON is:

```json
"producerClassification": {
  "profile": "local-reviewed-artifact-producer/v1",
  "eligibility": "candidate-producer"
}
```

SKP phase contracts remain explicit advanced JSON, not an ordinary template fallback. Save and
Preview the exact revision, then use Shell `singularity-flow workflow author submit WFD-<ID>
--revision <N> --json` or Copilot `/sf-workflows author submit WFD-<ID> --revision <N> --json`.
Headless Copilot only returns a terminal handoff. The live terminal presents classification,
package, contracts, policy and source identities with Cancel as default. Confirmation creates an
inactive configuration review branch; it does not run the skill. Missing classification, stale
sources, forged receipts or replay refuse without candidate writes.

New SKP proposals retain `workflow-authoring-skill-submission-snapshot@1` under
`singularity/workflow-authoring-skill-submissions/<finalization-hash>.json`. Nested pre-consent
subject and finalization records have separate registered version-1 families and hash domains.
Ordinary submission snapshots remain version 1 in their original dialect. Historical record
validation proves consistency only; persisted JSON is never a live confirmation capability.

The current safe built-in-only runner selection does not qualify imported skill execution. Foundation tests are not substitutes for shared-authoring and native-host acceptance cases.

`workflow author where-used` reads one freshly verified approved configuration snapshot through its
existing Git read owner, verifies the selected retained skill package and returns bounded, paginated
phase, repository-agent and workflow references. It distinguishes exact package bindings from
ID-only remote-skill declarations and projects only declared code/criteria/planning relationships.
It does not open the shared draft store, fetch declared remote skills, search Story branches or
other repositories, invoke a model, repair consumers or grant execution. The report identifies
coverage exclusions and its source digest; source drift refuses later pages, and over-budget or
credential-shaped projections are refused rather than disclosed as partial success.
Git repository read access is not authenticated per-team or per-person membership. With explicit
`--story`, the separate local-object reader verifies one selected accepted Story revision. `--ref`
defaults to `HEAD` and can name one local `refs/heads/…` or `refs/remotes/…` ref; `--commit` must be
reachable from that observed ref, and `--snapshot-revision` asserts the revision stored at that
commit rather than searching for it. It verifies retained package bytes, accepted amendment
lineage and immutable review evidence. The profile caps ancestry at 256 commits, snapshot revision
at 64, phase/reference rows at 512, and each page at 64 rows/256 KiB. Later pages require the exact
source digest. Missing or shallow ancestry, source drift and exceeded limits are refusals, not
empty inventories; no unshallow, lazy fetch or draft-store contact is allowed. Other Stories,
revisions, authorities, execution usage and native-provider access/revocation are not assessed.
`test/skp-usage.test.mjs`, `test/skp-story-usage.test.mjs`, `test/wca-workflow-author-cli.test.mjs`.

Workflow-only `edit` and linked `fork` requests use `sflow-workflow-request@2`, an exact raw parent
`expectedDefinitionSha256` and the captured approved base revision. They may explicitly change
workflow label, description, phase order, planned claims or rework loops; omitted advanced fields
remain intact. Emitted YAML preserves unrelated raw configuration instead of serializing runtime
defaults into shared policy. Existing phases, roles, templates, approval and MCP contracts remain
linked; the bounded declared graph and dependency identities are bound into Preview. Effective
workflow overrides, not only base phases, own input/output/template/review validation. New shared
objects, deletion, ambiguous/missing dependencies and changed SKP phase order are not inferred.
Changing SKP membership/order requires a separately recompiled confirmed contract. Existing Story
pins are unchanged, and usage in other repositories or retained Stories is not inventoried by this
impact planner. Native skill discovery, approval and execution remain unavailable.
`test/wca-workflow-changes.test.mjs`, `test/wca-compiler.test.mjs`.

Compiler `wca-complete-package/v4` emits unassigned candidate skill files only into inert canonical
`singularity/skills/<ID>/…`, never native skill discovery. Creating an existing approved package
ID is refused even when it is unassigned or currently contains only resource files; creation
cannot overwrite a retained package through a missing `SKILL.md` shortcut. Mixed ordinary/SKP
proposals resolve normalized earlier ordinary output contracts independently of declaration order.
Before consent, new SKP phases emit no candidate files and retain proposal-only bindings.
Complete artifact-only packages with explicit classification and agent selection can proceed to
separate terminal review; confirmed emission changes only reviewed SKP phases and leaves ordinary
policy intact. Post-consent structural simulation is still hypothetical. No host qualification is inferred.
`test/wca-compiler.test.mjs`, `test/vscode-workflow-drafts.test.mjs`.

VS Code's **Configuration Center → Shared workflow drafts** (also available in the Command Palette)
organizes Goal, Stages, Team & skills, Access & review, Review package, and Submit & next steps.
It preserves the advanced literal JSON/assets alongside typed edits; missing prompts, artifact
contracts and unsupported bindings are not fabricated. Shared autosave must be enabled for the
exact opened draft and authority. A shared Saved message requires the CLI owner's acknowledgement,
not a timer. Conflicts, newer captured edits and uncertain acknowledgements preserve the pending
buffer; operation-status reconciliation precedes a changed retry or replacement. Refreshing a list
never silently rebases the editor. Binary assets remain read-only. Explicit Exit can flush eligible
captured edits, but native tab/application close guarantees no shared flush. Encrypted private
checkpoints are separately acknowledged on this machine. Reopening the same repository/draft
offers explicit Restore/Compare/Discard without automatic shared writes. Exact base drift is
refused; operation-status reconciliation precedes restoring or discarding an uncertain write.
Corruption, missing SecretStorage keys and writer contention fail visibly without plaintext
fallback. A still-pending or oversized visible edit is not durably captured. Installed native
crash/restart and Windows credential-storage qualification remain pending; unit fixtures are not
release evidence. Read-only private refresh preserves the current editor and retries exact-scope
inspection. An interrupted writer's lock leaves retained ciphertext readable but does not permit
automatic mutation/unlocking. **Inspect private locks (read-only)** and **Review dead lock repair…**
operate only on the opened draft's exact local scope or its directory-wide key-init lock. New closed
owner records retain process/lock nonces and a hashed native process domain. Repair requires native
same-domain process absence, a one-use host-held inspection ticket, Cancel-default native review,
and fresh inode/bytes/nonce checks under a cross-process barrier. It removes only that lock, never
ciphertext, keys or shared state, and does not resume a save. Age/PID alone, live or unknown owners,
old empty locks, another boot/domain and interrupted repair barriers remain fail-closed. macOS and
Linux have fixed native read-only probes; Windows repair is unavailable without a qualified
process-domain owner. macOS child-process fixtures are implementation evidence, not installed
VS Code, Linux, Windows or power-loss qualification. Hostile same-user ancestor-swap containment
remains unqualified. `test/vscode-workflow-drafts-lock-recovery.test.mjs`.
See [workflow authoring](topics/workflow-authoring.md#recover-private-pending-edits-in-vs-code).
The exact-base Restore check requires a proven complete saved payload/asset closure; an advanced
partial-envelope baseline can remain Compare-only without inferred fields. Actual encrypted-file
restart tests complement the real-Git client fixture, not native credential or host qualification.
`test/vscode-workflow-drafts-recovery-integration.test.mjs`.

The UI displays actual source-bound Preview/catalog/Show results and copies rooted Shell or
Copilot submission-review routes; it does not submit, approve, delete or execute from the webview.
The terminal independently refreshes and presents the saved package with Cancel as default. New
SKP phases remain proposal-only until exact local classification and one-use consent finalize an
inactive proposal. Imported execution stays blocked. The shared
`story-structural-lifecycle/v1` report now projects a bounded set of Story lifecycle scenarios from
normalized contracts and shared runtime predicates. `complete-for-profile` is not evidence of real
artifact contents, command/model behavior, approval/publication, human availability or host
enforcement. Unknown contracts, legacy claim migration requirements and limit exhaustion cannot
produce a complete report. Initiative execution and historical amendment impact are excluded.
The UI shows the status, exclusions and hypothetical scenario table; Preview binds the exact report
and profile into its plan digest. Distinct required reviewer groups must have a feasible matching
of distinct configured identities, rather than only a large union of names.
`test/lifecycle-transitions.test.mjs`, `test/approval-authority.test.mjs`,
`test/wca-simulation.test.mjs`, `test/workflow-simulation.test.mjs`,
`test/vscode-workflow-simulation.test.mjs`.
CLI-backed independent-client tests cover shared revision identity, conflicts, captured catalog
choices and the copy-only handoff. `test/vscode-workflow-drafts.test.mjs`,
`test/vscode-extension.test.mjs`, `test/wca-compiler.test.mjs`, `test/wca-submission.test.mjs`.

The draft transport's real local-bare-repository, two-clone tests establish client CAS and immutable
byte retention, not native provider principal identity/revocation or Windows installation. Git ACLs
are repository-wide; Git author name/email are presentation metadata, not authenticated principals.
Actual terminal fixtures exercise review, cancellation and publication fences, not a human pilot or
authenticated mediated-host consent.
Out-of-protocol repository administrators can rewrite refs. Disk budgets are checked after a bounded
fetch completes, not by an installed streaming download quota. No provider credentials are stored.
