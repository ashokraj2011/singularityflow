---
id: workflow-authoring
title: Workflow and configuration authoring
aliases:
  - workflow
  - profiles
  - configuration-center
  - workflow-export
  - workflow-import
  - workflow-copy
  - skill-inspect
  - skill-where-used
questions:
  - How do I export or import several workflows with their dependencies?
  - How do I duplicate a workflow without duplicating its shared phase contracts?
  - How do I inspect a local skill before proposing it as a workflow phase?
  - How do I inspect a skill in approved configuration?
  - Where is an approved skill used in this repository's workflows?
commands:
  - workflow
  - configuration
  - skill
related:
  - configuration
  - agents-and-routing
  - artifacts-and-generation
version: 24
---
Author work types, ordered phases, gates, artifacts, inputs, and approval policy through governed configuration. Existing work remains pinned to the resolution it started with.

## Purpose and prerequisites

Use this topic when the current goal matches **workflow authoring**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow workflow`, `sflow configuration`. Use `workflow export`, `workflow import`, or
  `workflow copy` for portable workflow operations. Add `--propose` when authoring from an
  application or active Story checkout. Run `singularity-flow workflow --help` for the exact forms
  supported by this build. Use `singularity-flow skill inspect <LOCAL-DIRECTORY> --json` for a
  read-only, local skill package preview. Use `singularity-flow skill approved <ID> --json` to
  inspect a skill retained by the repository or workspace's verified approved configuration.
- **Copilot:** `/sf-workflows`. Ask it to export, import, or copy the selected workflows; it must show
  the exact deterministic preview and stop for confirmation before an import or copy mutation.
- **VS Code:** open Singularity Flow **Configuration Center → Workflows & artifacts**. The Designer
  toolbar exposes **Export**, **Import**, and **Duplicate** alongside workflow editing. It previews
  phase contracts and exposes planned claims, code task, and approval groups. Lead-governed saves
  create review proposals; self-governed saves leave an uncommitted edit on local `sflow/config`.
  The selected Story snapshot is never edited.
  **Configuration Center → Shared workflow drafts** (or Command Palette **Singularity Flow:
  Shared workflow drafts**) opens six guided stages with an advanced literal JSON editor.
  Shared autosave is opt-in for the exact opened draft and authority; an acknowledged revision
  is storage, not a proposal or approval. Conflicts and uncertain acknowledgements retain the
  pending buffer; Reload requires explicit reconciliation/discard. Binary assets are read-only
  to avoid a lossy text round trip. Encrypted private recovery preserves acknowledged local
  checkpoints separately from Git; native tab close does not guarantee a shared flush.

After `singularity-flow onboard --bootstrap`, run `singularity-flow init` before authoring. Bootstrap pins the repository authority; init materializes `singularity/workflow.yml` and `singularity/portfolio.yml`. When initialization is needed, the bootstrap receipt now gives that exact next command.

## Share an inert workflow draft across machines

Open the exact repository first. These commands resolve its freshly verified configuration
authority, not the machine's last selected workspace. All clients use the same repository-wide
`sflow/drafts/configuration` branch in that authority repository. Approved `sflow/config`, Story
branches, application files and the application index are untouched.

Start with Shell `singularity-flow workflow author list --json`, or Copilot
`/sf-workflows author list --json`. The result identifies the exact authority, current shared Git
head (or `null`), and live `WFD-…` draft IDs. To create an incomplete draft:

```bash
singularity-flow workflow author create WFD-DEMO001 --name "Review checklist" \
  --operation-id draft-create-001 --expected-head empty --json
```

Use `empty` only when list returned a null head; otherwise pass that exact Git object ID. A draft
is inert collaboration data, not an approved workflow. An optional `--input FILE` is a bounded
UTF-8 JSON envelope: `{"payload":{"id":"candidate","description":"Partial purpose"},"assets":[]}`.
Assets have literal `path` and `content` fields; logical paths never install files or grant tools.
Credentials, unsafe paths and approved environment-local exclusions are refused before sharing.
For destination-bound automation, add `--expected-authority <EXACT-REPOSITORY-FROM-LIST-OR-READ>`
to Create and Save. It is an assertion against freshly resolved authority, never a destination
override. The VS Code editor always supplies its retained authority; even a cloned repository at
the same head cannot silently replace it.

Shell `singularity-flow workflow author read WFD-DEMO001 --json` (Copilot `/sf-workflows author
read WFD-DEMO001 --json`) returns the retained revision, lifecycle epoch, exact head and asset
bytes. Save an edit with a new operation ID and those exact bindings:

```bash
singularity-flow workflow author save WFD-DEMO001 --name "Updated checklist" \
  --epoch 1 --operation-id draft-edit-002 --expected-head <RETURNED-GIT-OID> --json
