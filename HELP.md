# Singularity Flow Help

Singularity Flow is a Git-native SDLC workflow for GitHub Copilot and engineering teams. It turns requirements, designs, implementation specifications, code, tests, approvals, and conformance evidence into durable branch state that another person or terminal can resume safely.

Use this manual in three places:

- Terminal: `singularity-flow help` or `singularity-flow help <topic>`
- GitHub Copilot CLI: `/sf-help` (preferred) or `/sflow-help` (compatibility)
- VS Code: open the Singularity Flow view and use the command palette for Help

The short command reference is available with `singularity-flow --help`.

For a visual end-to-end walkthrough with architecture, lifecycle, Git handoff, phase-input, and remote-agent diagrams, open `HOW-TO.md` in the repository.

## VS Code first-run onboarding

Open **Help: Welcome** and select **Get started with Singularity Flow**. The walkthrough configures your local display name and role, connects Jira through VS Code `SecretStorage`, selects or creates a workspace, and starts intake.

The role filters local guidance only. Governed agents come from the selected workflow phase, while approvals continue to use Git and provider identities. The CLI workspace registry remains the canonical workspace store; VS Code does not create a competing database. Jira tokens and provider secrets remain in the operating-system keychain and are exposed only to short-lived `sflow` child processes.

## About and command namespace

**Singularity Flow** is the product under the **Singularity** brand. It is a
Git-native, configurable SDLC orchestration system that carries requirements,
designs, implementation specifications, evidence, approvals, and reports through
reviewable work-item branches.

Run `/sf-about` in Copilot or `sflow-about` in a terminal for the concise
installed-version summary. Installer-managed personal Copilot skills use the
short, collision-safe `/sf-<action>` form without a plugin namespace. Packaged
`/sflow-<action>` skills remain compatible. Terminal shortcuts use
`sflow-<action>` where supplied. The full `singularity-flow <action>` CLI remains
available for scripts and backward compatibility; it is not a Copilot slash-command
prefix.

## Quick start

Install the package, initialize a repository, and commit its editable process definition:

```bash
npm install --global ./singularity-flow-0.9.0.tgz
cd your-repository
singularity-flow init --work-id WORK-123 --base main --fetch
git add singularity
git commit -m "[WORK-123][bootstrap] Initialize Singularity Flow"
git push -u origin WORK-123
singularity-flow start WORK-123
```

For a protected base branch, `--work-id` creates or reuses that exact Work-ID
branch before writing any files. Initialization therefore does not modify or push
`main`. Merge the configuration through an approved pull request only when the
team wants later Work IDs to inherit it as their shared baseline.

Install or refresh the GitHub Copilot plugin:

```bash
singularity-flow plugin install
copilot plugin list
copilot plugins list --kind skill
```

The install command copies the full governed skill contracts to
`~/.copilot/skills/sf-*/SKILL.md`. These are personal Copilot skills and therefore
run directly as `/sf-submit`, `/sf-approve`, and so on. Set
`SINGULARITY_FLOW_COPILOT_SKILLS_DIR` when corporate policy requires another
skills location, and add the same parent directory to `COPILOT_SKILLS_DIRS` or
Copilot's `skillDirectories` setting so the CLI scans it. The installer updates
only aliases carrying its management marker and never overwrites an unrelated
personal skill.

Start a new Copilot session after plugin installation. Begin work from Jira or from a manual description:

```text
/sf-start WORK-123
/sf-nextsteps WORK-123
/sf-next
/sf-phase
```

The normal phase loop is:

1. Generate or edit the current artifact.
2. Publish the generation.
3. Submit it for approval.
4. Review every generated phase document displayed by submission.
5. Approve it or reject it to an allowed earlier phase.
6. Continue until conformance is approved.

Use `/sf-progress` for deterministic completion and `/sf-report` for timing, waiting, rework, and token metrics.

## Multi-repository initiatives

Initiative orchestration is an opt-in layer above repository story workflows. `singularity/portfolio.yml` defines repositories, four- or seven-phase profiles, phase outputs, checklists, evidence assurance/freshness, authority groups, contracts, and gates. Repositories without this file retain existing behavior and make no initiative network calls.

Repository entries may include `metadata` with an `appId`, human-readable `name`, and any organization-specific scalar key/value pairs such as `owner`, `businessUnit`, `costCenter`, or `criticality`. Add these through VS Code **Configuration → Portfolio → Add repository**. The extension writes them beneath `repositories.<id>.metadata` in `singularity/portfolio.yml`; initiative snapshots, planning prompts, workspace manifests, and generated story seeds preserve the values.

If the file is missing, open VS Code **Configuration → Portfolio**. The guided setup creates and validates the full editable starter portfolio, fills approval groups from the entered identity or current Git identity, optionally registers the first participating repository, and optionally adds an HTTPS Jira host/project/write policy. Credentials are never accepted into the YAML. The file stays uncommitted until **Commit & push**.

Operate an initiative inside GitHub Copilot:

```text
/sflow-initiative-start INIT-2026-001
/sflow-initiative-phase
/sflow-initiative-next
/sflow-initiative-status
/sflow-initiative-documents
/sflow-initiative-checklist
/sflow-initiative-evidence
/sflow-initiative-materialize
/sflow-initiative-approve
```

Start and approval use Copilot selectable options and one-time receipts when persistent terminal input is unavailable. governed agents control prompt perspective; they never grant initiative approval authority. Authority comes from normalized local Git emails configured in `approvalAuthorities`, and reports label this `configured-local` rather than cryptographic identity.

`/sflow-initiative-phase` composes and records the complete governed Copilot prompt before generation. Its order is phase contract → selected governed-agent prompt → required repository world-model views → active agent Markdown → approved upstream initiative artifacts. `singularity-flow initiative context [PHASE]` prints that complete prompt; `--json` prints its hashes and provenance. With `worldModel.grounding: enforce`, publication is blocked when the prompt, world model, or an approved input is missing or changed.

For `kind: binary-bundle` outputs without a template, phase preparation prints the exact target as `awaiting upload`. Place the binary evidence at that path and run the phase command again to register its size and SHA-256 before publishing. Required missing bundles block publication with their expected paths. Downstream prompts include binary provenance, never decoded binary bytes.

Every generation, evidence record, approval, rejection, materialization, synchronization, and transition is committed and pushed to the exact initiative branch. Append-only evidence may replay after a concurrent append; approvals and lifecycle transitions always recompute against the new branch head.

The configured default branch is only the starting baseline for a new initiative or story branch. `initiative start` does not merge into `main`, and story materialization does not merge into a participating repository's default branch. Singularity Flow never automatically merges completed work; normal pull requests and repository policies remain in control.

Use `singularity-flow initiative materialize --dry-run` before creating story branches. The real operation requires exact initiative-ID confirmation. Story seeds recommend a work type and pin approved initiative inputs/contracts without bypassing the contributor’s interactive work-type.

`singularity-flow initiative sync` reads each child workflow from its exact
fetched commit. Invalid JSON, unsupported state, or a Work ID/branch mismatch
marks only that story stale and blocked; other repositories continue
synchronizing. Initiative-lite Build and enterprise Construction require every
blocking story to reach verification. Initiative-lite Release and enterprise
Delivery require conformance.

Initiative phase approval is valid only for the exact current bundle hash.
Dependency invalidation rewinds the lifecycle to the earliest affected phase
and resets affected later phases without deleting artifacts or unrelated
approvals. Reports combine initiative and child telemetry and label cost exact
only when every observed source supplies provider cost.

## Epic-to-Story planning and lifecycle lineage

New Epics default to the immutable `epic-planning` profile:

```text
Intake → Requirements → Planning and specifications → Publish Stories → Delivery review
```

The first four stages are the governed planning lifecycle. Delivery review is
dashboard state fed by finalized Story branches; it is not another generation
phase:

```text
Intake → Requirements → Planning → Publish → Delivery
```

Intake has no document, world-model, or approval ceremony. The Jira snapshot is
enough to continue; notes and files are optional. Repository grounding begins
only after each Jira Story has its canonical branch, so `main` and Epic branches
never show missing/stale model warnings.
Requirements has one approval over requirements, traceability, and impact
analysis. Planning has one approval over the editable Story list, parent
specification, and every per-Story specification.

There is **one navigation for every role**. The retired Electron app previously split
into a Business experience and an Engineer experience with separate menus, which
meant the Epic planning journey was reachable only from one and the configuration
tools only from the other. Both are now the same sidebar:

```text
Epic planning   Epics · Requirements · Planning · Create Stories ·
                Copilot CLI handoff · Artifact templates
Delivery        Overview · Artifact studio · Impact analysis · Documents
Decisions       Approval inbox · Review bundle
Configuration   Workspace configuration · Portfolio designer · Workflow designer ·
                governed agents & authority · Prompts & skills · Repository model · agents
Learn           Help & guides
```

The role chosen during onboarding still suggests an initial planning agent; it
no longer routes to a different shell, and there is no experience to switch
between. The active workspace and the Copilot service control sit together in the
top bar, so both stay visible on every page. Collapse or expand the sidebar with
⌘/Ctrl+B.

The Planning screen shows every generated Story with its repository,
`REQ-nnn`/`AC-nnn` lineage, dependencies, pinned workflow, and specification.
Use `/sflow-epic-story-draft` to generate this package. The skill publishes the
draft, tells the user that it is waiting for the Singularity Flow UI, and stops.
The UI is the business review boundary: reviewers can edit or split Stories,
add Jira tasks and key/value metadata, or adopt an existing Jira Story whose
parent is managed elsewhere. Every change reopens the exact Planning package.
**Publish Stories** requires the combined package to be approved, previews the exact Jira
and Git operations, and then:

1. Creates or attaches the Jira Story using the reviewed write-plan hash.
2. Freezes the returned Jira key as the Story Work ID.
3. Creates the canonical branch in the configured repository.
4. Commits the governed seed, approved Epic inputs, and append-only receipts.
5. Creates configured Jira subtasks and records their returned keys.
6. Completes the four-phase planning workflow after every Jira/Git receipt exists.

For the same operations from Copilot CLI:

```text
/sflow-epic-story-draft
singularity-flow epic stories update STORY-001 --metadata component=checkout
singularity-flow epic stories split STORY-001 --title "Separate recovery flow"
singularity-flow epic stories adopt MOB-321 --repository mobile \
  --requirements REQ-001 --acceptance-criteria AC-001
```

Direct adoption records a lineage edge to the approved Epic specification but
does not change the Jira Story's current parent. That supports unlinked and
cross-Epic Stories without pretending Jira is cleaner than it is.

Artifact-template edits remain ordinary repository changes until **Commit & push**
validates, commits, and pushes them.

Start from Jira when it is available, or choose **Describe the work**. The
local path atomically reserves a configurable Epic branch ID such as
`SF-E-001`; generated Stories keep `STORY-nnn` plan lineage and receive stable
Git-native IDs such as `SF-S-001-001`. Jira/local identity authority, local
prefixes, repository Jira routing, App IDs, and metadata are pinned into the
Epic resolution so later configuration edits cannot silently change active
work.

