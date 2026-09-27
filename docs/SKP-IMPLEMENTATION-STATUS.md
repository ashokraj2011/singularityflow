# SKP implementation status

This tracks implementation of *SPEC-SKP v0.2 — Skill Phases and Bring-Your-Own Workflows*. It is an evidence ledger, not a feature-enable switch. A locally inspected skill is untrusted data; its hash establishes byte identity, not authority or host containment.

| Milestone | Current status | Evidence and boundary |
|---|---|---|
| M0 — compatibility and closed readers | Protective guard and versioned readers implemented; milestone incomplete | Version-2 workflow validation refuses skill-producer fields instead of silently treating them as template phases. Version-3 definitions, version-11 Story records, version-3 WFA amendment snapshots, and version-3 skill workflow bundles have registered readers and migrations; historical records retain their identity and gain no invented audit evidence. This does not prove every M0 acceptance case. `test/skp-compatibility.test.mjs`, `test/mig-golden.test.mjs`, `test/mig-read.test.mjs`. |
| M1 — inspection and contract compilation | Safe foundations implemented; milestone incomplete | `skill inspect` reads one explicit local directory without Git, network, model, or execution, captures bounded exact bytes, and returns candidate-only findings. The pure confirmed-contract compiler retains its existing semantics. WCA additionally lowers a new retained skill package proposal-only: it exposes exact outputs, checks, policy and package identity without confirmation or a runtime binding. The post-consent SKP binding/digest design remains unresolved; proposal bytes cannot masquerade as confirmed configuration. The current path-based directory scanner is not a native isolation boundary against a malicious concurrent ancestor-directory swap; do not use it as an approved asset writer without closing that race. `test/skp-inspect.test.mjs`, `test/skp-package.test.mjs`, `test/skp-contract.test.mjs`, `test/skp-cli.test.mjs`, `test/wca-compiler.test.mjs`. |
| M2 — retained Story execution and evidence | Retention, evidence, and hardened AC-053 adoption implemented; milestone incomplete | Stories pin complete approved packages and compiled bindings. The accepted reader verifies bytes, digests, interpretation, configuration provenance, and immutable amendment lineage without a live-folder/latest-name fallback. Reviewed adoption changes exactly one package and reopens only proven affected phases; unknown dependency impact is refused. Other packages and unaffected approvals remain pinned. New decisions carry bounded offline-verifiable configuration ancestry and immutable rejection-review bindings. Existing lifecycle owners retain prior-output receipts, declared artifact membership, publication, and human-approval evidence. Skill preparation, generation, publication, submission, and approval remain refused with `SKP_HOST_ENFORCEMENT_UNAVAILABLE` pending M5; no executable pilot is claimed. `test/skp-snapshot.test.mjs`, `test/skp-amendment-audit.test.mjs`, `test/skp-amendment-plan.test.mjs`, `test/skp-amendment-snapshot.test.mjs`, `test/skp-amendment-transaction.test.mjs`, `test/skp-state-lifecycle.test.mjs`. |
| M3 — BYO and mixed-workflow recipes | Read-only recipes, role validation, and portable transfer implemented; milestone incomplete | `workflow skills-recipe` previews intake → selected approved phases → conformance from exact approved configuration. Code requires explicit earlier acceptance criteria and planning owners; findings/evidence are not criteria. The source-bound digest and separately authorized ordinary proposal route grant no execution. Bundle v3 retains manifests, binary/CRLF bytes, compiled bindings and transitive MCP agent/Story-phase dependencies; complete server scopes are preserved without adding scheduled workflow steps. Source and bundle reader share the traversal, with disconnected-object refusal and Story/Initiative namespace separation. Historical v1/v2 identities and original closure semantics remain stable; import still refuses destination permission widening. Approved-destination import/copy plans bind authority kind, remote fingerprint, observed commit and source commit; a fresh owner plan and the existing proposal owner recheck that destination before mutation, including byte-identical authority changes. Installed hosts, ordinary command scripts and external resources remain prerequisites. Actual skill lifecycle runs depend on M5. `test/skp-workflow-recipe.test.mjs`, `test/skp-transport.test.mjs`, `test/workflow-transfer.test.mjs`, `test/workflow-transfer-cli.test.mjs`. |
| M4 — guided shared authoring | Six-stage editing, shared autosave, source-bound preview and ordinary-package review proposals implemented; milestone incomplete | `skill doctor` verifies an accepted Story package without live-source fallback. `workflow author` shares inert partial drafts through the freshly verified configuration authority, with exact remote-head CAS, retained revision/asset closure, operation-ID recovery and deletion fences. VS Code provides six guided stages and explicit per-draft shared-autosave opt-in. Deterministic Preview, bounded catalog choices and read-only Show use an exact retained draft and approved source; unsupported effects and missing decisions remain blockers. A valid ordinary artifact-only create package can be separately submitted through live direct-terminal review to the existing configuration-proposal owner. The review branch retains immutable request, asset and file bytes; exact staged Git bytes/modes, changed-path closure, committed tree and base-parent fences prevent unreviewed staging changes. Submission is not approval, activation or execution. Native-mediated confirmation, full lifecycle simulation, durable private-buffer recovery, edit/fork impact, authorized where-used and confirmed SKP package emission remain incomplete. `test/skp-doctor.test.mjs`, `test/wca-git-drafts.test.mjs`, `test/wca-workflow-author-cli.test.mjs`, `test/wca-compiler.test.mjs`, `test/wca-submission.test.mjs`, `test/wca-staged-proposal.test.mjs`, `test/vscode-workflow-drafts.test.mjs`. |
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
- Navigation-only approved choices: Shell `singularity-flow workflow author catalog --kind quality-command --limit 32 --cursor 0 --json`; Copilot `/sf-workflows author catalog --kind quality-command --limit 32 --cursor 0 --json`. A visible reviewer or operation ID grants neither membership nor execution.
- Bounded approved-configuration usage: Shell `singularity-flow workflow author where-used <SKILL-ID> --limit 32 --cursor 0 --json`; Copilot `/sf-workflows author where-used <SKILL-ID> --limit 32 --cursor 0 --json`. Exact package references and ID-only agent declarations are distinct. Subsequent pages require the returned source digest with `--expected-source`; Story/history/provider-principal coverage is not claimed.
- Separate review proposal: Shell `singularity-flow workflow author submit WFD-<ID> --revision <N> --json`; Copilot `/sf-workflows author submit WFD-<ID> --revision <N> --json`. A headless invocation returns a terminal handoff; only a fresh live terminal review can submit. No caller-written confirmation flag or receipt substitutes for that event.