```

Never refresh a head and silently reuse it for an older editor buffer. Another writer causes a
conflict, not an overwrite. Reconcile the retained and unsaved revisions explicitly. After an
interrupted acknowledgement, Shell `singularity-flow workflow author op-status draft-edit-002
--json` (Copilot `/sf-workflows author op-status draft-edit-002 --json`) checks the original
operation. Retrying the exact original request is idempotent; changing it under that operation ID
is refused. Deleted draft IDs fence queued saves and cannot be recreated.

`workflow author history WFD-DEMO001 --json` lists retained revisions. `workflow author show
WFD-DEMO001 --revision 1 --json` is read-only: it projects the exact saved package's deterministic
findings, ordered artifact graph, structural lifecycle simulation coverage and legal next action.
It does not publish or activate the candidate. Actual approval/publication state and installed-host
readiness remain distinct unavailable or unevaluated states. Copilot uses
`/sf-workflows author history …` or `/sf-workflows author show …`.

## Guide and preview an exact package

The shared draft UI organizes **Goal → Stages → Team & skills → Access & review → Review package →
Submit & next steps**. Typed edits preserve unrelated advanced fields, prompts and assets. New
components remain incomplete until their actual content and contracts are supplied; the guide
does not invent business instructions, human authority or host/tool mappings. Safe incomplete
content can be shared without passing complete-package validation.

Enable shared autosave only after checking the exact draft and destination. Captured edits use the
same bounded CLI CAS and operation-ID owner as explicit Save. **Shared revision N · all captured
changes saved** means the store acknowledged the payload and asset closure. **Not saved**,
**Conflict** and **Acknowledgement unknown** are not shared success. Check the retained operation
ID before retrying an uncertain write; changed text cannot replace its exact pending request.
Explicit Exit flushes eligible captured edits. Closing the native tab or application promises no
background sync or shared flush. Private checkpoint acknowledgement is shown separately: only
acknowledged local captures can survive a crash, not oversized or still-pending visible text.

## Recover private pending edits in VS Code

Open **Configuration Center → Shared workflow drafts** in the same repository, then open the
same draft. A retained private checkpoint offers three explicit choices:

1. **Restore private edits** restores literal name/JSON/assets into the editor only. The fresh
   shared authority, draft ID, revision, lifecycle epoch, revision hash and store head must match
   its retained base. Shared autosave stays off. Restore never submits, publishes or activates.
2. **Compare with current shared revision** opens a read-only, memory-backed VS Code diff.
   Incomplete JSON is preserved. The visual display may normalize line endings; it is not a
   bytewise merge or permission to overwrite a newer revision.
3. **Discard private checkpoint…** requires confirmation and removes only the reviewed local
   checkpoint using its exact checkpoint ID. It does not delete a shared draft or its history.

A newer shared revision, changed authority or deleted draft is never silently rebased or
recreated. The retained private bytes stay separate. Review differences and make a deliberate
edit against the fresh shared revision; do not treat an old Preview as approval of recovered text.
Restore also verifies that the retained baseline describes the full fresh payload/asset closure.
If an advanced Save omitted retained fields or assets, that partial baseline may be Compare-only;
the editor does not reconstruct omitted values or automatically merge the recovered request.
If a shared Save may have been sent before closing, **Check last write status** reconciles its
retained operation ID first. Recovery cannot bypass an unresolved write with Discard or a changed
retry, even if the visible text happens to match the previous baseline. An acknowledged historical
operation does not authorize writing over a newer peer revision.

Each capture is bound to the exact opened repository, authority, draft and baseline. The private
file is bounded, authenticated AES-256-GCM ciphertext under the extension's local global-storage
`workflow-draft-recovery` directory; its encryption key is held in VS Code SecretStorage. No
plaintext recovery file, Git commit, setting/memento sync or workspace artifact is created.
These are recovery copies, not the CLI's authoritative shared DraftStore, and are outside the
disposable snapshot cache. Corrupt files, unavailable keys and concurrent-writer conflicts are
visible failures, never empty-success results or plaintext fallbacks. Keep the same local storage
and SecretStorage to decrypt an acknowledged checkpoint. This is not a cross-machine backup or
qualification of an installed host's credential storage.

**Refresh private recovery (read-only)** retries the exact local scope after storage becomes
available or another editor changes its checkpoint, without replacing current editor text. An
interrupted writer's leftover lock does not prevent reading its retained checkpoint, but mutations
remain blocked rather than automatically removing a potentially live lock.

Choose **Inspect private locks (read-only)** to inspect the exact opened draft scope and the
directory-wide key-init lock. **Review dead lock repair…** is offered only for a newly recorded
owner proven absent in the same native process domain. A Cancel-default VS Code warning displays
the exact scope, owner and lock nonce. After confirmation, one-use host-held review, fresh native
liveness and inode/bytes/nonce checks, and a cross-process barrier fence removal of that exact lock.
The webview cannot supply a death flag or confirmation ticket. Repair changes no editor text,
ciphertext, encryption key, shared draft or approved configuration and starts no save/retry;
refresh private recovery before choosing another action.

Supported macOS/Linux probes bind the boot/process domain without exposing a raw host identifier.
Time, an old timestamp or a numeric PID alone never proves safe removal. Live/unknown owners,
another boot/domain, legacy empty locks and interrupted repair barriers stay blocked. Windows
inspection works, but repair is unavailable without a qualified native process-domain owner.
Native macOS child-process tests are not installed VS Code, Linux, Windows or power-loss
qualification. This build also does not claim race-free containment against a hostile same-user
filesystem ancestor swap. This local maintenance confirmation is not SKP runtime consent.

Private checkpoint failure is shown independently from shared status and blocks a new shared
Save in this editor. Before issuing a shared write, the editor durably retains the exact pending
operation; newer typing remains distinct from that pending request. Native close does not replay
it. Fresh shared acknowledgement clears only the matching private version, never a newer edit.

Select a retained revision and the real approved catalog:

```bash
singularity-flow workflow author preview WFD-DEMO001 --revision 1 --json
singularity-flow workflow author catalog --kind quality-command --limit 32 --cursor 0 --json
singularity-flow workflow author show WFD-DEMO001 --revision 1 --json
```

Copilot forms: `/sf-workflows author preview WFD-DEMO001 --revision 1 --json`,
`/sf-workflows author catalog --kind quality-command --limit 32 --cursor 0 --json`, and
`/sf-workflows author show WFD-DEMO001 --revision 1 --json`.

Preview is deterministic and model-free. It captures an exact draft revision/head and freshly
verified approved configuration, resolves selected dependencies, validates the closed
`sflow-workflow-request@2` package and reports exact candidate file bytes/hashes. Catalog choices
are bounded navigation-only IDs/labels pinned to that approved source; they do not prove reviewer
membership, admit operations or grant host access. Apply a captured choice explicitly, save its
new revision and preview again. A changed draft, authority, base, catalog or policy invalidates the
old plan rather than silently rebasing it.

Current candidate emission supports complete ordinary artifact-only create packages with real
agent/template bodies and approved task, check and reviewer references, plus the explicit
workflow-only changes below. Unsupported tool/source effects, missing artifacts, ambiguous
references and unclaimed attachments block emission. New SKP packages can be lowered proposal-only;
they have no confirmed runtime binding and cannot be submitted as executable skill phases. Their
inert files use canonical `singularity/skills/<ID>/…` storage, never native `.github/skills`
discovery. Static validation is supplemented by the bounded Story simulation below, not live
lifecycle execution.

## Edit or make a linked fork in a shared draft

Start from an empty component package and an exact captured approved workflow choice. The UI's
explicit edit/linked-copy selection prepares a workflow-only request; advanced JSON can express
the same `sflow-workflow-request@2` shape. Read the parent identity from
`workflow author catalog --kind workflow --json`: its `rawDefinitionSha256` belongs to the raw
approved workflow, not a normalized runtime policy. Bind the request's `baseRevision` to that
response's exact approved source. For a label-only edit, the payload includes:

```json
{
  "schema": "sflow-workflow-request@2",
  "intent": "edit",
  "id": "reviewed-workflow-change",
  "label": "Review workflow label",
  "baseRevision": "<exact-approved-source-baseRevision>",
  "target": { "governs": "story", "authority": "selected-repository", "hosts": [] },
  "changes": [{
    "kind": "workflow", "id": "customer-onboarding", "operation": "edit",
    "expectedDefinitionSha256": "sha256:<raw-parent-digest>"
  }],
  "definitions": { "workflows": [{ "id": "customer-onboarding", "label": "Reviewed label" }] }
}
```

Store this as the ordinary input envelope's `payload`, retain its literal `assets`, then Save and
Preview the exact shared revision. For a linked fork, use `intent`/`operation: "fork"`, name the
existing parent with `sourceId`, and select a new unused target ID in both the change and workflow
patch. This gives a separate workflow row, not private copies of its dependencies.

Only explicit label, description, phase order, planned-claims and rework-loop patches are supported.
Omitted advanced fields and unrelated raw configuration remain intact; runtime normalization is
used for validation/simulation, not to rewrite untouched shared definitions. Existing approved
phases, roles, templates, approval and MCP contracts stay linked. Preview reports their bounded
declared graph, exact dependency identities and direct configuration dependents. Effective
workflow overrides own input, output, template and approval validation. Missing or ambiguous
dependencies, privileged/existing fork targets, new shared objects or deletion block the plan.
Changing a workflow's SKP phase membership/order requires separately recompiled confirmed
contracts; existing bindings are never silently reused for a different topology.

No existing Story is repinned. Impact is configuration-only, not a complete retained-Story or
cross-repository inventory; external dependency content and host enforcement are not inferred.
A stale parent, approved source or plan requires a fresh Preview and separate terminal review.
Submission still creates only a configuration review proposal, not approval, activation or
execution. Shared-object editing and the post-consent SKP binding contract remain unavailable.

## Simulate a Story workflow before submitting it

In **Configuration Center → Shared workflow drafts**, save the selected package revision, then
choose **Preview**. The lifecycle table shows each scenario's phase, expected route and projected
outcome. Simulation runs for that exact saved revision and approved source, not on every keystroke.
The full bounded report is available in Preview JSON; the UI labels a shortened table as a summary.

- **Saved draft — Shell:** `singularity-flow workflow author preview WFD-<ID> --revision <N> --json`.
- **Saved draft — Copilot:** `/sf-workflows author preview WFD-<ID> --revision <N> --json`.
- **Installed workflow — Shell:** `singularity-flow workflow simulate <WORKFLOW-ID> --json`.
- **Installed workflow — Copilot:** `/sf-workflows simulate <WORKFLOW-ID> --json`.

The `story-structural-lifecycle/v1` profile exercises ordered progression, generation-zero and
publication gates, ordinary and skill input/output relationships, declared artifact-set members,
reviewer thresholds, quality-check refusal, human and external-prerequisite waits, rework
invalidation, repair-budget exhaustion and completion. It uses shared lifecycle, evidence-policy,
sequence, approval and repair-budget predicates; it does not create a second execution owner.
Configured reviewer capacity is checked with distinct identity-to-required-group matching, not
just the total number of names across groups.

`complete-for-profile` means every supported structural scenario was projected, not that a Story
was executed or that real prerequisites are ready. Successful output bytes, checks, publication and
human decisions are explicitly hypothetical. Simulation runs no repository command, model, MCP
tool or browser, writes no files and grants no approval. Real artifact/receipt integrity, human
availability, provider membership, active Story state, historical amendment impact, Initiative
workflows and native host enforcement are outside this profile. A human wait is not a deadlock.

Unsupported or unresolved contracts, missing confirmed SKP bindings and over-budget input/output
return `invalid` or `incomplete`, never truncated success. The profile is bounded to 64 phases,
1,024 scenarios and 16,384 events per workflow, with 2 MiB input and 1 MiB output limits. The
aggregate saved-package report is also bounded. Installed simulate-all is capped at 64 workflows
and 2 MiB combined output; exceeding either refuses the whole catalog result and directs you to
select one exact workflow. The simulation profile and exact reports form part
of the Preview plan hash. Changed drafts, configuration or simulation interpretation require a new
Preview and separate review; an old plan cannot authorize new bytes. A complete structural report
does not bypass other package findings or enable imported skill execution.

## Submit separately for configuration review

For an ordinary package with no authoring blockers, use one exact saved revision:

```bash
singularity-flow workflow author submit WFD-DEMO001 --revision 1 --json
```

Copilot: `/sf-workflows author submit WFD-DEMO001 --revision 1 --json`. Headless Shell/Copilot
returns `needs-human-input` and a rooted terminal handoff; it makes no proposal. The VS Code buttons
copy this route only. They do not submit or transfer consent.

A direct terminal independently refreshes and presents the complete package, exact authority,
draft and approved-source identities, destination and effect. Cancel is the default. Type
**Create review proposal** only after reviewing that card. The existing action-authorization owner
requires a live one-use terminal presentation, not a generated claim, public issuer call, JSON
receipt or `--confirm` flag. This is terminal-local review, not authenticated mediated Copilot
confirmation or native host qualification.

The existing configuration-proposal owner creates only a recoverable
`sflow/config-change/workflow/...` review branch. It retains an immutable submission snapshot under
`singularity/workflow-authoring-submissions/<plan-hash>.json`, including the raw request, inert
asset bytes, preview and exact candidate file closure. Before publication it verifies selected
staged Git bytes/modes, all changed paths, the committed tree and its exact approved base parent.
Git filters/EOL changes or unexpected files are refused; unchanged selected candidate files are
still checked. Moving or deleting the shared draft cannot rewrite a retained submitted snapshot.
The application checkout, index and approved `sflow/config` ref remain unchanged.

Submission is **review required**, not approved, active or executing. Merge/approval, approved
configuration refresh and any separate Start action remain their existing owners' operations.
SKP proposal-to-post-consent binding/digest design, qualified skill execution, simulation beyond
the supported Story structural profile and mediated-host confirmation are not complete. Native installed-host/crash and
Windows qualification of private recovery is still separate from its implementation tests. The
usage lookup below distinguishes the approved configuration from one explicitly selected local
Story revision; neither is a global consumer inventory. No new skill runtime binding is fabricated
to bypass those gaps.

## Delete a shared draft

Deletion is a separate explicit action: Shell `singularity-flow workflow author delete WFD-DEMO001
--json`. In a direct terminal it displays the exact destination, head, revision and effect, with
Cancel as the default. Type **Delete draft** only after reviewing that card. A one-use, in-process
presentation witness supplements the existing authorization owner; a locally authored receipt or
public issuer call alone cannot authorize this route. Copilot `/sf-workflows author delete
WFD-DEMO001 --json` returns a terminal handoff without deleting. Authenticated mediated Copilot
confirmation is not installed. Tombstones and historical draft bytes remain in Git; deletion is
not physical erasure and changes no submitted snapshot or active configuration.

Git's native repository ACL governs access; no per-draft JSON ACL or authenticated-provider
principal is claimed. Shared storage, static compilation, review proposal, approval and host
qualification are separate states; none follows merely from autosave.

## Inspect a local skill candidate

Select the exact local directory containing `SKILL.md`. Inspection is a machine-local read and does
not require a Story or repository checkout:

```bash
singularity-flow skill inspect ./skills/threat-model --json
singularity-flow skill inspect ./skills/threat-model --skill-id threat-model --json
```

The JSON response identifies the portable package manifest and digest, captured file roles and
byte lengths, evidence-bearing output/input candidates with source locations, unresolved findings,
and capture costs. It omits raw file bytes. A skill's text and `sflow-skill.json` sidecar can suggest
fields, but neither grants tools, source access, approval authority, checks, or execution. The
selected folder is not installed into host skill discovery or saved as approved configuration.

The inspector retains exact bytes in memory while it works and checks the full directory twice.
It does not run scripts, fetch linked URLs, or call a model. Local Markdown links must resolve to
captured files. It refuses symlinks, non-portable or colliding paths, missing resources, changed
files, and limits above 256 files, 256 KiB for `SKILL.md`, 1 MiB per other file, or 8 MiB total.
The preview is not a runnable phase; a separate reviewed authoring flow must confirm its contract.

## Inspect an approved skill package

From a repository or active workspace, select the exact approved skill ID:

```bash
singularity-flow skill approved threat-model --json
singularity-flow skill approved threat-model --expected-package-sha256 sha256:<64-hex-digits> --json
```

This reads a verified approved configuration snapshot and returns the source `sflow/config` commit,
the package digest, candidates, findings, and package-inspector costs. Git and remote authority read
costs are not included in those metrics. It checks the retained file hashes in
memory and does not write to the checkout. A supplied expected digest must match exactly. The
inspection still does not admit execution or assert that an active Story contains the same revision.

## Find where an approved skill is used

Select one skill in the opened repository's freshly verified approved configuration:

```bash
singularity-flow workflow author where-used threat-model --limit 32 --cursor 0 --json
```

Copilot: `/sf-workflows author where-used threat-model --limit 32 --cursor 0 --json`.
This read verifies the selected retained package and reports bounded configuration references,
workflow occurrences and proven code/planning contract relationships. ID-only agent references
are distinguished from exact package bindings. It does not fetch remote skills, open shared
drafts, launch a model, change consumers or grant execution.

Use `--package-sha256 sha256:<64-hex-digits>` to assert the exact selected package. For subsequent
pages, pass the returned source digest with `--expected-source sha256:<64-hex-digits>` and the next
cursor. A changed approved authority or revision invalidates pagination rather than combining
different inventories.

Coverage is limited to that approved repository configuration under its Git read permissions.
Without `--story`, it excludes Story branches, historical retained versions, other authorities and
ambient host/plugin agents. An empty result is not proof that no Story uses the skill. The report
contains no personal productivity metrics or unrelated team content; native provider
principal/revocation qualification and a global historical-subject inventory remain pending.

### Inspect one exact local Story revision

Explicitly select the Story and its existing local Git ref:

```bash
singularity-flow workflow author where-used threat-model --story SECURITY-101 \
  --ref refs/heads/security-review --commit <EXACT-GIT-OID> --snapshot-revision 2 --json