The workflow ends its governance lifecycle after the reviewed Jira Story plan
and specification have been applied and every canonical Story branch has been
seeded. The Epic then remains as a delivery dashboard until the Product Owner
records the exact spec-to-code completion decision. Select another configured
initiative profile at start when the Epic itself needs the full delivery
lifecycle.

Use the collision-safe Copilot commands:

```text
/sflow-epic-start MOB-100
/sflow-epic-sources
/sflow-epic-requirements
/sflow-epic-planning
/sflow-epic-story-draft
/sflow-epic-stories
/sflow-epic-publish
/sflow-epic-status
/sflow-epic-next
/sflow-epic-sync
/sflow-epic-drift
/sflow-epic-review
/sflow-epic-review-decision
/sflow-epic-merge-plan
/sflow-story-inbox
/sflow-story-start
/sflow-story-fetch
/sflow-story-branch
/sflow-story-checks
/sflow-finalize
/sflow-worldmodel
/sflow-agents
/sflow-telemetry
```

The terminal equivalents are:

```bash
singularity-flow epic start MOB-100
singularity-flow epic sources add --file requirements.pdf
singularity-flow epic sources note --text-file meeting-notes.md
singularity-flow epic requirements prepare
singularity-flow epic requirements publish
singularity-flow epic requirements approve
singularity-flow epic planning prepare
singularity-flow epic planning publish
# Review every Story and exact specification in VS Code Lifecycle → Planning,
# then approve the exact plan through VS Code or the CLI.
singularity-flow epic stories metadata STORY-001 set component checkout
singularity-flow epic stories tasks STORY-001 add --title "Add integration tests"
singularity-flow epic jira preview --artifact epic-requirements/requirements-specification --artifact epic-planning/parent-specification --artifact-to epic
singularity-flow epic jira apply --plan <exact-sha256>
singularity-flow story inbox --assigned-to-me
singularity-flow story start MOB-123 --fetch
singularity-flow story fetch MOB-123 --directory ../mobile
singularity-flow finalize
singularity-flow epic review MOB-123
singularity-flow epic checks MOB-123 --packet <exact-sha256>
singularity-flow epic review-choice begin approve MOB-123 --epic MOB-100 --packet <exact-sha256>
singularity-flow epic review approve MOB-123 --epic MOB-100 --packet <exact-sha256> --selection-receipt <token>
singularity-flow epic merge-plan --epic MOB-100
singularity-flow epic complete MOB-100 --dry-run
singularity-flow epic complete MOB-100
```

### Where Story branches come from, and how they land

When the Story's repository is the Epic's own repository — always the case for a
single-repository Epic — the Story branch is cut from the **Epic branch**, not
from the default branch:

```text
main
└── MOB-100                Epic branch: requirements, Story plan, specification
      ├── MOB-123          Story branches, cut from the Epic branch
      ├── MOB-124
      └── MOB-125
```

The Epic branch is the only branch carrying the approved Epic artifacts. A Story
seed cites `approvedArtifacts[]` by path and hash; cut from `main`, those paths
would not exist and the approved specification could not be read or verified
from the Story. A shared ancestor also moves conflicts into the Epic's own
integration instead of N separate pull requests.

A Story in **any other** repository is cut from that repository's `defaultBranch`
exactly as before. An Epic branch is never created in a repository that does not
already have one. The seed records `story.parentBranch` and `story.baseCommit`,
and `singularity-flow start <STORY-ID>` follows `parentBranch` so a fresh clone
forks from the same commit.

Story pull requests therefore target the Epic branch, and one final pull request
`MOB-100 → main` lands the Epic once every blocking Story has merged:

```bash
singularity-flow epic merge-plan --epic MOB-100    # ordered sequence and next action
singularity-flow pr MOB-123                        # preview the Story pull request
singularity-flow pr MOB-123 --create               # open it, after typed confirmation
```

`epic merge-plan` derives the order from the `dependsOn` graph already committed
in `breakdown.yml`; it reads Git and changes nothing. Each Story reports
`merged`, `ready`, `blocked` (naming its blockers), or `in-progress`. After each
merge, sync the remaining Story branches from the Epic branch before continuing.

`pr` previews by default. `--create` additionally requires typing the exact Work
ID, refuses a Story whose dependencies have not merged, reports an existing pull
request instead of opening a duplicate, honours a `direct` `branchCompletionPolicy`,
and prints the body for manual use when the GitHub CLI is unavailable. The body
is built only from committed governed state: identity, lineage, acceptance
criteria, approved artifacts with approval-time hashes, required checks, and
merge position.

Source bytes are uploaded through a configured Jira attachment, Artifactory,
SharePoint, S3, or HTTPS-reference adapter. Git stores only immutable provider
identity/version, URL, SHA-256, byte count, MIME type, uploader identity, and
timestamp. Downloads are kept under `.git/singularity-flow/epic-sources/`,
verified before prompt composition, and never committed. Jira credentials saved
by the VS Code extension use `SecretStorage` and are supplied only to child CLI
processes. Standalone terminals use the documented environment variables.
Artifactory and HTTPS-reference authentication remain CLI/provider configuration,
while S3 uses the AWS default credential chain, including corporate SSO profiles.
SharePoint delegated OAuth is not exposed by the extension until its corporate
redirect and proxy flow has been separately validated.

Requirements use stable `REQ-nnn` and `AC-nnn` identifiers. Every traceability
entry must cite a pinned `SRC-*` plus a page, frame, or section. Story-plan
version 2 allocates those identifiers to immutable temporary `STORY-nnn` plan
IDs. Jira then returns the canonical Work ID and branch name. The numeric Jira
issue ID, initial key, current key, aliases, and temporary plan ID all remain in
lineage; a later Jira re-key never silently renames Git history.

Developers can work directly on the canonical Story branch or register a child:

```bash
singularity-flow story branch create feature/login-ui --parent MOB-123
singularity-flow story branch attach --parent MOB-123
singularity-flow story branch status --parent MOB-123
singularity-flow story submit
singularity-flow finalize
singularity-flow story branch promote --parent MOB-123 --mode pr
```

A noncanonical branch without an explicit parent is rejected. `story fetch`
accepts repository identity only from the configured workspace, fast-forwards
the canonical Jira-key branch, verifies the seed and parent/Story specification
hashes, and starts the workflow pinned by the approved plan. Submission writes
and publishes an exact-hash phase packet containing lineage, generated
documents, approved specification inputs, source/test tree hashes, generation
metadata, model/token records, and branch policy. `pr`, `direct`, and `either`
completion policies are pinned per repository. Direct promotion is
fast-forward-only and never force-pushes.

After all configured developer phases are approved, `singularity-flow finalize`
writes and pushes the finalization packet for Product Owner review. It binds the
exact source commit/tree, every governed context hash, phase artifact, approval,
quality result, model, token, and cost record. Finalization never approves or
promotes the Story.

Product Owners use **Epic workspace → Review** or `epic review`. The isolated
review checkout discovers published packets across participating repositories
without changing the reviewer’s working tree. **Run and record checks** performs
deterministic lineage/hash/freshness governance and reads GitHub Actions and PR
state through the authenticated `gh` CLI for the exact submitted SHA. It never
runs repository build or test code locally. The evidence commit is pushed to
the submitted branch; approval and rejection decisions remain bound to the
packet hash.

The reviewed Jira write plan can contain explicit governed artifact
selections. Each selected requirements/specification output is verified against
its published SHA-256, attached with a hash-stamped filename, and receipted.
`--artifact-to epic` is the recommended default; `stories` attaches to every
generated Story and `both` does both. Repository policy must include
`attach-artifact` in `jira.writeOperations`. Retries query existing attachment
metadata and reuse the matching hash-stamped filename instead of uploading a
second copy.

After Story reviews, `epic complete --dry-run` reports every blocking Story
that is still missing a complete canonical workflow, approved conformance tree,
submitted packet, or passing exact-SHA evidence. The mutating command requires
exact Epic-ID confirmation and writes
`artifacts/delivery/spec-to-code-completion.md` plus a content-addressed
completion record. The decision is committed and pushed and is bound to the
exact canonical Story commits, review packets, check evidence, and conformance
tree hashes.

Git is canonical for the approved plan. `singularity-flow epic drift observe`
records Jira as a timestamped external observation. Choose `drift adopt` to
promote external values into a new Git artifact generation, or
`drift restore-plan` to create a new reviewed Jira write plan. No automatic
two-way overwrite occurs.

VS Code Lifecycle is a guided workflow for **Epic intake**,
**Requirements**, **User Stories**, **High-level spec**, **Publish to Jira**,
**Delivery progress**, and **Validate & complete**, with Configuration kept
separate. With no active Epic, the first wizard screen browses the connected
Jira projects and Epics, selects the immutable profile, activates its first phase agent, and
creates/pushes the Epic branch without asking the user to leave the app. The
Story screen displays every generated Story with repository, requirements,
acceptance criteria, and dependencies before approval. The publication screen
selects the exact artifacts Jira receives. The final screen shows Story-level
spec-to-code readiness and permits completion only when every blocking Story is
ready. Local role, Jira account, configured Git identity, and GitHub login are
displayed as separate identity domains; none is described as cryptographically
equivalent.

VS Code also provides **Lifecycle → Story intake** as the developer entry
workflow:

This path does not require an Epic to be created or selected in Singularity
Flow. The Jira Story is the intake identity; a Jira parent Epic is captured
when present and shown as optional lineage.

1. choose an assigned Jira Story or enter an exact Story key or browse URL;
2. review its description, acceptance criteria, attachments, status, assignee,
   and parent Epic;
3. confirm the workspace repository selected by the Jira project route;
4. select the immutable Story workflow; its first phase agent activates automatically;
5. create or resume the canonical branch named exactly after the Jira key,
   pin the normalized Jira snapshot, commit, and push;
6. continue phase authoring in Copilot CLI with `/sflow-phase`, then return to
   Overview for progress, documents, approvals, and finalization.

Use `/sflow-story-start <KEY>` for the same intake in Copilot. Use
`/sflow-story-fetch <KEY>` when the Story was already published from a governed
Epic plan and has a repository seed and Jira lineage property.

For a compact command-line view of the same business journey, use
`singularity-flow epic journey [INIT-ID]`. It renders one progress rail —
**Intake → Requirements → Planning → Stories → Complete** — and the single
next governed action. The action is informational until the normal phase
command, approval, or Story materialization is completed; it never skips a
gate. Add `--json` when a Copilot skill or another UI needs the stage, exact
phase, completion percentage, outputs, and checks as structured data.

## Epic artifact templates

Each Epic phase output is generated from an editable repository template under
`singularity/templates/initiatives/epic/`. The shipped templates follow
recognised practice so the generated artifacts are review-ready rather than blank
headings:

