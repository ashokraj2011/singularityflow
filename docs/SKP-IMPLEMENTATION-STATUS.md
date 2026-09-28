# SKP implementation status

This tracks implementation of *SPEC-SKP v0.2 — Skill Phases and Bring-Your-Own Workflows*. It is an evidence ledger, not a feature-enable switch. A locally inspected skill is untrusted data; its hash establishes byte identity, not authority or host containment.

| Milestone | Current status | Evidence and boundary |
|---|---|---|
| M0 — compatibility and closed readers | Protective guard and versioned readers implemented; milestone incomplete | Version-2 workflow validation refuses skill-producer fields instead of silently treating them as template phases. Version-3 definitions, version-11 Story records, version-3 WFA amendment snapshots, and version-3 skill workflow bundles have registered readers and migrations; historical records retain their identity and gain no invented audit evidence. This does not prove every M0 acceptance case. `test/skp-compatibility.test.mjs`, `test/mig-golden.test.mjs`, `test/mig-read.test.mjs`. |
| M1 — inspection and contract compilation | Safe capture and terminal-local inactive finalization implemented; milestone incomplete | `skill inspect` reads one explicit local directory without Git, network, model, or execution and returns candidate-only findings. Approved inspection captures exact retained Git blobs before mirror cleanup, checks original asset hashes and copies bytes synchronously without caller Buffer hooks. Private byte seals cannot establish approval, consent or containment. WCA uses a separate versioned pre-consent subject and post-consent closure hash; explicit artifact-only producer classification plus real one-use terminal review can finalize an inactive proposal. The pure confirmed-contract compiler retains its semantics. Live-directory inspection is not qualified against hostile ancestor swaps and cannot masquerade as approved capture. `test/skp-package-seal.test.mjs`, `test/skp-approved-mirror-capture.test.mjs`, `test/wca-skp-finalization.test.mjs`, `test/wca-skp-submission.test.mjs`. |
| M2 — retained Story execution and evidence | Retention, evidence, and hardened AC-053 adoption implemented; milestone incomplete | Stories pin complete approved packages and compiled bindings. The accepted reader verifies bytes, digests, interpretation, configuration provenance, and immutable amendment lineage without a live-folder/latest-name fallback. Reviewed adoption changes exactly one package and reopens only proven affected phases; unknown dependency impact is refused. Other packages and unaffected approvals remain pinned. New decisions carry bounded offline-verifiable configuration ancestry and immutable rejection-review bindings. Existing lifecycle owners retain prior-output receipts, declared artifact membership, publication, and human-approval evidence. Skill preparation, generation, publication, submission, and approval remain refused with `SKP_HOST_ENFORCEMENT_UNAVAILABLE` pending M5; no executable pilot is claimed. `test/skp-snapshot.test.mjs`, `test/skp-amendment-audit.test.mjs`, `test/skp-amendment-plan.test.mjs`, `test/skp-amendment-snapshot.test.mjs`, `test/skp-amendment-transaction.test.mjs`, `test/skp-state-lifecycle.test.mjs`. |
| M3 — BYO and mixed-workflow recipes | Read-only recipes, role validation, and portable transfer implemented; milestone incomplete | `workflow skills-recipe` previews intake → selected approved phases → conformance from exact approved configuration. Code requires explicit earlier acceptance criteria and planning owners; findings/evidence are not criteria. The source-bound digest and separately authorized ordinary proposal route grant no execution. Bundle v3 retains manifests, binary/CRLF bytes, compiled bindings and transitive MCP agent/Story-phase dependencies; complete server scopes are preserved without adding scheduled workflow steps. Source and bundle reader share the traversal, with disconnected-object refusal and Story/Initiative namespace separation. Historical v1/v2 identities and original closure semantics remain stable; import still refuses destination permission widening. Approved-destination import/copy plans bind authority kind, remote fingerprint, observed commit and source commit; a fresh owner plan and the existing proposal owner recheck that destination before mutation, including byte-identical authority changes. Installed hosts, ordinary command scripts and external resources remain prerequisites. Actual skill lifecycle runs depend on M5. `test/skp-workflow-recipe.test.mjs`, `test/skp-transport.test.mjs`, `test/workflow-transfer.test.mjs`, `test/workflow-transfer-cli.test.mjs`. |
| M4 — guided shared authoring | Six-stage editing, shared/private persistence, bounded shared metadata/contract review, structural simulation, selected local/cross-repository Story/history usage and terminal-local proposals implemented; milestone incomplete | Shared drafts retain exact Git CAS/revision/assets; private encrypted recovery and proven-dead local lock repair remain separate. Preview captures fresh approved authority even inside caller-provided overlays. Workflow-only edits/forks preserve unrelated raw policy and do not repin Stories. Structural simulation is hypothetical and bound into Preview. Valid ordinary packages and explicitly classified artifact-only SKP packages have separate live terminal review, including a bounded 2–16-phase grouped artifact-only replacement path with one terminal consent and one inactive proposal. Show routes complete ordinary and skill-review drafts to the exact separate terminal-review command; an optional description does not become a submission blocker. The VS Code authoring UI presents grouped artifact-only impact and a bounded, explicitly selected, read-only cross-repository Story-usage view; neither is global discovery. SKP review binds agent body/default mapping to retained request and emitted bytes, then retains pre-consent and finalization identities in closed snapshot families. Staged bytes/modes, changed paths, committed tree and base-parent fences prevent unreviewed writes. Submission is not approval, activation or execution. Mediated-host confirmation, broader effect-changing contract owners/simulation, installed-host/crash/Linux/Windows recovery, global provider inventory and native runner qualification remain incomplete. `test/wca-compiler.test.mjs`, `test/wca-skp-finalization.test.mjs`, `test/wca-skp-submission.test.mjs`, `test/wca-submission.test.mjs`, `test/wca-staged-proposal.test.mjs`, `test/skp-story-usage.test.mjs`, `test/vscode-workflow-skp-usage.test.mjs`, `test/vscode-workflow-drafts-skill-classification.test.mjs`, `test/vscode-workflow-drafts.test.mjs`, `test/vscode-workflow-drafts-recovery.test.mjs`, `test/vscode-workflow-drafts-lock-recovery.test.mjs`. |
| M5 — host/platform qualification | Source-side boundary hardening and an opt-in hash-only Docker probe implemented; qualification incomplete | `src/skp-host-admission.mjs` treats caller-supplied evidence as a non-authorizing, closed-record shape check: proxies, accessors and extra fields are rejected, and launch and exact-delivery assertions refuse even when labels match. `src/skp-docker-hash-probe.mjs` can hash one inert, read-only staged byte packet using a caller-specified, locally present digest-pinned BusyBox image. Its report distinguishes CLI-reported cleanup from unknown effects and never authorizes automatic retry. It cannot run an imported skill, authorize launch, authenticate delivery, or qualify a host. The available Docker Desktop daemon is a Linux VM reporting an unconfined seccomp profile; no image was pulled and no live container was run. Real pre-effect read/write/tool/egress/control/process enforcement and delivery acknowledgement still require an approved adapter and installed-host qualification, including native Windows. `test/skp-host-admission.test.mjs`, `test/skp-host-readiness.test.mjs`, `test/skp-docker-hash-probe.test.mjs`. |
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
- Explicit local Story/history inventory: Shell `singularity-flow workflow author where-used <SKILL-ID> --story-refs 'STORY=refs/heads/BRANCH,...' --history-depth 2 --json`; Copilot `/sf-workflows author where-used <SKILL-ID> --story-refs 'STORY=refs/heads/BRANCH,...' --history-depth 2 --json`. Only the supplied local first-parent windows are assessed; this is not global Story discovery or remote fetch.
- Selected cross-repository Story/history inventory: Shell `singularity-flow workflow author where-used <SKILL-ID> --repository-story-refs '/ABS/REPO-A#STORY-A=refs/heads/BRANCH-A,/ABS/REPO-B#STORY-B=refs/heads/BRANCH-B' --history-depth 2 --json`; Copilot `/sf-workflows author where-used <SKILL-ID> --repository-story-refs '/ABS/REPO-A#STORY-A=refs/heads/BRANCH-A,/ABS/REPO-B#STORY-B=refs/heads/BRANCH-B' --history-depth 2 --json`. This reads only caller-selected local repository/ref windows; it does not fetch, enumerate all repositories, or establish provider identity or complete organizational coverage.
- Separate review proposal: Shell `singularity-flow workflow author submit WFD-<ID> --revision <N> --json`; Copilot `/sf-workflows author submit WFD-<ID> --revision <N> --json`. A headless invocation returns a terminal handoff; only a fresh live terminal review can submit. No caller-written confirmation flag or receipt substitutes for that event.