```

Copilot: `/sf-workflows author where-used threat-model --story SECURITY-101 --ref
refs/heads/security-review --commit <EXACT-GIT-OID> --snapshot-revision 2 --json`.

`--ref` defaults to `HEAD` and accepts one literal local `refs/heads/…` or `refs/remotes/…` ref.
Without `--commit`, the exact observed tip is selected; a supplied commit must be reachable from
that ref. `--snapshot-revision` asserts the accepted snapshot stored at the selected commit,
not a request to search or adopt another revision. The reader verifies that Story's retained
package, accepted amendment lineage and immutable review evidence. `--package-sha256` can assert
the exact pinned package. Later pages require the returned `--expected-source`; even movement
of the selected ref invalidates pagination instead of blending revisions.

This bounded local-object lookup does not refresh configuration, contact a remote, unshallow or
lazy-fetch missing objects, open the shared DraftStore, change a checkout or inspect another Story.
Missing ancestry/bytes is unavailable, not evidence of no usage. Limits include 256 ancestry
commits, snapshot revisions 1–64, 512 phase/reference rows and 64 rows/256 KiB per page; exceeding
them refuses the lookup without partial-success claims. Existing Git repository readability is
the access boundary, not authenticated per-team/provider membership. Other revisions/repositories,
actual execution usage and native provider-principal/revocation evidence remain outside coverage.

## Diagnose a retained Story skill

Check the exact accepted Story phase rather than a live skill folder:

```bash
singularity-flow skill doctor threat-model --story security-review --phase threat-model --json
singularity-flow skill doctor threat-model --story security-review --phase threat-model \
  --source ./skills/threat-model --json