| Artifact | Structure it follows |
| --- | --- |
| `intake-summary.md` | Optional Epic charter: objective, measurable success criteria, stakeholder analysis, scope boundaries, readiness assessment |
| `source-catalog.md` | Optional evidence register with authority, currency, coverage by scope area, and a recorded precedence ruling for conflicting sources |
| `source-gaps.md` | Gap log separating blocking from non-blocking, with owners, working assumptions, and explicitly accepted unknowns |
| `requirements.md` | Requirements specification structured after ISO/IEC/IEEE 29148: MoSCoW priority, the four verification methods, measurable non-functional requirements, data, integration, and compliance requirements, glossary, quality checklist |
| `requirements-traceability.yml` | Requirements traceability matrix — the machine-checked citation graph |
| `open-questions.md` | RAID log (Risks, Assumptions, Issues, Dependencies) plus a decision record and escalation trail |
| `story-plan.yml` | Decomposition written to INVEST, carrying the `dependsOn` graph that later produces the merge order |
| `repository-map.yml` | Epic-level impact analysis: configured repository ownership, change type, interfaces, migrations, and pinned source evidence — plus repositories examined and found unaffected |
| `dependency-map.md` | Delivery sequence, dependency graph, critical path, repository boundaries, and integration strategy |
| `high-level-specification.md` | Solution shape with a context view, component and interface tables, non-functional budgets allocated to components, and architecture decision records |
| `materialization-report.md` | Handoff record: Jira and branch receipts, traceability confirmation, deviations, retries, outstanding work |

Templates are ordinary repository files: edit them in **Artifact templates**, or
directly, and commit. The resolved template hash is pinned into the initiative at
start, so changing a template after an Epic begins does not silently alter that
Epic's contract — it is reported as a changed template instead.

Two templates are validated as well as generated. `requirements-traceability.yml`
must cite pinned sources with a locator for every `REQ-nnn` and `AC-nnn`, and
`repository-map.yml` must name only configured repositories. Detailed code-level
impact is added after Story intake using that Story branch's world model. For
Jira-backed Epics, the committed Jira Epic snapshot is
also a valid pinned source, so uploaded documents are useful enrichment rather
than a prerequisite. Both ship with the live structure empty and the full schema
in comments, so a freshly generated artifact passes the gates and fails only once
it contains real content that does not hold up.

## Activity log

Every command and hook decision is recorded to a
machine-local log so a failure can be explained after the fact rather than
reconstructed from memory.

```bash
singularity-flow logs                      # recent entries, newest last
singularity-flow logs --tail 200           # more history
singularity-flow logs --level error        # only failures
singularity-flow logs --level warn         # failures and refusals
singularity-flow logs --event hook         # one subsystem (matched as a regex)
singularity-flow logs --since 2026-07-25   # from a point in time
singularity-flow logs --json               # machine-readable, for piping
singularity-flow logs path                 # where the file is
singularity-flow logs level                # effective levels and their source
```

The log is JSON Lines at `.git/singularity-flow/logs/activity.log`. It lives
under `.git/` deliberately: diagnostics are specific to one machine and one
checkout, so they are never committed, never pushed, and never part of a review.
It rotates at `logging.maxBytes` and keeps `logging.keep` generations.

### Levels

`off`, `error`, `warn`, `info`, `debug`, `trace` — with `all` accepted as an
alias for `trace`, plus `verbose` (debug), `quiet` (error), and `silent` (off).

Two sinks are configured separately, because they have different jobs:

| Setting | Sink | Default | Purpose |
| --- | --- | --- | --- |
| `logging.level` | the log file | `info` | verbose enough to diagnose a failure afterwards |
| `logging.console` | stderr | `warn` | quiet unless something is wrong |

Raise either for a single command without editing governed configuration:

```bash
SINGULARITY_FLOW_LOG_LEVEL=all singularity-flow initiative phase epic-planning
SINGULARITY_FLOW_LOG_CONSOLE=debug singularity-flow epic merge-plan
```

`SINGULARITY_FLOW_LOG_LEVEL` raises both sinks; `SINGULARITY_FLOW_LOG_CONSOLE`
raises only stderr. Both override `logging` in `singularity/workflow.yml`.

### What is recorded

| Event prefix | What it tells you |
| --- | --- |
| `command.start` / `command.ok` / `command.failed` | every CLI invocation with its arguments, branch, duration, exit code, and full stack on failure |
| `hook.guard.allow` / `hook.guard.deny` | why Copilot was permitted or refused a tool, including which selection was missing |
| `hook.session.initiative` | a governed initiative session, where no work-item selection applies |
| `worldmodel.*` | repository world-model preparation, Copilot execution, validation, and publication progress |

The hook and world-model entries make refusals and long-running grounding work
visible without hosting a second phase-planning model session.

### Secrets

Log context is redacted before anything is written. Values are removed both by
key — anything matching token, secret, password, credential, authorization,
cookie, api-key, private-key, signature, or pat — and by shape, so GitHub,
Slack, Google, JWT, and bearer tokens are stripped even when they appear inside
free text. Long values are truncated, and cycles and deep structures are bounded
rather than serialized.

Nothing is ever written to standard output. That stream carries the `--json`
payloads consumed by VS Code and automation, and log lines there would corrupt them.

## Native Copilot handoff

The VS Code extension does not start a separate Copilot backend or embed a second
planning runtime. Lifecycle and phase views show:

- the exact repository directory;
- the primary phase-aware `/sflow-*` command;
- its shell equivalent;
- `/sflow-upload` for adding governed evidence; and
- `/sflow-nextsteps` for deterministic recovery and sequencing.

Run the skill in the normal authenticated Copilot CLI, or choose **Open governed
context in Copilot** in VS Code. The skill composes the configured governed agent, phase contract,
repository world model, approved inputs, pinned sources, remote skills, and
artifact template. Copilot questions and follow-up discussion stay in that CLI
session. Successful generation and lifecycle actions commit and push through
the existing Singularity Flow guarantees. Refresh the VS Code views to inspect
the result, run governance checks, and approve it.

Repository world-model generation is a CLI operation that the extension may
launch and monitor. It can run against any selected repository branch without
requiring an Epic or Story, and records its prompt, generation timestamp, source
commit, manifest, and views in Git.

The VS Code **Lifecycle**, **Approvals**, **Dashboard**, and **Journey** views display
phase flow, generated documents, review state, story progress, elapsed time, model,
tokens, and provider cost when available. **Configuration** edits validated workflow,
agent, prompt, skill, template, integration, and world-model policy files.

The **Singularity** workspace groups daily delivery into four focused views:

- **Artifact Studio** shows the phase sequence, generation and approval state, governed outputs, and the shared artifact repository.
- **Requirements** shows a repository document tree, full Markdown preview, Git metadata, and section outline; uploaded design packages and reference links remain attached to the selected work item.
- **Copilot CLI handoff** shows exact `/sflow-*` commands while the normal Copilot CLI performs governed-agent-aware authoring and asks questions.
- **Impact analysis** visualizes repositories and child stories, then reports committed context freshness and interface-contract integrity without inventing unobserved dependencies.

See `INITIATIVE-ORCHESTRATION.md` for the complete configuration, evidence, contract, materialization, and recovery guide.

## Workspace configuration

A workspace is a local isolation boundary for one project context. It is not
another workflow phase, Jira issue type, or portfolio level. `workspace.json`
stores the local directory layout, clone URLs, per-repository Jira board or
project key, App ID, display name, optional metadata, and the selected lead
repository. The lead repository is the Git home for Epic-level artifacts.

In VS Code:

1. Open any initialized Singularity repository.
2. Open **Workspaces → Create workspace**.
3. Enter a workspace name and ID, then choose the local working directory.
4. Add repositories from disk or enter their clone URLs.
5. Set each repository’s Jira board/project key, Application ID, and optional
   metadata.
6. Select exactly one lead repository and review the clone plan.
7. Type the exact workspace ID to create the isolated workspace.

Each selected repository is cloned separately below `repos/`. Fetch operations
skip dirty clones and never change a branch. Switching workspace updates the
lead repository used by the displayed Copilot CLI handoff commands.

If setup is interrupted, repeat creation with the same workspace ID and unchanged
repository plan or select **Repair**. Missing clones resume and every attempt is
written to `logs/workspace-materialization.json`. A changed URL, branch, local
path, Jira board, metadata set, required flag, or lead repository is refused at
the same target so stale configuration cannot be mistaken for a successful
resume. Recent locations use the canonical workspace path; `workspace.json`
must be a regular local manifest rather than a symlink. Older Jira-anchored
workspace manifests remain supported.

Files placed in `documents/inbox/` are shown as **staged — not governed**.
On a resumed story branch with an active governed agent, **Import to work item** copies,
hashes, commits, and pushes a governed document. Initiative material instead uses
checklist-aware evidence registration so assurance and freshness are preserved.

Useful diagnostics:

```bash
singularity-flow workspace list
singularity-flow workspace use <ID|NAME|JIRA|DIRECTORY> [--repository ID] [--story STORY]
singularity-flow workspace current
singularity-flow workspace prompt
singularity-flow workspace copilot [WORKSPACE] [--repository ID] [--story STORY] [--mode plan]
singularity-flow workspace status <DIRECTORY>
singularity-flow workspace sync <DIRECTORY>
singularity-flow workspace repair <DIRECTORY>
singularity-flow workspace documents <DIRECTORY>
```

`workspace use` records a machine-local active workspace and repository. The
context label is `<workspace> >`, or `<workspace> / <story> >` on a governed
Story branch or when `--story` is supplied. `workspace copilot` starts GitHub
Copilot in the selected repository using that workspace/Story as the Copilot
session name. Copilot's native `>` input marker is not configurable; Singularity
shows the label as a launch banner and supplies it to the session hook as
governed context. In Copilot, `/sflow-workspaces` lists contexts and
`/sflow-workspace` switches them without launching a nested process.

For creation, offline provisioning, recovery, and safety details, open
`WORKSPACES.md`.

## How the workflow works

The repository owns the process in `singularity/workflow.yml`. A work type selects an ordered phase sequence. Each phase selects an artifact template, default governed agent, world-model views, write scope, quality checks, human approval authority groups, threshold, and allowed rejection targets.

At work-item creation, Singularity Flow snapshots the selected work type, resolved phase contracts, configuration hash, and template hashes into:

```text
singularity/work-items/<WORK-ID>/workflow.json
```

The work type cannot change after creation. This prevents later changes on the base branch from silently changing an active workflow.

Generated artifacts and lifecycle decisions are committed and pushed to the work-item branch. Git is the state-transfer protocol: another terminal fetches the branch and reconstructs the workflow from committed files. The CLI remains the only owner of runtime state, managed metadata, approvals, commits, and phase transitions.

## Starting work

Run:

```bash
singularity-flow start WORK-123
```

Start always asks for:

1. Jira story or manual intake.
2. Workflow template, such as feature, bugfix, chore, or Figma export to mobile app.
3. governed agent for the current session.

The workflow and governed-agent pickers are deliberately human-driven. There are no public `--type` or `--agent` bypass flags. Non-interactive start fails rather than silently choosing defaults unless `/sflow-start` supplies a valid one-time receipt containing the contributor's explicit Copilot choices.

Useful source forms include:

```bash
# Jira
singularity-flow start ENG-142 --jira

# Structured YAML or JSON story
singularity-flow start WORK-123 --story-file ./story.yml

# Short manual story
singularity-flow start WORK-123 \
  --title "Add invoice export" \
  --description "Finance needs a repeatable filtered export." \
  --acceptance-criteria "An authorized user can export the filtered invoice set."

# Additional evidence
singularity-flow start WORK-123 \
  --story-file ./story.yml \
  --document ./brief.pdf \
  --document-url https://www.figma.com/design/example
```