Code recipes also require `--planned-claims required --clause-phases <CRITERIA> --claim-owners <CODE=PLAN>`. See [workflow authoring](topics/workflow-authoring.md) for examples.

## Remaining work

1. Implement/integrate authenticated mediated-host confirmation and qualify installed-host/crash/Linux/Windows private recovery. Bounded shared-agent metadata, artifact-only skill-contract replacement and explicit selected local/cross-repository Story/history inventory are implemented, as described in the completion pass below. Broader effect-changing contract owners, global provider-discovered inventory and native provider-principal/revocation coverage are not implemented by those profiles. Terminal-local inactive finalization is not full M4 readiness.
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

### Follow-up: shared text review and portable owner hardening

- **Agent/template review:** `wca-shared-agent-text-impact/v1` replaces only exact existing
  repository-agent body prose while preserving raw frontmatter and remote resource tables.
  `wca-shared-template-content-impact/v1` replaces exact existing Markdown content and safe named
  display metadata without changing path/kind. Fresh Preview binds all captured consumers,
  effective overrides, text contracts and every affected workflow simulation. Producer text
  consumed by a confirmed skill cannot reuse a stale binding. Existing terminal proposal owners
  publish only reviewed raw YAML/text; application files, approved refs and Story pins stay intact.
  Actual local PTY tests cover both proposals, including refusal paths. This is not authenticated
  native consent or execution. `test/wca-shared-content-changes.test.mjs`,
  `test/wca-authoring-text-contracts.test.mjs`, `test/wca-compiler.test.mjs`.