```

Copilot: `/sf-skill doctor threat-model --story security-review --phase threat-model`.
The optional source is comparison only. The report verifies retained bytes, identifies a newer
package without adopting it, and reports host qualification as unavailable. It neither edits nor
repins the Story. Use the separately reviewed `/sf-story-skill-version` amendment route for adoption.

## Preview a skills workflow

Preview a new workflow using exact approved skill/mixed phase contracts:

```bash
singularity-flow workflow skills-recipe security-evidence \
  --label "Security evidence" --phases threat-model --json
```

Copilot: `/sf-workflows skills-recipe security-evidence --label "Security evidence" --phases threat-model`.
The CLI adds the existing intake and conformance phases, validates the sequence, and returns the
approved source revision and digest. Code workflows additionally require explicit
`--planned-claims required --clause-phases <CRITERIA-PHASE> --claim-owners <CODE-PHASE=PLAN-PHASE>`.
Acceptance criteria must precede the planning owner, which must precede code. A findings or evidence
output is not an acceptance-criteria source. This preview does not confirm a shared draft, create a
proposal, or execute a skill. The returned ordinary workflow proposal is a separate authorized action.
Imported skill phases remain non-executable until host enforcement is qualified.

## Shared configuration proposals

Workflow definitions are reusable workspace configuration, not Story deliverables. The approved
bytes live on `sflow/config`; a Story contains an immutable copy selected when that Story began.
Writing a new workflow into the active Story would neither update future Stories nor update the
approved catalog, and it would make the Story fail its protected-path gate.

For a lead-governed repository, the Workflow Designer performs this bounded transaction:

1. read the exact approved `sflow/config` revision into a disposable checkout;
2. apply and validate the workflow edit there;
3. prove every changed file is inside the configuration scope;
4. push one exact `sflow/config-change/workflow/...` review branch;
5. leave the application/Story branch, index, and working tree unchanged.

Merge that review branch into `sflow/config`, then run
`singularity-flow workspace refresh-configuration`. The refresh mirrors the approved files to the
workspace state branch and makes the workflow available to new Stories. Existing Stories remain
pinned by design. A failed push retains an exact transport intent and reports its `push status`
recovery command.

For a self-governed FOS-local repository, `--propose` does not invent a remote review branch. Switch to the local `sflow/config` authority branch first, then save through the Designer or CLI. The edit remains uncommitted for review; commit it through the repository's normal local configuration review path. Authoring from another branch is refused before any file is changed.

CLI example:

```bash
singularity-flow workflow create customer-onboarding \
  --label "Customer onboarding" \
  --phases requirements,implementation-spec,implementation,verification \
  --governs story \
  --propose