Code recipes also require `--planned-claims required --clause-phases <CRITERIA> --claim-owners <CODE=PLAN>`. See [workflow authoring](topics/workflow-authoring.md) for examples.

## Remaining work

1. Complete authenticated mediated host confirmation, full lifecycle simulation, durable private recovery, supported edit/fork impact and authorized historical-subject usage. The bounded approved-configuration usage route below is not a complete Story inventory or native provider-principal/revocation qualification. Resolve the SKP proposal-to-post-consent binding/digest contract through the existing owners; do not manufacture confirmation to close the gap. Shared CAS/autosave, static package validation and ordinary-package terminal review proposals are not full M4 readiness.
2. Qualify race-safe package capture and a real M5 host adapter with native enforcement and exact delivery evidence. Keep execution closed meanwhile.
3. Run actual two-client shared-authoring and mixed/code/non-code Story pilots and collect M6 release evidence.

The current safe built-in-only runner selection does not qualify imported skill execution. Foundation tests are not substitutes for shared-authoring and native-host acceptance cases.

`workflow author where-used` reads one freshly verified approved configuration snapshot through its
existing Git read owner, verifies the selected retained skill package and returns bounded, paginated
phase, repository-agent and workflow references. It distinguishes exact package bindings from
ID-only remote-skill declarations and projects only declared code/criteria/planning relationships.
It does not open the shared draft store, fetch declared remote skills, search Story branches or
other repositories, invoke a model, repair consumers or grant execution. The report identifies
coverage exclusions and its source digest; source drift refuses later pages, and over-budget or
credential-shaped projections are refused rather than disclosed as partial success.
Git repository read access is not authenticated per-team or per-person membership. Authorized
historical-subject lookup and native-provider access/revocation evidence remain pending.
`test/skp-usage.test.mjs`, `test/wca-workflow-author-cli.test.mjs`.

VS Code's **Configuration Center → Shared workflow drafts** (also available in the Command Palette)
organizes Goal, Stages, Team & skills, Access & review, Review package, and Submit & next steps.
It preserves the advanced literal JSON/assets alongside typed edits; missing prompts, artifact
contracts and unsupported bindings are not fabricated. Shared autosave must be enabled for the
exact opened draft and authority. A shared Saved message requires the CLI owner's acknowledgement,
not a timer. Conflicts, newer captured edits and uncertain acknowledgements preserve the pending
buffer; operation-status reconciliation precedes a changed retry or replacement. Refreshing a list
never silently rebases the editor. Binary assets remain read-only. Explicit Exit can flush eligible
captured edits, but native tab/application close guarantees neither a flush nor durable private
recovery. Pending text is memory-only.

The UI displays actual source-bound Preview/catalog/Show results and copies rooted Shell or
Copilot submission-review routes; it does not submit, approve, delete or execute from the webview.
The terminal independently refreshes and presents the saved package with Cancel as default. New
SKP phases remain proposal-only and block runtime configuration emission. Structural graph and
existing rework-policy checks do not establish complete lifecycle simulation or host enforcement.
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