Use `/sflow-start` in Copilot for conversational intake.

## Jira intake

Set Jira credentials in the shell or a protected secret manager. Do not commit credentials and do not use an Atlassian password:

```bash
export JIRA_BASE_URL="https://company.atlassian.net"
export JIRA_USERNAME="person@company.com"
export JIRA_PAT="<api-token>"
```

The VS Code Jira connection asks for those same three values: Jira URL, username/email, and PAT/API token. It stores the token in `SecretStorage`, sends Basic authentication as `base64(username:PAT)`, and never requests a Jira password. `JIRA_EMAIL` and `JIRA_API_TOKEN` remain supported CLI aliases.

Discover site-specific custom fields:

```bash
singularity-flow jira fields --query "Acceptance Criteria"
singularity-flow jira fields --query "Story Points"
singularity-flow jira fields --query "Sprint"
```

Configure the discovered IDs when needed:

```bash
export SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD=customfield_12345
export SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD=customfield_10016
export SINGULARITY_FLOW_JIRA_SPRINT_FIELD=customfield_10020
```

Verify access with `singularity-flow jira status`, inspect one Story with `singularity-flow jira pull ENG-142`, or list assigned work with `singularity-flow jira assigned --project ENG`.

Jira input is normalized into committed `source.json` and readable `USER-STORY.md` files. Attachments are not downloaded automatically; upload the evidence you need explicitly.

For Jira Data Center, use a PAT instead of Cloud Basic authentication:

```bash
export JIRA_BASE_URL="https://jira.company.example"
export JIRA_DEPLOYMENT="data-center"
export JIRA_PAT="<personal-access-token>"
```

Connection and hierarchy commands:

```bash
singularity-flow jira status
singularity-flow jira doctor
singularity-flow jira projects
singularity-flow jira epics --project APP
singularity-flow jira children APP-100
singularity-flow jira permissions --project APP
singularity-flow jira assigned --project APP
singularity-flow jira boards --project APP
singularity-flow jira board 42 --state active,future --type Story
```

The board command reads only the selected board's active and future sprints and groups Stories by sprint. It does not call the Jira backlog endpoint. Use `/sflow-jira-status`, `/sflow-jira-doctor`, `/sflow-jira-assigned`, and `/sflow-jira-board` for the same read-only flows inside Copilot CLI.

`singularity-flow jira doctor` is the full configuration diagnostic. It checks the active workspace and selected repository, `singularity/portfolio.yml` Jira policy, required CLI credential-variable presence, authenticated identity, configured project visibility, effective permissions, Jira Software boards, and visible Epics. It never prints secrets or changes Jira, Git, or repository files. VS Code credentials remain in `SecretStorage` and are supplied only to commands launched by the extension; a standalone terminal must provide its own environment variables.

An explicitly invoked `/sflow-jira-update` can change one Story at a time:

```bash
singularity-flow jira transitions APP-142
singularity-flow jira transition APP-142 --to "In Progress" --confirm APP-142
singularity-flow jira assign APP-142 --to me --confirm APP-142
singularity-flow jira priority APP-142 --to High --confirm APP-142
singularity-flow jira sprint APP-142 --to 81 --confirm APP-142
singularity-flow jira comment APP-142 --text "Ready for review" --confirm APP-142
```

Every mutation requires the exact Jira key. Status changes are restricted to transitions Jira reports as available; transitions that require additional screen fields must be completed in Jira.

Use **Singularity Flow: Connect Jira** in VS Code for the preferred corporate setup. The extension validates the HTTPS URL and credentials before saving them in `SecretStorage`; the token is never written to Git, workspace settings, logs, prompt context, or renderer state. Repository policy in `singularity/portfolio.yml` still controls deployment, host/project allowlists, permitted authentication modes, cache duration, writes, and owned fields. Every Jira route revalidates the selected connection and project scope, and initiative writes use the immutable policy snapshot. Transport remains bounded by the Jira client timeout and response-size checks. Issue searches follow Jira Cloud page tokens and Jira Data Center offsets up to the requested 500-issue ceiling; duplicate issues, repeated tokens, and non-advancing offsets are rejected.

Select an existing Epic, map each child to an owning repository, and choose an existing initiative. Preview then adopt it to create a committed source snapshot and `breakdown.yml` with separate Singularity Work IDs and Jira IDs. Outbound changes use a two-step flow:

```bash
singularity-flow initiative jira-plan
singularity-flow initiative jira-apply --plan <exact-sha256>
```

The plan is committed and pushed before review. Apply requires `jira.writeMode: approved`, an approved Plan/Elaboration phase, discovered Jira permissions, the exact plan hash, exact initiative-ID confirmation, and a plan that still matches the pinned connection, deployment, and project policy. Optimistic `updatedAt` checks reject stale updates. Operation receipts are committed and pushed; retry accepts a receipt only when its operation and reviewed plan hash still match. The governed initiative planner does not own status transitions, assignee, sprint, priority, or resolution; `/sflow-jira-update` is a separate, exact-Story operator action.

## Manual intake and documents

Jira is optional. A manual YAML or JSON story can capture the audience, problem, desired outcome, scope, out-of-scope items, stakeholders, urgency, constraints, dependencies, acceptance criteria, risks, notes, and supporting documents.

Supporting files live under:

```text
singularity/work-items/<WORK-ID>/inputs/DOC-nnn/<filename>
```

List, inspect, or add documents:

```bash
singularity-flow documents list WORK-123
singularity-flow documents view DOC-001 --work-id WORK-123
singularity-flow documents upload ./brief.pdf ./wireframe.png
singularity-flow documents upload ./figma-export --kind figma-export
singularity-flow documents upload \
  --url https://www.figma.com/design/example \
  --label "Checkout design"
```

Each uploaded file receives a stable ID, content hash, MIME type, actor, agent, and phase. Directories are imported recursively in deterministic relative-path order, with symbolic links rejected. Upload is allowed only during the initial phases configured by the selected profile. Local files are copied and pushed; external Figma or reference URLs are cataloged without being downloaded.

### Fetch documents from a storage provider (OneDrive/SharePoint)

When `singularity/workflow.yml` declares `storage.providers`, documents can be fetched directly from a configured provider and materialized into the work item. OneDrive for Business is a SharePoint document library under Microsoft Graph, so it uses the `sharepoint` provider type.

```yaml
# singularity/workflow.yml
storage:
  defaultProvider: onedrive
  providers:
    onedrive:
      type: sharepoint
      tenantId: <azure-tenant-guid>
      clientId: <app-registration-guid>
      siteId: <graph-site-id>
      driveId: <graph-drive-id>
      # scopes default to: [offline_access, User.Read, Files.ReadWrite.All]
```

```bash
singularity-flow documents browse --provider onedrive          # list drive items
singularity-flow documents fetch  --provider onedrive --ref <drive-item-id>
```

`fetch` downloads the bytes into `inputs/DOC-nnn/`, hashes them, records provider provenance (`providerId`, `objectId`, version), and commits/pushes like any other document — so a resumed checkout on another machine has the content, not just a link. In the CLI the bearer token is read from `SINGULARITY_FLOW_STORAGE_TOKEN_ONEDRIVE`; VS Code stores provider credentials in `SecretStorage` and exposes governed document actions without placing tokens in repository state.

For a tab-like browser inside a canvas-capable Copilot host, enable experimental features, start a fresh session, and invoke the bundled extension:

```text
/experimental on
/documents
/documents view PHASE-DESIGN
```

The canvas separates generated artifacts, uploaded inputs, and workflow documents, with search and full text previews. It embeds a fresh snapshot directly in the canvas; run `/documents` again after generating or uploading files to reload it. If the host cannot render canvases, `/documents` falls back to deterministic terminal list/view output. This extension cannot add a fifth built-in Copilot home tab because that UI surface is not exposed to plugins.

Use `/sflow-documents` for the model-assisted upload workflow or the VS Code
**Documents** view. Previews are read from governed paths and approval remains
bound to the recorded SHA-256, never to a mutable live URL.

## Work types and phases

Starter work types are:

| Work type | Phase sequence |
|---|---|
| Feature | intake → requirements → design → implementation-spec → implementation → verification → conformance |
| Bugfix | intake → reproduction → fix-design → fix-spec → implementation → verification → conformance |
| Chore | intake → implementation → verification → conformance |
| Figma export to mobile app | design-intake → design-inventory → component-mapping → mobile-spec → implementation → visual-verification → conformance |

Feature work produces stable `AC-n` acceptance criteria and `SPEC-nnn` implementation items. Bugfix work uses a smaller fix specification but retains the same traceability model. Verification links tests and source evidence. Conformance compares approved requirements and specifications with exact code/test evidence.

View the immutable phase contract and exact next action for an active work item:

```bash
singularity-flow guide WORK-123
```

In Copilot, `/sflow-help WORK-123` gives the same work-item guidance.

For a compact ordered action plan at any time—including before initialization,
without an active work item, during pending push recovery, or after workflow
completion—run:

```bash
singularity-flow nextsteps [WORK-ID]
```

In Copilot, use `/sflow-nextsteps [WORK-ID]`. It labels actions as `NOW`,
`THEN`, or `ALTERNATIVE` and never executes them automatically.

Use `/sflow-next` when you want the first valid action executed. Its terminal
equivalent is `sflow-next`, which delegates to `singularity-flow next`.

## Approved phase inputs

Phase inputs make approved upstream artifacts explicit prompt dependencies. The top-level mode is pinned when the work item starts:

```yaml
inputsMode: record          # off | record | enforce

phases:
  design:
    inputs:
      - requirements
      - phase: intake
        optional: true
        maxBytes: 16384
```

- `off`, including a missing key, validates declarations but changes no runtime behavior.
- `record` resolves and injects available approved artifacts, records hashes, and warns when required input is unavailable or tampered.
- `enforce` blocks preparation and publication when required input is unavailable or any present input fails hash verification.

String entries are required and unbounded. An omitted `maxBytes` injects the complete artifact. A work type may replace a phase declaration through `phaseOverrides.<phase>.inputs`.

Inspect or render the prospective generation:

```bash
singularity-flow inputs design --dry-run
singularity-flow inputs design
```

Normal execution updates the marker-delimited managed input block and writes `context/inputs-<phase>-gen<n>.json`. Repeating preparation replaces only that managed block. Publication recollects the approved artifacts so editing the rendered block cannot bypass enforcement. Use `/sflow-inputs` in Copilot.

## governed agents and approval authority

Governed agents combine role instructions and additive world-model views. Starter agents include product owner, architect, developer, and QA. They never represent a real user and never grant approval capability. Story phases reference `approvalAuthorities`; decisions are authorized from a normalized Git email or authenticated GitHub login and record the matched group.

### Copilot multi-user session guidance

Repositories may make Git-backed work-item part of Copilot session startup:

```yaml
session:
  workItemSelection: prompt # off | reuse | prompt
  requireBeforeTools: false
```

Phase-boundary context behavior is separately configurable:

```yaml
contextPolicy:
  onApproval: new       # keep | compact | new
  onRejection: keep
  phaseOverrides:
    implementation: compact
```

Once an approval reaches its threshold and its commit is pushed, `new` tells the contributor to run `/clear` and then `/sflow-next`; `compact` uses `/compact`; and `keep` continues in the same conversation. Initiative phases use `/sflow-initiative-next`. Flow cannot execute a built-in slash command inside its parent Copilot session, so it prints and visibly hands off the exact commands instead. The newly loaded phase is rebuilt from committed governed context, not remembered chat history. Rejection defaults to `keep`, and missing configuration remains backward-compatible.

For work items, `off` preserves the current-branch behavior, `reuse` accepts an active work-item branch but asks when none is active, and `prompt` asks once for every distinct Copilot session ID. `/sflow-session` shows remote candidates and asks for an exact work ID or Jira ID. It then runs the equivalent of:

```bash
singularity-flow session candidates
singularity-flow session attach WORK-123
```

`candidates` fetches the configured remote and lists only branches containing a valid workflow at the expected work-item path. `attach` fetches again, checks out the exact existing local or remote branch when needed, fast-forwards to the remote head, verifies the commit hashes are identical, and loads workflow state from that branch. A missing local branch becomes a tracking branch from Git. A missing remote branch is never created implicitly; use `/sflow-start` for new work.

Ahead, diverged, missing, or malformed state stops without history rewriting or data loss. A dirty tree also stops when attachment would require a checkout or fast-forward. When the requested Story branch is already current and its HEAD exactly matches the freshly fetched remote HEAD, Singularity Flow may bind the Copilot session in place while preserving unpublished phase edits. If a pre-existing local work branch is ahead or diverged, it may remain checked out so the contributor can preserve or publish it. Singularity Flow never merges, rebases, resets, stashes, force-checks out, or deletes work during session attachment. Copilot must start inside a clone of the application repository so the configured remote is available.

The phase contract selects its agent automatically. The bundled plugin's startup hook is advisory: it reminds the
contributor about `/sflow-session` or `/sflow-start`, never invokes a skill
automatically, and never denies Bash, edit, search, view, or other tools.
`requireBeforeTools` therefore defaults to `false`. The setting and the
`agent-guard` CLI handler remain available only for repositories that
deliberately install a custom command hook. Deterministic lifecycle validation
continues to run inside every CLI mutation regardless of hook configuration.

The binding is stored only under `.git/singularity-flow/` and creates no commit. It records the Copilot session ID, selected work item, active phase agent, and any explicit override separately from the authenticated Git identity. `/sflow-agent` can override the phase default without changing approval authority. Run `singularity-flow session status` to inspect work-item readiness and the active agent. The policy is snapshotted into the work item at creation.

An explicit agent override may choose any configured agent for any phase; an incompatible override is visibly warned and audited. Approval authority comes only from the phase’s pinned authority groups and the reviewer’s Git/GitHub identity. The active agent is recorded separately as instruction context and is never presented as independent review.

Start activates the first phase agent and resume activates the current phase agent. The active session is local:

```text
.git/singularity-flow/session.json
```

Selecting an explicit governed-agent override does not create a commit. The next generation, submission, approval, rejection, or document upload records the human actor and active agent separately.

Copilot uses its interactive `ask_user` facility for intake source and workflow choices. The choices are read from the CLI's live YAML-derived menu,
so custom work types appear automatically. With persistent terminal
stdin, the skill sends the selected menu number back to the same CLI process. If
that bridge is unavailable during start or approval, it records the exact `ask_user` answers
in a 15-minute one-time receipt under the Git directory and passes only its token
to the lifecycle command. Approval receipts additionally pin the submitted phase,
generation, and artifact hashes and require the reviewer to type the exact phase
ID. The receipt is bound to the work ID, repository HEAD, and Copilot session when
available, and is consumed once. Concurrent answer processes are serialized by
a short-lived local lock; schema, filename token, repository HEAD, and expiry
timestamps are revalidated on every read. The skill never invents a default or
uses hidden workflow-selection flags. If `ask_user` is disabled, it stops.

Switch the active governed agent at any time without changing committed workflow state:

```text
/sflow-agent
```

```bash
sflow-agent
```

The override remains active for the current phase and checkout. A phase transition or resume activates the new phase default. It is deliberately not pushed; generated and decision records capture the agent that was actually used.

Multi-approval thresholds require distinct authenticated identities. Switching the governed agent does not create another identity.

## Generating and publishing a phase

In Copilot, use `/sflow-phase`. It loads the current phase contract, active governed Agent Markdown, required world-model views, agent-added views, and evidence ledger when needed.

The equivalent CLI sequence is:

```bash
singularity-flow prepare intake
# Complete the generated template.
singularity-flow phase publish intake
singularity-flow submit
```

After publication succeeds and any required push completes, the command prints every generated phase document with its path, SHA-256 hash, and text content. Source files such as Java, JavaScript, TypeScript, Python, Go, and shell scripts are treated as reviewable text; true binary documents print an openable local path. This is the exact published artifact preview, not an AI-generated summary.

Copilot may collapse the Shell tool panel even though the CLI printed the content. Singularity Flow skills therefore reload the phase with `singularity-flow phase show <phase> --json` and reproduce every text document in the visible assistant response between `BEGIN` and `END` path markers. A message such as “documents shown above” without those visible bodies is incomplete and should not be used for approval.

Phase artifacts live under:

```text
singularity/work-items/<WORK-ID>/artifacts/<phase>/
```

Publishing validates write scope, artifact requirements, hashes, traceability, and protected paths. It adds managed metadata, commits `[WORK-ID][phase:<id>][generated:<n>]`, and pushes the branch. Submission runs configured quality checks and creates its own atomic commit and push.

Artifact-only phases cannot modify application source. Implementation and verification may modify source only when their configured write scope permits it.

## Sequence enforcement

Sequence enforcement is configurable gate by gate.

Lifecycle mutations normally follow the configured order:

```text
prepare/edit → publish generation → submit → approve or reject
```

Each sequence guard is configured as `hard` or `soft` in `singularity/workflow.yml`. A missing `sequenceGates` section means every gate is `hard`, preserving existing repository behavior. Global values may be overridden for a work type. The fully resolved policy is snapshotted at work-item creation, so changing the base branch configuration does not alter an active item.

```yaml
sequenceGates:
  default: soft
  completion: hard
  currentPhase: hard
  freshGeneration: hard
  generationCommit: hard
  remoteGeneration: hard
  publicationPending: hard

workTypes:
  feature:
    # Optional overrides for this profile.
    sequenceGates:
      phaseStatus: soft
      documentPhase: soft
```

The configurable gates are:

| Gate | Protects |
|---|---|
| `completion` | Mutating a completed workflow |
| `currentPhase` | Acting on a phase other than the active phase |
| `phaseStatus` | Acting from the wrong phase status, such as approval before submission |
| `freshGeneration` | Submitting without a new generation, including after rejection |
| `generationCommit` | Submitting without the required generation commit |
| `remoteGeneration` | Submitting before the generation reaches the configured remote |
| `publicationPending` | Mutating while a retained local commit still needs synchronization |
| `documentPhase` | Uploading supporting documents outside the configured intake phases |

A `hard` gate exits with code `2` before changing workflow files or creating a commit. A `soft` gate displays the same current state, reason, required command, and consequences, then asks:

```text
Do you want to continue anyway? Type continue to proceed:
```

Only an interactive human can confirm a soft gate. A refusal, any answer other than `continue`, or a non-interactive terminal exits with code `2` without mutation. Copilot must show the warning and leave confirmation to the person; it must never type `continue` or otherwise self-confirm.

```text
Singularity Flow error: Out of sequence [phaseStatus]: cannot approve for phase 'design'.
Current state: phase 'design' is in_progress at generation 1.
Gate mode: hard.
Required next action: Submit published phase 'design' for approval.
Run next: singularity-flow submit --phase design
See all valid actions: singularity-flow nextsteps WORK-123
No workflow files, commits, or remote state were changed.
```

Every confirmed soft override records the gate, action, reason, prior state, authenticated identity, selected agent, and time in workflow history and artifact metadata. `status`, the work-item report, and the governance gate expose these overrides; governance reports them as warnings. A soft override is an audited exception, not a successful independent control.

Starter repositories use soft gates for phase-status and document-phase mistakes while keeping completion, cross-phase actions, generation integrity, remote publication, and pending synchronization hard. Teams may change those defaults before starting a work item. Never bypass either mode by editing `workflow.json`, status files, metadata, or approvals directly.

## Approval, rejection, and self-approval

Use `/sflow-inbox` or `singularity-flow inbox` before choosing a work item when reviewing across a team. It fetches the configured remote and lists only valid committed work-item branches whose current phase is `awaiting_approval`, oldest first. Each row includes the work/Jira ID, phase, generation, approvals received/required, waiting time, authority groups, artifact path, self-approval warning, and remote commit. `singularity-flow inbox --offline` reads cached remote refs without network access.

Selecting an inbox item invokes the existing safe session attachment path. The branch must fast-forward exactly to the fetched remote commit; dirty, ahead, diverged, malformed, or missing states stop without merging, rebasing, resetting, stashing, or discarding work. The phase agent activates automatically; the reviewer sees their Git identity and matched authority group and reviews the complete generated documents before separately choosing approval or rejection.

Approve from a terminal:

```bash
singularity-flow approve WORK-123 --fetch
```

The command fetches the branch, activates its phase agent, displays reviewer identity and authority, hashes, checks, token usage, prior approvals, and any self-approval warning, then requires explicit phase confirmation. If Copilot cannot write to a persistent shell, `/sflow-approve` issues a 15-minute receipt for the exact typed phase ID. The CLI independently revalidates the branch HEAD, submitted generation, artifact hashes, human authority, identity threshold, and receipt before committing and pushing the decision.

Reject to an allowed target:

```bash
singularity-flow reject WORK-123 --fetch \
  --to requirements \
  --reason "Failure behavior is missing"
```

Rejection reopens the target, invalidates target and downstream approvals, and preserves prior artifacts and decisions in Git history.

Self-approval is allowed when the same authenticated person generated and approved a phase, but it is marked `selfApproval: true`. It appears in artifacts, decision records, status, reports, and conformance, and is never described as independent review.

Each approval—including each partial decision toward a multi-approval threshold—creates and pushes a separate atomic commit before the command succeeds. If publication fails, the approval commit remains local, publication is marked pending, and later decisions are blocked until `singularity-flow sync` publishes it.

Use `/sflow-approve` and `/sflow-reject` in Copilot. These commands are explicitly user-invoked and must not run silently.

Submission automatically displays every generated current-phase document before
recommending approval. It includes the stable document ID, repository path, kind,
byte count, SHA-256, and Markdown/text content. Binary and image artifacts are
shown as absolute paths with metadata. Approval displays the same documents again
before the exact phase-name confirmation. Review them at any time with:

```bash
singularity-flow phase show requirements
singularity-flow phase show requirements --json
singularity-flow documents view PHASE-REQUIREMENTS
```