```

## Move or duplicate workflows

Export one portable bundle for one or more Story or Initiative workflows. The deterministic bundle
includes the selected workflow rows and the configuration objects they require: phases, artifact
sets and templates, approval authorities, governed Agent Markdown, MCP assignments, applicability
policies, exact remote-agent dependency locks, and declared World Model requirements. Locked remote
dependencies are hash-verified when the destination fetches them; the bundle never embeds a token
or credential. Repository-wide policy and installed World Model view contracts are prerequisites:
import validates them on the destination but never overwrites them. It does not include local caches,
runtime ledgers, work-item artifacts, or application source.

New exports use bundle v3. MCP assignments reachable from selected phases or agents are included,
including agent-only assignments with an unrestricted phase list. The entire assignment remains
unchanged: every named Story phase and agent is followed transitively, including their inputs,
templates, artifact sets and review definitions. Cycles are deduplicated; extra dependency phases
do not become scheduled steps in the selected workflow. Initiative phase names alone never select
same-named Story defaults. Unassigned global host declarations are not copied merely because they
are available; explicitly required servers are included. Historical v1/v2 files keep their stored
schema, digest and original dependency interpretation. Re-export from the source to obtain the
new closure; compatibility reading does not invent missing objects.

For approved skill phases, bundle v3 includes the exact package manifest, binary-preserving retained
file bytes, and compiled binding. Import preserves CRLF/binary bytes through Git and checks the
destination's policy and tool/read/check constraints; it cannot widen them. Historical v2 skill
bundles remain readable. A copied or imported skill still requires separate host admission.
Local files merely linked in prompt prose, command implementation scripts, installed tools/MCP
hosts, credentials and generated Story output are not bundled. The reader checks the closure within
the supplied bundle; it does not prove the completeness of an omitted optional source-catalog row.

```bash
singularity-flow workflow export \
  --workflow feature \
  --workflow initiative:enterprise-delivery \
  --out ./workflow-bundle.json \
  --json