- **Exact capture and compatibility:** raw committed parent bytes are retained privately through
  the configuration owner, with explicit authoring-only capture and per-path budgets. Default
  Story/workspace snapshots perform no extra authoring blob batch, cannot expose these bytes and
  cannot be silently promoted. New replacement profiles refuse materialization/filter drift;
  ordinary historical CRLF authoring and Story projection remain compatible. Template string
  catalog aliases resolve through the same existing catalog owner as object declarations.
- **UI:** Shared workflow drafts shows the supported exact agent/template content controls and
  complete bounded-impact JSON alongside disclosed consumer/workflow summary tables. Unknown or
  mixed profiles cannot become ordinary candidate fields or permission changes. Review buttons
  copy the existing rooted Shell and Copilot routes; they cannot submit or authenticate consent.
  `test/vscode-workflow-shared-content.test.mjs`.
- **Host diagnostics:** `skill doctor` and lifecycle refusal use a source-only capability report
  behind the model-runner registry boundary. It names the missing live enforcement, authenticated
  mediated confirmation and exact delivery owners without caller evidence or native probes.
  Host-blocked phases preserve evidence and do not route to content repair or automatic approval
  retry. `test/skp-host-readiness.test.mjs`, `test/skp-state-lifecycle.test.mjs`,
  `test/refusal-remediation.test.mjs`.
- **Portable cleanup/recovery:** the Windows taskkill helper releases its local event-loop handle
  after an unacknowledged deadline and absorbs late helper errors without claiming tree closure.
  Portable policy tests and real local encrypted-store tests cover long Unicode paths, restart,
  exact scope isolation, conflicting writes and refusal of foreign/unknown lock domains. These
  run in the fixed harness but remain observed-local/synthetic policy evidence, not Windows or
  Linux native qualification. `test/skp-platform-owners.test.mjs`,
  `test/vscode-workflow-drafts-portable-recovery.test.mjs`.

The subsequent bounded authoring/inventory completion pass below extends these source owners.
Real approved pre-effect host enforcement, authenticated native mediated confirmation and a
qualified Windows recovery process-domain owner are still absent. Actual installed-host/OS
qualification and real code/non-code human pilots remain pending; local fixtures or supplied
attestation labels cannot establish them.

### September 28 bounded M4/M5 continuation

- **Grouped artifact-only contracts:** `wca-shared-skill-contract-group-review/v1` takes 2–16
  exact existing confirmed skill phases, binds their packages and complete reverse impact, and
  uses one direct-terminal consent for all recompiled bindings and affected simulations. It emits
  one inactive proposal, not an execution or approval grant. The retained reader compares the
  complete source-plan dependency-lock set, effective template bytes, candidate package closure,
  and record family; resealed lock forgery and ordinary-family downgrade refuse. Real macOS PTY
  and focused WCA/migration tests passed 164/164. Effect-changing source/code/check contracts
  and authenticated mediated-host confirmation remain outside this profile.