Use `/sflow-next` or `sflow-next --task "<objective>"` to execute exactly one
next valid action. Depending on state, it synchronizes a retained commit,
prepares and grounds the current generation, submits a published generation,
opens the interactive approval flow, or runs the final terminal gate. Generation
and submission remain separate invocations. Approval never bypasses agent
selection or confirmation, and its decision commit must be pushed before success.

## Progress and status

Use status for detailed state and progress for deterministic completion:

```bash
singularity-flow status WORK-123
singularity-flow progress WORK-123
singularity-flow progress WORK-123 --json
```

Progress is `approved phases / total phases`. Singularity Flow never invents fractional credit inside an unapproved phase. The view includes a vertical arrow-based phase map, with distinct markers for completed (`✓`), current (`▶`), awaiting-approval (`◆`), and pending (`○`) phases, followed by the detailed table. It also includes the current position, generations, approval threshold, document count, and token totals.

Use `/sflow-status` for full state and `/sflow-progress` for a concise completion view.

## Workflow performance reports

Reports are read-only projections over committed workflow history:

```bash
singularity-flow report WORK-123
singularity-flow report WORK-123 --format json
singularity-flow report WORK-123 --format html --out workflow-report.html
```

Reports show phase duration, active time, approval waiting, open approval latency, generations, rework, rejections, self-approvals, provider/model identity, exact tokens with per-model totals, optional cost, quality-check duration, and the largest approval-latency bottleneck.

Durations are wall-clock time and include nights and weekends. They are not business-hours or productivity estimates. Token counts are exact only when the provider supplied them. Reports prefer exact provider cost captured by Copilot telemetry and fall back to configured model pricing; incomplete coverage is marked partial.

Use `/sflow-report` in Copilot.

## Token usage and optional cost

Installer-managed Copilot sessions are captured automatically from phase preparation onward. Copilot writes the current chat span only after its response finishes, so publication can initially show `pending`. The next `submit` or `/sflow-next` action reconciles that completed span in a separate commit and push before submission. Raw traces remain inside the repository Git directory, while each generation commits a sanitized record at:

```text
singularity/work-items/<WORK-ID>/telemetry/<phase>-gen<N>.json
```

The committed record excludes prompt/response content, conversation identifiers, and raw traces. For another provider, save exact usage as JSON and publish with:

```bash
singularity-flow phase publish implementation --usage-json usage.json
```

The usage record may contain provider, model, input, output, cached-input and total tokens, timestamps, provider cost, and collection source. Missing values are recorded as `unavailable`; they are never estimated silently. Markdown, HTML, and JSON reports identify the models used per phase and aggregate records and tokens by provider/model. Exact provider cost is used when present; configured per-model pricing is the fallback.

Optional report pricing uses rates per million tokens keyed by the exact provider model name:

```yaml
tokens:
  mode: exact-or-unavailable
  pricing:
    provider-model-name:
      input: 3
      output: 15
      cachedInput: 0.3
```

No model prices are bundled because prices change over time. Exact total tokens without an input/output breakdown cannot be priced safely and remain unavailable for cost calculation.

Use `singularity-flow telemetry status` to see whether the current Copilot process inherited the repository file exporter, the raw-file path and size, completed chat spans, and pending generations. Use `singularity-flow telemetry reconcile [PHASE]` to retry a delayed generation explicitly. Reconciliation commits and pushes only the sanitized record, never the raw trace.

## Git state transfer and recovery

Every successful generation and lifecycle decision is committed and pushed when `git.publish: required` is configured. Resume work from another terminal with:

```bash
singularity-flow resume WORK-123 --fetch
```

Resume performs fetch plus fast-forward-only checkout and asks for a agent. It reconstructs work state from the branch rather than copying a local session.

If push fails, the local commit is retained and transitions are blocked. Fix connectivity or authentication and run:

```bash
singularity-flow sync
```

Sync retries the existing history without rebasing, resetting, or force-pushing. A normal non-fast-forward rejection protects concurrent terminal decisions from overwriting one another.

## World model

The world model grounds phase generation in repository facts:

For a quick, minimum-token baseline, run this inside the application
repository:

```bash
sflow-wm-minimal
sflow-wm-minimal --phase design
sflow-wm-minimal --branch WORK-123 --publish
```

This wrapper performs a validated `quick` build, uses only the `development`
view unless a phase supplies its required views, disables extra discovery
workers, and commits locally without pushing. `--publish` restores the normal
publication policy. Use `--parallel --workers N` when independently resumable
view checkpoints matter more than the minimum number of model calls.

```bash
cd /path/to/the/repository
singularity-flow wm init
singularity-flow wm build --depth standard
singularity-flow wm check

# Optional phase/task-focused build
singularity-flow wm build --phase design --task "Design invoice export"
# Or target an existing branch without switching this checkout
singularity-flow wm build --branch release/2026.07 --phase design --task "Ground the release branch"
# Limit concurrent view discovery on a smaller laptop
singularity-flow wm build --phase verification --workers 2
# Resume an interrupted build; completed exact-match view packets are skipped
singularity-flow wm build --phase verification --workers 2 --resume
singularity-flow wm check --branch release/2026.07
singularity-flow wm compose --phase design --task "Design invoice export" --dry-run
singularity-flow wm compose --phase design --task "Design invoice export"
singularity-flow wm show-prompt
```

The low-level `wm init`, `wm build`, `wm check`, and `wm context` commands remain
repository-scoped and do not take a Jira/work-item argument. In the governed UI
and `/sflow-story-start` lifecycle, however, generation is deliberately deferred
until Story intake has created and checked out the canonical Story branch. A
governed work ID and agent apply when `wm compose` creates a phase prompt.

Use `--branch <name>` on `wm build`, `wm check`, or `wm context` to operate on
any existing local or remote branch. The CLI fetches the remote (default
`origin`), fast-forwards only when safe, and opens an isolated worktree; your
active checkout is never switched. `--remote <name>` selects another remote.
The command stops on divergence or when the target branch is already checked
out elsewhere.

`wm build` runs the configured generator in a detached analysis worktree. Only
its isolated output is accepted. Singularity Flow validates the manifest and
every declared regular file, rejects escaping paths/symlinks and unexpected
repository writes, records a source-tree hash, atomically installs the output,
commits it, and publishes it according to `git.publish`.

For two or more explicit phase/views, parallel generation starts one read-only
discovery worker per view, up to `worldModel.generation.maxWorkers`. Each worker
writes only its own bounded intermediate packet. The packets are ordered by
view and passed to one final synthesizer, so evidence IDs, the manifest,
validation, installation, commit, and push retain a single owner. Use
`--workers N` to reduce concurrency, `--no-parallel` to diagnose a worker/model
problem, or `--parallel` to opt in when testing a custom runner. Do not launch
several independent builds against the same branch.

Completed packets are written immediately to
`singularity/world-model/.checkpoints/<build-key>/`. The key binds the
repository commit and source-tree hash, branch, builder-prompt hash, requested
views, task, focus, and depth. Rerunning the identical build resumes by default:
valid completed packets are reused and only pending, missing, or tampered views
run. Use `--resume` to make that intent explicit or `--no-resume` to discard the
matching checkpoint and rerun all views. A validated successful build replaces
the checkpoint with the final model. Checkpoints are governance state and do
not make the source model stale.

`--local` remains available for diagnostics, but the normal Story lifecycle does
not use it. VS Code and `/sflow-story-start` build after Story intake and publish
the model commit directly to the canonical Story branch. World-model generation
is therefore disabled on `main` and Epic branches.

From the workspace switcher, choose **Reset saved Jira connection** at any time
to delete all encrypted Jira credentials for the current OS account. This does
not edit workspace routing, `portfolio.yml`, repository files, or Git history;
the Jira setup window opens immediately so a different URL/account/token can be
verified.