```

Import is preview-first. Review the exact `add`, `reuse`, `conflicts`, and shared-dependency sets,
then apply the unchanged bundle with the returned plan SHA. `--propose` keeps the change inside the
normal governed configuration-review path.
Approved-destination previews also bind the authority kind, remote fingerprint, `sflow/config`
source revision and observed mirror revision when applicable. A byte-identical configuration in
a different authority or a newer approved commit cannot reuse the old confirmation. Import and
Copy refresh and recheck that identity before the proposal owner writes; the owner checks it again
before applying to its disposable checkout. Review a fresh preview after any stale-plan refusal.
The VS Code review document and confirmation detail display those destination bindings alongside
the plan digest; a local content-only plan is explicitly labeled as granting no remote authorization.
Working-tree-only local authoring retains its local preview semantics. Old bundle formats remain
readable, but earlier approved-destination plan digests need a fresh preview.

```bash
singularity-flow workflow import ./workflow-bundle.json --dry-run --json
singularity-flow workflow import ./workflow-bundle.json \
  --confirm sha256:<previewed-plan-sha256> \
  --propose \
  --json
```

Copy creates a linked duplicate: the new workflow gets its own complete workflow row and label while
continuing to reference the same reviewed phase, artifact, agent, approval, MCP, and template
contracts. Later edits to those shared contracts therefore affect both workflows; use export/import
when the destination repository needs a portable dependency closure.

```bash
singularity-flow workflow copy story:feature feature-team \
  --label "Feature — Team" \
  --dry-run \
  --json