- **Selected cross-repository inventory:** the `where-used --repository-story-refs` route reads
  at most four explicitly named local repositories and bounded Story/ref history windows. It
  verifies each selected retained revision and source-bound pagination. It does not discover
  provider repositories, fetch remote refs, establish team membership, or claim global completeness.
- **Host boundary and Docker candidate:** caller-written matching enforcement labels no longer
  authorize launch or delivery. The opt-in `src/skp-docker-hash-probe.mjs` path hashes only an inert
  staged byte packet in a locally present digest-pinned BusyBox image, under fixed read-only and
  no-network settings. The new process launch remains frozen by the GAL audit rather than becoming
  a broadly exempt owner. No image was available locally, pulled, or executed; Docker Desktop here
  reports an unconfined seccomp profile in a Linux VM. This source-side candidate cannot prove
  an approved adapter, pre-effect containment, authenticated host delivery, or native Windows
  behavior. The SKP lifecycle execution gate remains closed.
- **GDP companion review:** the already-stale `action-authorization` and `migration-registry`
  hashes were semantically reviewed together with the new grouped record families and reconciled
  in `docs/contracts/gdp/COMPANION-LOCK-REVIEW-2026-09-28-SKP-M4.md`. The M0 GDP baseline is
  unchanged; the lock test passes. This local review does not upgrade terminal consent into
  mediated human identity or qualify skill execution.

### Follow-up: bounded metadata, contract replacement and history inventory

- **Shared agent metadata:** `wca-shared-agent-metadata-impact/v1` supports exact existing
  Agent Markdown display metadata and simple resource-free eligibility/default mappings.
  Prompt prose, tool/view/resource contracts and unknown frontmatter stay intact. Skill-connected
  mapping changes or resource-connected mapping changes need a separate effective owner and
  are refused. Preview captures direct and indirect consumers plus fresh affected simulations.
- **One skill contract replacement:** `wca-shared-skill-contract-review/v1` supports one existing
  artifact-only phase while retaining its exact inert package, output paths, agent, task and checks.
  It does not support application source reads, code effects, multi-skill replacement or phase
  reordering. A fresh direct-terminal confirmation precedes recompilation and creates only an
  inactive proposal. Separate registered replacement record families preserve historical readers.
  Retained readers recompute the complete captured impact, parse metadata from exact Agent
  Markdown, and require the exact package-only emitted closure. Executable Git asset modes,
  omitted indirect consumers and resealed metadata/impact forgery refuse.
  `test/wca-shared-content-changes.test.mjs`, `test/wca-skp-finalization.test.mjs`,
  `test/wca-compiler.test.mjs`.
- **Explicit local history inventory:** callers select at most eight Story/ref pairs, depth 1–16
  including the tip, and at most 32 observations. The existing accepted reader verifies each
  selected revision and its bounded lineage. Identical retained states are deduplicated without
  omitting observations; verified nonmatching pins differ from unreadable revisions. Pagination
  binds the complete query and exact local tips. Missing history or ref drift refuses the whole
  query. There is no all-ref enumeration, lazy fetch, provider-principal claim or execution grant.
  The invocation-local 120-second read budget reaches nested Git readers instead of restarting
  for every revision. Subprocess cleanup is separately awaited; CPU/filesystem work is not
  represented as a hard wall-clock bound. Ordinary Git callers keep their defaults.
  FOS close awaits its internally owned Git preparation as well as object workers; uncertain
  cleanup reports content-free retained-projection diagnostics instead of silently deleting it.
  `test/skp-story-usage.test.mjs`, `test/local-read-deadline.test.mjs`,
  `test/fos-preparation-cleanup.test.mjs` (actual POSIX process fixture, not Windows qualification).
- **Windows private-lock diagnosis:** `WINDOWS_NATIVE_BOOT_PROCESS_DOMAIN_UNQUALIFIED` names the
  missing exact native domain owner. PID age, WMI/boot labels or caller-written dead-process
  evidence cannot release retained ciphertext locks. This is a visible safe refusal, not a
  Windows repair implementation or physical platform qualification.
  `test/vscode-workflow-drafts-lock-recovery.test.mjs`,
  `test/vscode-workflow-drafts-portable-recovery.test.mjs`.
- **Guidance and harness:** the workflow Copilot skill preserves explicit inventory selectors
  and source-bound pagination; it cannot invent a repository scan or repair consumers. The fixed
  checkout harness now includes local history and actual macOS terminal replacement observations.
  They remain local fixture evidence, not authenticated mediated consent or human pilots.

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