The initiative portfolio routes context to world-model views that must be declared
in the repository's `workflow.yml` under `worldModel.views`. Portfolio bootstrap
now auto-declares any missing views (covering both the portfolio's needs and the
repository's own phase/agent references), so onboarding a repository without a
`worldModel` block succeeds instead of failing.

`wm compose` renders the active agent prompt with mandatory phase/agent
views, an exact task guide when `--task` is supplied, applicable evidence,
focused `worldModel.injection.rules`, and verified active-agent skills. Rules may
match the active agent, phase, immutable work type, committed or pending
changed-path globs, and Jira/manual source labels. `wm inject` is a compatibility
alias for the same command.

`/sflow-show-prompt` is the read-only audit view for this composition. It prints
the complete packaged `/sflow-phase` `SKILL.md`, then the exact current phase
prompt between explicit markers. That second section contains the phase
contract/template, governed-agent prompt, selected world-model content,
agent Markdown, and approved upstream inputs. It renders without writing
a grounding record or changing workflow/Git state. Use
`singularity-flow wm show-prompt --skill sflow-design` to inspect another
packaged Flow skill against the same phase prompt.

The editable builder prompt is now the v2 progressive-disclosure contract. It
asks the generator for brief and full core/view tiers, domain and task guides,
an evidence ledger, and `index/path-map.json`, with a generation stamp in every
consumer-facing document. v2 manifests are accepted alongside legacy v1 models;
the CLI pins the authoritative timestamp, source commit, branch, working-tree
status, analysis depth, builder version, prompt hash, and generated-view list
before committing the model. This keeps existing repositories readable while
making newly generated models auditable and inexpensive to inject.

```yaml
worldModel:
  # Governed view IDs. A view cannot be removed while a phase, agent,
  # workflow override, injection rule, or Markdown prompt still references it.
  views: [business, architecture, development, testing, release, operations, security]
  generation:
    parallel: true
    maxWorkers: 4           # 1..16
    strategy: view
  grounding: enforce        # off | warn | enforce; absent means off
  staleness: warn           # warn | fail | ignore
  injection:
    placeholder: "{{WORLD_MODEL}}"
    mode: append             # replace | append | off
    maxBytes: 32768
    rules:
      - when: { agent: architect, phase: design }
        include: [domains/payments.md]
      - when: { changedPaths: "src/api/**" }
        include: [domains/api.md]
      - when: { labels: security }
        include: [views/security.md]
```

Preview rule matching without writing an audit record:

```bash
singularity-flow wm compose --phase design --task "Design invoice export" --dry-run
```

Every non-dry-run composition writes
`singularity/work-items/<WORK-ID>/context/<phase>-gen<n>.json` with the agent,
committed model revision, manifest/source hashes, required views, selected files,
SHA-256 hashes, byte counts, and truncation flags. It also writes the exact
rendered prompt to `context/prompts/<phase>-gen<n>.md`. The next `phase publish`
commit carries both files with the generation.

In `enforce` mode, publication fails if composition is absent, stale, uncommitted,
uses the wrong governed agent, omits a required view, or differs from its committed
manifest/prompt snapshot. `warn` reports the same problems without blocking.
`off` skips the grounding gate. The mode is pinned into work-item resolution at start, so
later configuration changes cannot weaken or strengthen an in-flight item.

Context composition is additive:

```text
+ phase skill contract
+ selected governed-agent prompt
+ phase-required world-model views
+ governed-agent world-model views
+ exact task guide (when requested)
+ rule-selected repository world-model files
+ active agent Markdown
+ evidence ledger for verification and conformance
```

Approved phase inputs are injected separately by `prepare` into the managed
artifact template. governed-agent views never remove phase-required views. Verification
and conformance load test/source evidence. Phase skills use `wm compose` once,
building first with the same exact task text when needed.

## Remote Markdown agents

Repository world models always remain repository-generated and repository-owned. agents may additionally declare plain public HTTPS Markdown dependencies in exact tables under these headings. Their files use Copilot’s `.github/agents` convention, but Singularity Flow treats them as context resources—not people or approval identities.

```markdown
## Remote skills

| ID | URL | Phases | Agents | Optional | Max bytes |

## Remote artifact templates

| ID | URL | Phases | Optional | Max bytes |

## Remote generated artifacts

| ID | URL template | Phase | Target | Optional | Max bytes |
```

Only table links are processed; links in prose are inert. Content must be non-empty UTF-8 Markdown. The default limit is 1 MiB and the hard ceiling is 10 MiB. URLs must be public HTTPS without credentials. Dynamic output URLs support only URL-encoded `{workId}`, `{workType}`, `{phase}`, and `{generation}`. Output targets must remain under `artifacts/<phase>/`.

Discover, trust, and activate a agent:

```bash
singularity-flow agents list
singularity-flow agents mappings
singularity-flow agents lock architecture
singularity-flow agents sync architecture
singularity-flow agents status architecture
```

Copilot custom-agent names may be different from Flow agent IDs. Commit
the differences in `singularity/agent-mappings.yml`; omitted agents retain the
same-name fallback:

```yaml
version: 1
mappings:
  enterprise-architect: architecture
```

The mapping selects prompt context only. It never selects a governed agent,
changes the contributor identity, or grants approval authority. Unknown target
packs are rejected during validation. VS Code **Configuration → Agents** exposes
the editable mapping YAML and its effective resolution table.

First trust and every `--update` display hashes and require typing the exact pack name. The committed `singularity/agents.lock.yml` pins source-file and dependency hashes. Sync never updates trust: it verifies the lock, writes an atomic cache under `.git/singularity-flow/`, and records the active agent while preserving the selected governed agent. No authentication, cookies, or bearer tokens are sent.

Remote skills are prompt context for the active agent, not global slash commands. Reference a remote artifact template explicitly with the existing storage syntax `agent:architecture/design-template`; it is copied into the work item and pinned before use. Dynamic generated output is fetched once per prospective generation and reused.

```bash
singularity-flow agents refresh-output threat-model
# Add --replace only after deciding to discard local edits.
```

The bundled `sflow-workflow` Copilot agent contains empty dependency tables, so installation alone performs no remote download. Teams add their own URLs later. VS Code **Configuration → Agents** edits repository agent Markdown, shows lock status, and keeps the lock read-only.

## Conformance and final gate

The final conformance artifact compares every approved `AC-n` and `SPEC-nnn` with source and test evidence. Verdicts are `matched`, `partial`, `missing`, `deviated`, or `unplanned`. Evidence uses exact files and lines, and approved deviations and self-approvals are disclosed.

Run the final deterministic gate:

```bash
singularity-flow gate --terminal
```

The gate validates configuration and template snapshots, artifact hashes and metadata, generation publication, human approval identities and authority groups, prompt-only governed-agent audit data, thresholds, rejection cascades, AC/SPEC/test traceability, conformance freshness, protected paths, and remote branch state.

Conformance stores a source/test tree hash. Later code or test changes make the report stale and require regeneration.

## Configuring workflows

Edit `singularity/workflow.yml` directly or use VS Code **Configuration**. The definition controls:

- `workTypes`: phase sequences and profile overrides
- `inputsMode`: off, warning/audit recording, or enforced approved-artifact dataflow
- `phases`: artifact contracts, approved inputs, write scope, views, checks, and approvals
- `agents`: prompt-only governed agents, views, and suggested phases
- `approvalAuthorities`: real-human authority groups matched to Git/GitHub identity
- repository agent Markdown and `singularity/agents.lock.yml`: optional trust-pinned remote prompt/template/output sources
- `documents`: allowed upload phases and size limits
- `git`: remote and publication policy
- `tokens`: exact-or-unavailable mode and optional pricing
- `governance`: protected paths and traceability rules

Template resolution is work-type override, then phase default, then configuration error. Keep templates in `singularity/templates/` and agent prompts in `singularity/agents/`.

Validate changes before publishing:

```bash
singularity-flow configuration validate --json
singularity-flow validate
```

Process files are protected during phase generation. Change them in a dedicated configuration commit, review them like code, and avoid changing active work-item state manually.

## VS Code extension

The supported visual surface is the Singularity Flow VS Code extension. Its three areas have distinct responsibilities:

- **Workspaces**: local directory, repositories, and capability scope.
- **Lifecycle**: intake, workflow selection, phases, artifacts, progress, and approvals.
- **Configuration**: workflows, phases, gates, agents, prompts, skills, templates, integrations, and world-model rules.

Build and install the extension with `npm run vscode:package`, then `code --install-extension apps/vscode/singularity-flow-vscode-0.9.0.vsix --force`. Jira secrets entered through **Singularity Flow: Connect Jira Securely** use VS Code `SecretStorage`. Use **Open Governed Context in Copilot** to render the full skill, phase agent, world model, approved inputs, and task context into native Copilot chat.

The Electron application is retired and preserved only at `desktop-final-v0.9.0`.

## Copilot commands

Preferred direct skills use the collision-safe `sf-` prefix. The equivalent
`sflow-*` plugin skills remain available for backward compatibility:

| Copilot command | Purpose |
|---|---|
| `/sf-about` | Explain the Singularity Flow brand, installed version, capabilities, and command namespace |
| `/sf-start` | Guided Jira or manual intake and workflow selection; the first phase agent is automatic |
| `/sf-resume` | Fetch, fast-forward, and activate the current phase agent |
| `/sf-agent` | Select or change the prompt-only governed agent for the current local work-item session |
| `/sf-session` | Select a work/Jira ID, synchronize its remote branch, then activate the current phase agent |
| `/sf-inbox` | Fetch pending approvals across committed remote work-item branches and open a selected review safely |
| `/sf-help` | Load this manual or explain the selected work-item workflow |
| `/sf-logs` | Read the activity log to explain what a command, hook, or world-model build did; works while a session is gated |
| `/sf-nextsteps` | Show the ordered next, subsequent, and alternative actions at any time |
| `/sf-next` | Execute exactly one next valid lifecycle action |
| `/sf-inputs` | Preview or render approved upstream artifact inputs |
| `/sf-phase` | Generate the current phase using its contract and world model |
| `/sf-show-prompt` | Display the complete phase skill and exact governed prompt without changing state |
| `/sf-requirements` | Requirements-focused generation |
| `/sf-design` | Architecture/design-focused generation |
| `/sf-implement` | Implementation-focused generation |
| `/sf-verify` | Verification and evidence generation |
| `/sf-submit` | Submit the current generated phase |
| `/sf-approve` | Explicitly review and approve a submitted phase |
| `/sf-reject` | Explicitly reject to an allowed earlier phase |
| `/sf-status` | Show detailed work-item state and warnings |
| `/sf-progress` | Show deterministic phase completion |
| `/sf-report` | Show timing, waiting, rework, token, and bottleneck metrics |
| `/sf-upload` | Upload files, folders, notes, images, Figma exports, or HTTPS references to the active Epic or Story |
| `/sf-documents` | List, view, and upload supporting documents |
| `/sf-review` | Review current artifacts and evidence |
| `/sf-release` | Prepare final release/conformance activities |
| `/sf-jira-story` | Inspect or import one Jira story |
| `/sf-jira-work` | Find assigned Jira work |
| `/sf-jira-initiative` | Browse Epics, adopt child stories into an initiative, and prepare reviewed Jira write plans |
| `/sf-workflow-rules` | Explain deterministic workflow rules |

If commands do not appear, run `singularity-flow plugin install`, close existing Copilot sessions, start a new session, and check `copilot plugins list --kind skill`.

## Installation and company registries

From a clean clone, the supported local update/install workflow is:

```bash
./install.sh
```

`npm run install:local` invokes the same script.

It performs a fast-forward-only pull, asks for the npm registry, installs locked dependencies, builds the VS Code extension, runs tests and checks, creates the tarball, replaces the global CLI, removes old plugin identities, installs the current marketplace plugin, and enables the metadata-only Copilot OpenTelemetry file exporter in the active shell profile. Raw telemetry stays at `<git-dir>/singularity-flow/copilot-otel.jsonl`; prompt and response content capture remains disabled. Publication commits sanitized phase summaries under `singularity/work-items/<WORK-ID>/telemetry/` for Git state transfer.

For a company Artifactory or registry:

```bash
./install.sh --registry https://artifacts.company.com/artifactory/api/npm/npm-virtual/
```

Or set `SINGULARITY_FLOW_NPM_REGISTRY`. Authentication remains in `.npmrc`; do not embed credentials or tokens in the URL. The installer rejects dirty checkouts and never resets, rebases, or force-pushes.

If Copilot telemetry is managed centrally, opt out of the local file exporter:

```bash
./install.sh --no-copilot-telemetry
# or
SINGULARITY_FLOW_COPILOT_TELEMETRY=off ./install.sh
```

The generated shell entry does not override an existing `COPILOT_OTEL_FILE_EXPORTER_PATH`, `OTEL_EXPORTER_OTLP_ENDPOINT`, or explicit `COPILOT_OTEL_ENABLED` setting. Fully exit any currently running Copilot CLI process, open a new terminal in the repository, verify `type copilot`, and start a new session. An existing process cannot inherit newly installed environment variables.

## Low-friction cockpit, diagnostics, and guided execution

Run `singularity-flow` with no arguments, or `singularity-flow cockpit`, to open the terminal cockpit. It shows the current work item, agent, assignment, progress, current phase, blockers, and deterministic next actions without changing state. In Copilot use `/sflow-home`.

```bash
singularity-flow doctor
singularity-flow doctor WORK-123 --offline
singularity-flow run --task "Implement the approved screen contract"
```

Doctor checks Node and Git, YAML and workflow state, the phase agent, human authority configuration, assignment policy, pending publication, working-tree safety, upstream configuration, and remote reachability. Guided execution may prepare grounding/artifacts or offer submission, but always stops for authoring and approval. It never treats an agent as approval permission and never approves automatically.

## Workflow catalog and preflight simulation

```bash
singularity-flow workflow list
singularity-flow workflow simulate figma-mobile
singularity-flow workflow diff figma-mobile
singularity-flow workflow add figma-mobile --dry-run
```

`workflow add` copies the profile plus missing Markdown templates/agent prompts and validates the resulting YAML. Customized profiles are never overwritten unless `--replace` is explicit. Changes remain uncommitted for normal configuration review. Active work items keep their immutable resolution snapshots.

## Review bundles, assignments, and watching

```bash
singularity-flow review design
singularity-flow review design --format html --out singularity/reviews/WORK-123-design.html
singularity-flow assign design "mobile-team"
singularity-flow watch WORK-123 --once
```

The review bundle contains the artifact in full, input provenance, checks, approvals/self-approval warnings, model/token records, source changes, and supporting evidence. VS Code **Lifecycle → Reviews** renders the same data. Assignments are committed/pushed coordination metadata, not governed-agent restrictions. Configure `collaboration.assignmentMode` as `off`, `suggested`, or `required`; required assignments block publication and submission.

## Design package inventory and gallery

`singularity-flow documents upload ./figma-export` recursively preserves paths and hashes and creates committed `PKG-nnn` package records with `manifest.json`, `inventory.md`, and a local `gallery.html`. The inventory reports types, sizes, empty files, and duplicate hashes. VS Code **Lifecycle → Documents** has separate file and folder actions.

## Safe recovery and Copilot session guidance

### Factory-reset repository state

`init --repair` is additive and preserves customization. When a genuinely clean
restart is required, use the guarded factory reset instead:

```bash
singularity-flow factory-reset --dry-run --json
singularity-flow factory-reset --confirm "RESET <repository-folder-name>"
singularity-flow init --check --json
```

The preview lists every removed, replaced, and preserved scope plus any
uncommitted reset-scope files. The confirmed operation removes `singularity/`,
legacy `.singularity/`, and `.git/singularity-flow/`; installs workflow,
portfolio, capability, agent-mapping, template, prompt, and packaged-agent files
from the currently installed npm package; and leaves the result uncommitted.
Application source, Git history, workspace clones, the global workspace
registry, and non-packaged custom agents are preserved. Use
`/sf-factory-reset` in Copilot for the same guarded flow.

```bash
singularity-flow recover WORK-123 --fetch
singularity-flow recover WORK-123 --fetch --apply
```

Recovery is plan-first. Apply only retries retained publication or performs a
clean fast-forward; it never resets, rebases, force-pushes, stashes, or discards
work. The bundled Copilot plugin uses a nonblocking `sessionStart` prompt for
guidance and a nonblocking `subagentStart` command hook for exact custom-agent
name to agent mapping. The mapping activates only local-only packs or
already locked and cached remote packs; it never fetches, trusts, changes a
governed agent, or grants approval authority. No `preToolUse` guard is registered.
Work-item synchronization happen only when the
contributor explicitly invokes `/sflow-session`, `/sflow-start`, or the
equivalent CLI command.

## Troubleshooting

### Copilot plugin is installed but commands are missing

Run:

```bash
singularity-flow plugin install
copilot plugin list
copilot plugins list --kind skill
```

Only `singularity-flow@singularity-flow` should remain. Close existing Copilot sessions because sessions do not always reload newly installed skills.

### Start or approval says an interactive terminal is required

Updated `/sflow-start` and `/sflow-approve` skills keep you inside Copilot even when `write_bash` or persistent stdin is unavailable. Start uses `singularity-flow choices begin start <WORK-ID> --json`; approval uses `singularity-flow choices begin approve <WORK-ID> --fetch --json`. Each asks you for the returned choices and invokes the lifecycle command with a one-time receipt. If an installed skill still directs you to a terminal immediately, update the repository, run `./install.sh`, open a new terminal, and start a new Copilot session so the refreshed skill is loaded. Raw non-interactive start or approval without either a TTY or a valid receipt still fails safely.

Resume, governed-agent switching, and rejection continue to require their interactive picker when invoked without a dedicated UI bridge; they never reuse a start or approval receipt.

### A transition is blocked after push failure

The local lifecycle commit is intentionally retained. Fix remote access, then run `singularity-flow sync`. Do not rewrite or force-push the branch.

### Artifact-only phase reports source changes

Move source changes to implementation or verification. Intake, requirements, design, and specification phases normally permit only their phase artifact and managed state.

### Approval identity is rejected

Check `git config user.email` (or the authenticated GitHub login for comment-driven decisions) and compare it with the phase’s configured `approvalAuthorities`. Selecting Architect, QA, or another governed agent cannot grant permission.

### Jira fields are empty or wrong

Use `singularity-flow jira fields --query <name>` against the Jira site and configure the returned custom-field IDs in the documented environment variables.

### Report token or cost values are unavailable

Run `singularity-flow telemetry status`. If it says the exporter is not active, fully exit Copilot, open a new terminal in the repository, verify `type copilot`, and start a new Copilot session. If a generation is pending, finish the current Copilot response and let the next `submit` or `/sflow-next` reconcile it, or run `singularity-flow telemetry reconcile <PHASE>` explicitly. Older turns created before telemetry was enabled cannot be reconstructed. If token data exists but cost does not, the provider did not expose exact cost or the exact model name has no configured price. Singularity Flow does not estimate these values.

### VS Code cannot open a repository

Confirm the directory is a Git repository and contains the current `singularity/workflow.yml`. This development release does not migrate former control folders or lifecycle schemas. For a repository with no current control folder, run `singularity-flow init` on the intended work branch and commit the initialized files. For an incompatible development checkout, use the guarded `singularity-flow factory-reset` flow.

### Remote agent sync reports stale or changed content

Run `singularity-flow agents status <AGENT>`. If Agent Markdown or a remote hash changed, use `singularity-flow agents lock <AGENT> --update`, inspect the old/new hashes, type the exact agent name, commit the lock, and sync again. Never edit the lock by hand.

### Remote generated output has local edits

Review the local artifact first. `singularity-flow agents refresh-output <RESOURCE-ID>` will preserve conflicting local edits and explain the conflict. Add `--replace` only when you intentionally want the newly fetched Markdown to overwrite them.

### An initiative template does not exist

A repository initialized before the `initiatives/` template subtree shipped does
not have it, and template installation never overwrites local edits. Starting an
initiative and preparing a phase both install any **packaged** template the
repository is missing, into the templates root the portfolio declares, and commit
what they installed with the phase — so this normally resolves itself.

If the error persists, the template is not one Singularity Flow ships. The
message names every unresolved output at once, for example:

```text
Profile 'epic-planning' references 2 initiative templates that do not exist
and are not packaged with Singularity Flow:
  - discover-define/business-case → singularity/templates/initiatives/generic-output.md
  - discover-define/scope → singularity/templates/initiatives/custom-scope.md
```

Add each file under the portfolio's `templatesRoot`, or point the output at a
template that exists. A template that changed after the initiative was created
reports a hash mismatch instead: restore the exact recorded content or start a
new initiative, because the resolution is immutable by design.

## CLI command reference

```text
singularity-flow about
sflow-about
singularity-flow help [TOPIC] [--json]
singularity-flow init
singularity-flow start <WORK-ID> [--jira | --story-file FILE] [--ref CANONICAL-BRANCH]
singularity-flow resume <WORK-ID|BRANCH> [--fetch]
singularity-flow agent [WORK-ID]
sflow-agent [WORK-ID]
singularity-flow guide [WORK-ID] [--json]
singularity-flow nextsteps [WORK-ID] [--json]
singularity-flow next [--task TEXT] [--fetch] [--yes] [--skip-checks]
singularity-flow run [--task TEXT] [--yes]
singularity-flow cockpit
singularity-flow doctor [WORK-ID] [--offline] [--json]
singularity-flow review [PHASE] [--format md|html|json] [--out FILE]
singularity-flow workflow list|simulate|diff|add|upgrade
singularity-flow assign <PHASE> <ASSIGNEE>
singularity-flow watch [WORK-ID] [--once] [--fetch] [--interval SECONDS]
singularity-flow recover [WORK-ID] [--fetch] [--apply]
sflow-next [--task TEXT] [--fetch] [--yes] [--skip-checks]
singularity-flow inputs [PHASE] [--dry-run]
singularity-flow agents list
singularity-flow agents mappings
singularity-flow agents lock <PACK> [--update]
singularity-flow agents sync <PACK>
singularity-flow agents status [PACK]
singularity-flow agents refresh-output <RESOURCE-ID> [--replace]
singularity-flow status [WORK-ID] [--json]
singularity-flow progress [WORK-ID] [--json]
singularity-flow report [WORK-ID] [--format md|html|json] [--out FILE]
singularity-flow telemetry status [--json]
singularity-flow telemetry reconcile [PHASE] [--json]
singularity-flow documents list [WORK-ID] [--json]
singularity-flow documents view <DOCUMENT-ID|PATH> [--work-id ID]
singularity-flow documents upload <FILE-OR-DIRECTORY...> [--url URL]
singularity-flow documents browse --provider <ID> [--path FOLDER] [--json]
singularity-flow documents fetch --provider <ID> --ref <ITEM> [--name NAME] [--label TEXT] [--kind KIND]
singularity-flow prepare [PHASE]
singularity-flow phase show [PHASE] [--json]
singularity-flow phase publish [PHASE] [--usage-json FILE]
singularity-flow artifact add <PATH...> [--kind KIND] [--phase PHASE]
singularity-flow artifact scan [--phase PHASE]
singularity-flow submit [--phase PHASE]
singularity-flow approve [WORK-ID] [--fetch]
singularity-flow reject [WORK-ID] [--fetch] --reason TEXT [--to PHASE]
singularity-flow pr [WORK-ID] [--create] [--yes] [--json]
singularity-flow sync
singularity-flow validate [--strict]
singularity-flow gate [--terminal]
singularity-flow wm build [--branch BRANCH] [--remote REMOTE] [--local] [--views LIST] [--focus TEXT] [--parallel|--no-parallel] [--workers N] [--resume|--no-resume]
sflow-wm-minimal [--phase PHASE] [--views LIST] [--branch BRANCH] [--parallel] [--workers N] [--publish]
singularity-flow wm context|check [--branch BRANCH] [--remote REMOTE]
singularity-flow wm inject
singularity-flow jira assigned|list|pull|fields
singularity-flow jira status|projects|epics|children|permissions|boards|board
singularity-flow jira transitions|transition|assign|priority|sprint|comment
singularity-flow plugin install|uninstall|list|path
singularity-flow snapshot [WORK-ID] --json
singularity-flow state planes [WORK-ID] [--json]
singularity-flow state reconcile [WORK-ID] --check|--repair-projections [--json]
singularity-flow logs [--tail N] [--level LEVEL] [--event PATTERN] [--since WHEN] [--json]
singularity-flow logs path|level
singularity-flow home [--json]
singularity-flow workspace list|current|use|prompt|copilot
singularity-flow story branch create|attach|status|promote
singularity-flow story submit
singularity-flow initiative start|resume|phase|context|documents|checklist
singularity-flow initiative evidence|approve|reject|breakdown|materialize|sync
singularity-flow initiative jira-adopt|jira-plan|jira-apply
singularity-flow epic start|sources|generate|submit|create-stories
singularity-flow epic review|checks|status|complete
singularity-flow epic journey [INIT-ID] [--json]
singularity-flow epic merge-plan [--epic INIT-ID] [--json]
```

`state reconcile --check` is read-only and compares every declared projection with
the authoritative lifecycle state: status Markdown, managed artifact metadata,
approval summaries, review/finalization packets, and ledger intents. Use
`--repair-projections` to reproduce stale or missing projection bytes and publish one
audited lifecycle commit. It never creates an approval, artifact, transition, or
remote receipt.

Run `singularity-flow --help` for the current terse usage list and `singularity-flow help <topic>` for one section of this manual.