singularity-flow workflow copy story:feature feature-team \
  --label "Feature — Team" \
  --confirm sha256:<previewed-plan-sha256> \
  --propose \
  --json
```

`workflow duplicate` is a compatibility alias for `workflow copy`. Neither form overwrites an
existing workflow ID. Imports are idempotent when the exact dependency closure already exists and
fail before mutation on any conflicting ID or changed bundle digest.
Use the qualified `story:<id>` or `initiative:<id>` source whenever both catalogs contain the same
workflow ID. The Workflow Designer supplies this qualification automatically.

New Story workflows infer a required planned-claims contract when a qualifying clause phase and code-phase owner exist. The CLI prints the resolved phase simulation after a successful non-JSON create or edit; inspect it again with `singularity-flow workflow simulate customer-onboarding`. Validation and simulation read the same custom definition. A custom workflow has no packaged baseline for `workflow diff`; use simulate instead.

To make review-led correction part of a Story workflow, add a bounded backward **rework loop** in the Workflows & artifacts Designer or with `workflow edit <ID> --loop <REVIEW-PHASE>:<EARLIER-PHASE>:<MAX-ATTEMPTS>[:<RESET-PHASE>] --propose`. The optional reset phase must be strictly earlier than the return target. The loop becomes a reviewer rejection route and a repair-attempt budget; it does not execute phases, approve artifacts, or amend a specification automatically. Existing Stories retain their pinned workflow. See [Bounded rework loops](../WORKFLOW-REWORK-LOOPS.md) for the full sequence and safety boundaries.

`workflow phase add` defaults to a Story phase. An unknown phase named by `workflow create` is not silently created: a new Story phase also needs a reviewed template, approval authority, and exactly one default governed Agent Markdown mapping. Add that contract through a configuration change before using the phase. The CLI names eligible clause phases when a selection cannot carry planned claims.

## Validate code-phase planning contracts

Every Story workflow that contains a code-delivery phase must resolve two things before it can be
used: an authoritative `requirements` or `implementation-spec` clause phase, and a reviewed
planned-claim owner before each code phase. Validate the entire approved catalog, or one workflow,
without starting a Story:

```bash
singularity-flow workflow validate
singularity-flow workflow validate customer-onboarding --json
```

The validator runs during configuration load and every Workflow Designer/CLI save as well. A future
workflow cannot silently reach implementation with no clause source or planning owner. A deliberately
short code workflow must declare `plannedClaims.mode: opt-out` with a concrete reviewable reason;
non-code workflows are reported as not applicable. New Stories pin the resolved contract, while
historical Stories without that field keep their original policy.

Existing organization-authored workflows from an older installation remain readable and appear as
`migration-required`; they cannot start a new Story until reviewed. Migrate one without hand-editing
YAML:

```bash
singularity-flow workflow edit customer-onboarding \
  --planned-claims required \
  --clause-phases requirements,implementation-spec \
  --claim-owners implementation=implementation-spec \
  --propose
```

For a deliberately short, low-risk workflow with no specification phase, use
`--planned-claims opt-out --opt-out-reason "<concrete reviewed reason>"`. Use
`--planned-claims auto` after changing phases to re-infer and pin a valid required topology.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## POC Lite

`POC Lite — local governed change` (`poc-lite`) is the smallest packaged demonstration of the
ordinary Story lifecycle:

`PLAN → ACT → VERIFY → FINALIZE`

All four phase records are assembled deterministically by the kernel. The profile pins World Model,
AST, agent briefs, and MCP off, adds no tracker or hosted-service integration, and can run with
global `--no-model`. ACT uses the normal code-delivery boundary: it discovers the existing
repository-native executable test command for the changed module, requires structured passing
evidence from a changed or newly added executable test, and also runs `git diff --check`. Begin ACT
before editing so the exact baseline is recorded. PLAN, ACT, and VERIFY have no approval; FINALIZE has one
explicit human quality-review decision. A generated FINALIZE record is not that decision.

For ordinary code phases, the kernel also infers supported repository-native test commands from the
changed module. This includes Maven/Surefire, Gradle/JUnit, pytest, Jest, Vitest, Node TAP, Angular
CLI/Karma, Go, .NET, and Swift. Angular CLI output is captured and parsed from its bounded final
`TOTAL` summary, so a Story must not add a wrapper script or edit protected `workflow.yml` merely to
register its test result. A genuinely unsupported runner is configured through a separately reviewed
configuration proposal; active Story snapshots remain pinned and are never rewritten in place.

The normal Story transport contract still applies. In a configured team repository this means its
configured Git remote; a self-contained demo harness may supply a local bare Git remote, so the
profile itself does not require GitHub, Jira, Playwright, MCP, or another network service.

```bash
sflow workflow install poc-lite
sflow --no-model start POC-LITE-101 \
  --title "Demonstrate one bounded change" \
  --from-branch main \
  --work-type poc-lite
```

In ACT, change the one bounded product path and its executable test, rerun `sflow prepare` for ACT
so the deterministic record captures the final paths, then publish using the
producer-aware command printed by this build.

Existing repositories receive POC Lite's four templates and dedicated phase-agent metadata during
catalog installation or approved configuration refresh. Those agent entries keep phase routing
unambiguous; the deterministic generation policy means the lifecycle never invokes them or a model
to author a POC Lite record.

## Enterprise Playwright POC workflow

`POC workflow — enterprise Playwright` (`poc-workflow`) retains the existing workflow ID and is the
seeded Story workflow for a governed UI-regression proof of concept. It appears in CLI, Copilot,
and VS Code workflow selection and runs this contract:

`POC intent and environment → Regression impact analysis → Governed UI exploration → Playwright test generation → Playwright validation and bounded repair → Publication and PR review`

Start it from any surface as a normal new Story. Select an explicit remote base branch first; SFlow
creates and publishes only the isolated Story branch. Intake then records the authorized environment,
test intent, acceptance criteria, viewports, test data, and secret references. Dedicated
least-privilege analyst, explorer, test-developer, and validator agents compare the pinned revisions, record Playwright MCP observations, follow
the repository's existing test and Page Object conventions, and produces exact command and evidence
records. The host must have the Playwright MCP server configured, and every allowed browser call
retains host confirmation and governed provenance.

A failed validation never starts an autonomous healing loop. A quality reviewer may reject to UI
exploration, test generation, or validation for at most two human-authorized repair generations.
The workflow stops blocked when that budget is exhausted. A passing validation advances to a
separate publication review requiring independent quality and engineering approvals. That phase
prepares the Story-branch diff and PR description; it does not create a PR or update the selected
base without an explicit governed publication action.

```bash
sflow workspace branches --json
sflow start POC-101 --title "Checkout regression demonstration" --from-branch develop --work-type poc-workflow
sflow mcp doctor
sflow mcp attest playwright --confirm playwright
sflow mcp smoke playwright --url https://staging.example.test/health
sflow status POC-101
```

## Paired benchmark workflows

The starter configuration also exposes `Benchmark A — governed intelligence` (`benchmarking-a`)
and `Benchmark B — generic context` (`benchmarking-b`). Both run:

`intake → design → implementation → testing → conformance`

They share the same templates, default agents, artifact contracts, write scopes, approval groups,
thresholds, and rejection routes. A requests governed world-model grounding, one bounded optional
AST evidence page, and approval-bound agent briefs. If World-Model or AST intelligence is unavailable,
A records the degraded treatment and continues with ordinary repository access. B disables
world-model and AST context and consumes full approved artifacts. The resolved
`intelligence` policy is pinned into `workflow.json`, so a later configuration change cannot switch
an active Story between arms.

Use the normal Start wizard in CLI, Copilot, or VS Code and explicitly choose one profile. Run
comparable Stories through both arms and use Flow Impact receipts for outcome analysis. Selecting
arms manually is a benchmark comparison, not randomized causal evidence; use the randomized prompt-
set study when the only variable is prompt wording.

## State and safety

These commands can mutate governed or machine-local state: `workflow`, `configuration`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain configuration`, `sflow explain agents-and-routing`, `sflow explain artifacts-and-generation`.
