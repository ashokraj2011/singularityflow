# The organisation's marketplace (OMK) — v1: owners, reviewed lifecycles, stable and beta channels, and what each item did here

**Specification ID:** `OMK-v1`

**Status:** M1 and M2 built. M1 (the metadata read and shown, §4, §5) is on main (merged at `8a386d941`, 2026-11-26).
M2 (the safety review, §7) is built on branch `omk-m2` from main `2809f6edc`, 2026-11-26, not merged yet; what it
built, and where it differs from the text below, is under §7 "Built in M2". M3 to M7 are not built. Written on 2026-11-26
from the owner's decisions of that day (roadmap Bet 4). Checked against `bet4` at `5ac41f37e`.

**Owner, 2026-11-26.** Bets 2, 3 and 4 are the priority, and every open decision for Bet 4 is answered:
1. **Lifecycle approval.** The marketplace repository's own code owners approve a change of an item's lifecycle
   (proposed → approved → generally available → deprecated). The change is recorded in that repository, as a reviewed
   change to the item's metadata. SFlow reads it and shows it.
2. **Usage and outcomes stay local for now.** Each repository works out, from its own records, which Stories and steps
   used each item, what Copilot credits those steps cost, and what review findings they produced. Nothing is sent
   anywhere. In the owner's words: "future this will go to a governance plane". So the result has a documented export
   shape that a later plane can collect, and v1 builds no sending.
3. **Update channels: stable and beta.** A team trusts one channel of a marketplace. Stable moves only after beta. Every
   update still goes through SFlow's review before a Story uses it. Today's pinned commit is the base: moving a channel
   moves the pin through the existing reviewed path.

The roadmap adds four more things:
- an **owner** for each item, an owning team, shown everywhere;
- **feedback to owners**: one click from a Story to an issue on the item, with the evidence attached (MCR's feedback,
  reused);
- a **safety review**: imported text is checked before its first use;
- deprecated items are flagged wherever they are still used.

**Builds on:**
- **Repository marketplaces.** These are trusted at a pinned commit (`src/marketplace-repository.mjs`,
  `src/commands/marketplace-repository.mjs`). The commit moves only through `marketplace add --repo` and its reviewed
  configuration change.
- **HTTPS index marketplaces.** An index lists entries, each pinned by SHA-256 (`src/marketplace.mjs`).
- **The app-store catalog.** `marketplace catalog` (`src/marketplace-catalog.mjs`) gives each item a status: installed,
  update available, not installed, local only, or not approved yet. It takes `--newest`. The VS Code Marketplace page
  (`apps/vscode/src/views/marketplace-page.ts`, `marketplace.ts`) shows that answer, with **Get newer…**.
- **The All skills page.** `skill catalog` (`src/skill-catalog.mjs`) and `apps/vscode/src/views/all-skills-page.ts`
  show every skill. Each row has its lifecycle mark, who uses it, its overlaps and the gaps.
- **Skills a task chooses.** `src/task-skills.mjs` decides which skills a task uses. It knows the lifecycle words ready,
  unreviewed and retired. It never offers a retired skill, and it asks for a yes before it uses an unreviewed one.
- **The marketplace conversion review** ([MCR-v1](SPEC-MCR-MARKETPLACE-CONVERSION-REVIEW-v1.md)). It gives structured
  findings with an owner, provenance and updates, and the feedback actions **Save as Markdown**, **Copy** and **Open an
  issue** (`src/conversion-review.mjs`, `src/agent-workflow-provenance.mjs`).
- **The import pipeline** (`src/asset-import.mjs`). It runs `import preview` and `import add`, and keeps the import
  record in `singularity/imports.lock.yml`. Its checks refuse secrets, web pages and NUL bytes. `imports check` and
  `skill restore` belong here too.
- **Story records.** A Story keeps its frozen workflow snapshot (`src/workflow-snapshots.mjs`), its review records
  (`context/reviews/<step>/gen-<N>/`), finding overrides (`src/finding-overrides.mjs`) and failing tests sent back
  (`src/failing-tests-return.mjs`).
- **Copilot credits per step.** `src/copilot-session-usage.mjs` keeps local records, and `src/report.mjs` assigns them
  to steps for Story Analytics.
- **The sample marketplace** (`test/fixtures/sdlc-marketplace`). It is the office layout: an `apm.yml` at the root, and
  `agents/<n>/{agent.md, apm.yml}` and `skills/<n>/{SKILL.md, apm.yml}`, with `lifecycle-state` and a
  `registry/pdlc-taxonomy.yml`.

---

## 1. Why

A marketplace is how an organisation shares agents, skills and workflows. Today SFlow trusts a marketplace at a commit,
shows what is installed, converts agents and checks for updates. The organisation still cannot answer five questions:

1. **Who owns this item, and may we use it?** Each item's lifecycle is one word in its `apm.yml` (`lifecycle-state:
   approved`). Nobody can see who approved it, or when. Anyone who can merge to the marketplace can change it.
2. **How do new versions reach teams safely?** A team moves its pin to the newest commit, or does not move it at all.
   It cannot choose "early versions" or "only what others have tried".
3. **Is it any good here?** Nothing says which Stories used an item, what those steps cost, or how often their work came
   back from review.
4. **Is the text safe?** An imported skill is checked for secrets, and for being a web page. Nothing looks for hidden
   characters or for instructions that work against SFlow's rules, and both reach an agent's prompt.
5. **What do we still use that its owners have retired?** A deprecated skill stays in the library, in workflows and in
   running Stories. Nobody is told.

OMK answers each question with records the marketplace already keeps, or can keep with a small, backward-compatible
addition. Nothing in OMK needs a server.

## 2. What exists today (checked against `5ac41f37e`)

| Piece | Where | What it does today | What OMK adds |
|---|---|---|---|
| Package metadata | `parsePackageManifest` in `marketplace-repository.mjs` | Reads `lifecycle-state`, `maintainer-email`, `source-repository`, the tags, `pdlc-*` and the dependencies. | The owner and the lifecycle record (§4.1, §4.2); the channels, from `channels.yml` beside the root `apm.yml` (§4.3) |
| Index entries | `parseMarketplaceIndex` in `marketplace.mjs` | Reads id, kind, version, label, description, tags, phases, url and sha256. Unknown fields are ignored. | Owner, lifecycle and channel fields (§4.4) |
| Lifecycle words | `READY`, `UNREVIEWED` and `RETIRED` in `task-skills.mjs`; `lifecycleWords` in `conversion-review.mjs`; `marketplace-lifecycle` in `agent-workflow.mjs` | Three sets. `deprecated` and `retired` are treated alike. `agent-workflow.mjs` flags every state that is not `approved`, so `ga` gets flagged too. | One vocabulary, which separates deprecated from retired (§5.1) |
| Trust | `normalizeMarketplaces` | `{ label, repository, ref, commit }` or `{ label, index, allowedOrigins }`. Any unknown field is refused. | Nothing new. A channel is the marketplace's own `ref` (§6) |
| Pin move | `marketplace add --repo` (a repin) and Studio's **Read its newest commit** | Reads the tip of `ref` and proposes `commit:` as a reviewed change. It names the workflows that need an update. | The move review, and the channel order and rewind checks (§6) |
| Catalog | `analyzeMarketplaceCatalog` | Gives a status and actions for each item, plus `lifecycle` and `readiness`. | Owner, lifecycle record, channel, deprecated in use, safety, usage (§5, §7–§9) |
| Pages | Marketplace page; All skills page | A lifecycle column and a lifecycle filter. | Owner, who and when, channel, badges, usage, feedback |
| Import checks | `inspectImportContent` | Refuses secrets, HTML and NUL bytes. | Safety checks (§7) |
| Feedback | `feedbackIssue`, `feedbackDocument` | A Markdown document and a prefilled new-issue link for conversion findings. | Feedback on any item, from a Story, with evidence (§10) |
| Usage | the `usedBy` of `skill catalog` | Agents and workflows that attach a library skill, and the task Stories in this checkout whose composition chose it. | Every Story, every step, every item kind, with credits and outcomes (§9) |

## 3. Terms

- **Item:** one agent, skill, template, workflow, MCP server or generated source that a marketplace lists. It is named
  `(marketplace, kind, name)`. It has versions, and each version's text has a SHA-256.
- **Owner:** the team that owns an item. Its feedback goes to that team.
- **Lifecycle record:** the item's state, and how it got there: who approved each change, when, and in which reviewed
  change.
- **Code owners:** the people or teams that the marketplace repository's `CODEOWNERS` file names for a path. The
  repository's host requires their approval before a change to that path is merged.
- **Guarded:** a lifecycle record is guarded when a `CODEOWNERS` rule covers its file.
- **Channel:** a named ref (a branch or a tag) that a marketplace publishes for teams to trust. OMK defines `stable` and
  `beta`.
- **Channel trust:** a marketplace trust whose `ref` is one of the marketplace's channels.
- **Move:** changing a trust's pinned commit to its ref's newer tip. It is a reviewed configuration change, as it is
  today.
- **Use:** a Story step whose frozen snapshot holds an item's text, or whose workflow was made from an item.
- **Outcome:** what the Story's own records say happened at a step that used an item: findings on its work, a return,
  an override, failing tests sent back, and the credits it cost.

## 4. Item metadata: what a marketplace writes

Every addition is optional. A marketplace that adds nothing behaves exactly as it does today (§4.5). YAML files keep the
kebab-case keys of the office format. The index keeps its camelCase keys.

### 4.1 Owner: in each package's `apm.yml`

```yaml
# skills/web-e2e-test-generation/apm.yml (only the new block is shown)
owner:
  team: web-qa                      # short ID, lower-case kebab-case
  name: Web QA                      # what people see
  handle: "@acme/web-qa"            # the code-owner handle, as CODEOWNERS writes it
  contact: web-qa@example.test
  issues: https://git.example.test/acme/sdlc-marketplace/issues   # where feedback goes
  feedback-labels: [sflow-feedback, web-e2e-test-generation]
```

**OMK:REQ-001, owner.** SFlow reads `owner` from each package's `apm.yml`. When it is missing, the owner comes from the
first of these that exists:
1. the code owners of the item's folder (§5.2);
2. `maintainer-email`;
3. the marketplace's `marketplace.owner`.

The item says which of these its owner came from: "Owner: Web QA" or "Owner: maintainers@example.test (from
maintainer-email)". An `issues` address must be https. When it is not, it is dropped, and the item carries a
`marketplace-metadata` finding.

### 4.2 Lifecycle record: `lifecycle.yml` beside the item's `apm.yml`

```yaml
# skills/web-e2e-test-generation/lifecycle.yml
# Changed only through a reviewed pull request that this file's code owners approve (see CODEOWNERS).
state: ga
history:
  - to: proposed
    at: 2026-09-14
    by: "@acme/web-qa"
    change: https://git.example.test/acme/sdlc-marketplace/pull/12
  - from: proposed
    to: approved
    at: 2026-10-02
    approved-by: ["@acme/marketplace-stewards"]
    change: https://git.example.test/acme/sdlc-marketplace/pull/31
    note: Piloted by two teams on the checkout web app.
  - from: approved
    to: ga
    at: 2026-11-01
    approved-by: ["@acme/marketplace-stewards"]
    change: https://git.example.test/acme/sdlc-marketplace/pull/40
```

A deprecated item adds who replaces it, and until when it is supported:

```yaml
state: deprecated
deprecation:
  replaced-by: web-e2e-test-generation-v2
  reason: Uses the old page-object layout; v2 uses role locators.
  sunset: 2027-03-31
history:
  # ... earlier entries ...
  - from: ga
    to: deprecated
    at: 2026-11-20
    approved-by: ["@acme/marketplace-stewards"]
    change: https://git.example.test/acme/sdlc-marketplace/pull/57
```

The record is a file of its own for one reason: a `CODEOWNERS` rule can guard a file, but not a single key inside
`apm.yml`. As its own file, the record can be guarded by the marketplace's governance group while each item's team
still owns its own `apm.yml` and text.

**OMK:REQ-002, where the lifecycle comes from.** SFlow takes an item's lifecycle from the first of these that exists:
1. `lifecycle.yml` in the item's folder;
2. a `lifecycle:` mapping in its `apm.yml`, with the same shape;
3. `lifecycle-state` in its `apm.yml`, which is today's key, with no who or when;
4. a `lifecycle:` tag;
5. nothing, which means unmarked.

A record that keeps `lifecycle-state` in `apm.yml` for APM's sake must agree with the file. When they differ, the file
wins, and the item carries a `marketplace-lifecycle-mismatch` finding.

**OMK:REQ-003, checking the record.** The record is data, so SFlow checks that it holds together. It never refuses an
item for its record. Each problem is a marketplace-owned finding, raised in MCR's way. The checks:
- the last history entry's `to` equals `state`;
- each entry's `from` is the previous entry's `to`;
- each move is allowed (§5.1);
- the dates are in order, and none is after the commit's own date;
- every name in `approved-by` is a code owner of the record's file (§5.2).

At most 50 entries are read, each at most 1,000 characters.

### 4.3 Channels: `channels.yml` beside the marketplace's root `apm.yml`

```yaml
# channels.yml, at the repository's root beside apm.yml
channels:
  beta:
    ref: channels/beta
    description: New and changed items, about two weeks before stable.
  stable:
    ref: channels/stable
    after: beta              # stable may only move to a commit that is already on beta
```

The channels are a file of their own, as the lifecycle record is, because APM 0.35's `apm pack` refuses any key it does
not know in `apm.yml`'s `marketplace:` block (probe P1, §15). A file of its own also holds up whatever APM tightens later.

**OMK:REQ-004, channels.** The top-level `channels:` of `channels.yml` maps a channel name to
`{ ref, description?, after? }`:
- the names v1 knows are `stable` and `beta`;
- `ref` is a branch or tag name, as the trust's `ref` accepts;
- `after` names another channel of the same marketplace.

The file is at most 64 KiB. A wrong entry is left out with a problem that names `channels.yml`; nothing is refused. A
`marketplace.channels` key in `apm.yml` is not read as channels: it raises one marketplace-owned finding,
`marketplace-channels-misplaced`, which says to move it to `channels.yml` because `apm pack` refuses it, and the read goes
on with no channel.

SFlow reads `channels.yml` at the commit a trust is pinned to. On a first trust it reads it at the ref being trusted.
The new commit's channels must name the same ref for the channel being moved. When they do not, the move review says
so first (§6).

### 4.4 The index format: optional fields in `sflow-marketplace@1`

```json
{
  "format": "sflow-marketplace@1",
  "name": "Acme shared skills",
  "channel": "stable",
  "channels": {
    "stable": { "index": "https://skills.example.test/stable.json", "after": "beta" },
    "beta": { "index": "https://skills.example.test/beta.json" }
  },
  "entries": [
    {
      "id": "security-review", "kind": "skill", "version": "2.1.0",
      "url": "https://skills.example.test/security-review/2.1.0/SKILL.md", "sha256": "…",
      "owner": { "team": "appsec", "name": "AppSec", "issues": "https://git.example.test/acme/skills/issues" },
      "lifecycle": {
        "state": "ga",
        "history": [ { "from": "approved", "to": "ga", "at": "2026-11-01", "approvedBy": ["@acme/appsec"],
          "change": "https://git.example.test/acme/skills/pull/9" } ]
      }
    }
  ]
}
```

**OMK:REQ-005, index fields.** The index format stays `sflow-marketplace@1`, because an older build ignores fields it
does not know. An index entry may carry `owner` and `lifecycle`, with the same meaning as §4.1 and §4.2. An index may
say which channel it is (`channel`) and where its other channels are (`channels`). Every channel's `index` must be an
origin the trust already allows: SFlow never follows a channel to an origin that the configuration does not name.

An index has no `CODEOWNERS` that SFlow can read. Its lifecycle is shown as "as the index states it" and is never
called guarded.

### 4.5 Backward compatibility

**OMK:REQ-006.** Both directions keep working:
- **A marketplace with none of the additions.** New SFlow behaves as it does today:
  - the lifecycle comes from `lifecycle-state` and the tags;
  - the owner comes from `maintainer-email` or the marketplace owner;
  - there are no channels, and `ref` is a plain ref.
- **An SFlow build from before OMK.** It reads a marketplace that has every addition, and a channel trust, without a
  refusal. Its parsers read only the keys they know (checked in `parsePackageManifest`, `parseMarketplaceManifest` and
  `parseMarketplaceIndex` at `5ac41f37e`), it never reads `channels.yml`, and a channel trust is an ordinary `ref` (§6).
- **`workflow.yml` gains no key.** Today's `normalizeMarketplaces` refuses unknown fields, so a new key would stop every
  teammate who has not yet upgraded.
- **Import records only gain optional fields under `source`.** These are owner, channel and the safety look (§7).
  `parseImportsLedger` checks only `kind` and `source`. The bundle reader and the transfer review must carry the new
  fields unchanged; a test at M1 holds that.
- **The kept listings move to a new format.** The per-commit listings (`sflow-task-marketplace-skills` and `-agents`)
  go to v3, so a kept v2 listing is read again once.

## 5. Reading it and showing it

### 5.1 One lifecycle vocabulary

| State | The marketplace's own words that map to it | A task offers it | It can be installed | A person sees |
|---|---|---|---|---|
| `proposed` | proposed, draft, submitted | after the person says yes | yes, and the review says "proposed" | "Proposed by Web QA on 14 Sep; not yet approved" |
| `early` | experimental, beta, alpha, preview | after the person says yes | yes, and the review says so | "Experimental: approved for early use; it may still change" |
| `approved` | approved | yes | yes | "Approved by @acme/marketplace-stewards on 2 Oct" |
| `ga` | ga, released, stable, generally-available | yes | yes | "Generally available since 1 Nov" |
| `deprecated` | deprecated | never; its replacement is offered when it fits | yes, after the review shows the deprecation and its replacement first | "Deprecated on 20 Nov: use web-e2e-test-generation-v2 (supported until 31 Mar 2027)" |
| `retired` | retired, withdrawn, archived | never | no | "Retired: no longer supported" |
| unmarked | (none) | a marketplace item needs a yes; a library skill written here is used as it is, as today | yes | "No lifecycle recorded" |

**OMK:REQ-010.** One module, `src/marketplace-lifecycle.mjs`, owns this table: its parsing, its moves and its words.
`task-skills.mjs`, `marketplace-catalog.mjs`, `skill-catalog.mjs`, `conversion-review.mjs` and `agent-workflow.mjs`
use it. The `marketplace-lifecycle` finding fires only for `proposed`, `early` or unmarked. Today it also fires for
`ga`.

The allowed moves:
- proposed → approved or retired;
- approved → ga, deprecated or proposed;
- ga → deprecated;
- deprecated → ga or retired;
- early is treated like proposed.

Any other move is a `marketplace-lifecycle-jump` finding. It is shown, and nothing is refused.

**OMK:REQ-011, the state that counts.** SFlow uses an item's state at the commit the repository trusts now, or the index
as it was read last, kept for its hour. It does not use the state recorded at import. So a library skill imported while
approved, and deprecated since, is treated as deprecated once the pin moves. When the marketplace cannot be read, the
recorded state is used, and the item says so.

**OMK:REQ-012, a beta channel needs a yes.** An item read through a beta channel trust (§6) is offered only after the
person's yes, whatever its state. A deprecated or retired item is never offered.

### 5.2 Guarded by code owners

**OMK:REQ-013.** SFlow reads the marketplace's `CODEOWNERS` at the pinned commit, from the first of these paths that
exists: `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`, `.gitlab/CODEOWNERS`. The new module
`src/codeowners.mjs` handles it:
- its patterns follow GitHub's and GitLab's syntax;
- for one path, the last rule that matches wins;
- GitLab's sections are joined;
- the file is at most 64 KiB and 2,000 rules.

For each item it works out:
- **guarded:** whether a rule covers the item's lifecycle record file;
- **approvers:** the code owners of that file;
- **owner confirmed:** whether `owner.handle` is among the code owners of the item's folder.

The words people see:
- "Approved by @acme/marketplace-stewards, the code owners of its lifecycle record";
- "Lifecycle not guarded by code owners: anyone who can merge to the marketplace can change it";
- "Owner named in apm.yml; CODEOWNERS names someone else for its folder".

**OMK:REQ-014, what guarded means.** SFlow cannot see the host's branch protection. Guarded therefore means that the
marketplace declares code owners for the record. It does not mean the host enforced them. The words say "declares", and
the maintainer guide (§11) says how to make the host enforce it. An unguarded approval still counts as approved, as it
does today (open question 1), and every surface labels it.

### 5.3 Where it shows

**OMK:REQ-015.** The owner, the lifecycle (state, who, when, and its change link), the channel and the guard show on:

| Surface | What it shows |
|---|---|
| `marketplace catalog [--json]` | New row fields: `owner {team, name, handle, contact, issues, from}`, `lifecycleRecord {state, since, by, change, guarded, approvers, deprecation}`, `channel`, `deprecatedInUse`, `safety` and `use`. Each row keeps the `lifecycle` and `readiness` it has today. The text output adds an owner column and a lifecycle line for each item that is not ga. |
| `marketplace browse <ID>` | An owner and lifecycle line under each entry. |
| The VS Code Marketplace page | An **Owner** column and an Owner filter. The lifecycle column shows the state, and its detail row shows who, when and the change link (opened in the browser). Channel badges read **Beta** and **Stable**. The badges **Deprecated · in use here**, **Retired · in use here** and **Not guarded** appear where they apply. No commit and no hash is shown. |
| The All skills page and `skill catalog` | The owner, the lifecycle with who and when, deprecated in use, and the channel. |
| Workflow Studio, Library and Make a workflow | The owner and lifecycle on each row. The conversion review's **Where it came from** shows the owner and the lifecycle record (MCR §4.1). |
| `/sf-marketplace` (Copilot) | Columns for owner, lifecycle and channel, and the deprecated-in-use words, all taken from the catalog's `statusWords`. |
| Task skill offers (`/sf-task`, `work`) | The plan line names the owner and the state. For example: `(with web-e2e-test-generation from acme (Web QA), beta and new here: add it?)`. A deprecated attached skill gets `web-e2e-test-generation is deprecated by Web QA: web-e2e-test-generation-v2 replaces it`. |
| A Story's start and its Story Analytics step cards | The items each step uses, each with its owner and state (§8, §10). |

## 6. Channels: trusting one, and moving it

A channel trust is an ordinary repository trust, whose `ref` is the ref the marketplace publishes for the channel:

```yaml
# singularity/workflow.yml
marketplaces:
  acme:
    label: Acme SDLC marketplace
    repository: https://git.example.test/acme/sdlc-marketplace
    ref: channels/stable          # the marketplace's stable channel (its channels.yml says so)
    commit: <the full commit ID>   # what Stories read; it moves only through a reviewed change
```

**OMK:REQ-020, trusting a channel.** `marketplace add <ID> --repo <URL> --channel stable|beta` does the following:
1. It reads `channels.yml` at the repository's default branch to find the channel's ref.
2. It reads that ref's tip, and checks that the `channels.yml` there names the same ref for the channel.
3. It proposes `{ repository, ref, commit }` through the same reviewed change `--ref` makes today.

`--channel` and `--ref` together are refused. So is a channel the marketplace does not publish; that refusal names the
channels it does publish. Workflow Studio's **Trust a marketplace** form shows a **Channel** choice when the repository
publishes channels, with stable chosen first.

**OMK:REQ-021, knowing a trust is a channel.** A trust is a channel trust when its `ref` is a channel's `ref` in the
`channels.yml` at its pinned commit. There is nothing else to keep in step. An older build sees a plain ref, and moving it
reads the same tip.

**OMK:REQ-022, stable moves only after beta.** When a move would take a channel with `after: beta` to commit B, SFlow
checks that B is on beta first. It reads beta's tip and fetches beta's history into the transient isolated object
repository, at most 1,000 commits (probe P3). Then it checks that B is beta's tip or one of its ancestors.
- **B is on beta:** the move goes ahead.
- **B is not on beta, and beta's history was read in full:** the move is refused with `MARKETPLACE_CHANNEL_ORDER`.
  The words: "The stable channel is at a version that was never on beta. Ask the marketplace's maintainers to move beta
  there first."
- **B is not within the 1,000 commits read:** the review says "SFlow could not confirm this commit was on beta first",
  and the move needs the person's yes (`--confirm-channel-order`).

**OMK:REQ-023, a rewound channel.** Within the same history read, when the commit trusted now (A) is not an ancestor of
B, the channel was rewritten. The review says so first, and the move needs the person's yes
(`--confirm-channel-rewind`). A channel that only moves forward needs neither yes.

**OMK:REQ-024, the move review.** A move shows what changes for this repository between A and B, read at both commits.
It shows no commit or hash. In order:
1. **Lifecycle changes**, each with who and when. For example: "web-e2e-test-generation: ga → deprecated by
   @acme/marketplace-stewards on 20 Nov; web-e2e-test-generation-v2 replaces it."
2. **Items added, removed or changed**, by kind and version.
3. **Owner changes.**
4. **Safety results on every changed text** (§7).
5. **What it means here:**
   - the installed items that will show **Update available**;
   - the workflows made from changed agents;
   - the items that become deprecated or retired while still in use (§8).

The review is the same proposal as today's repin, and is approved like any configuration change.

**OMK:REQ-025, every update is still reviewed.** A move changes what the catalog and a task's offers read, and nothing
else. An installed skill, agent, template or workflow keeps its text until its own update is reviewed and approved,
which is today's `import add … --replace` and MCR's Update. A running Story keeps its frozen snapshot. The move review
offers **Move and update these N items**. That is one change set holding the pin move and the updates of the installed
items whose new text passes the safety checks. It is reviewed as one proposal, and nothing in it applies until that
proposal is approved.

**OMK:REQ-026, index channels.** An index trust names one channel's index URL. The index's `channel` field says which
channel that is. An entry read from a beta index is offered with a yes (REQ-012). A stable entry whose SHA-256 the beta
index (read now) does not list is marked "not seen on beta". It is not refused, because SFlow cannot read an index's
history. Switching channels is a reviewed `marketplace add <ID> --index <the other channel's URL>`, which the catalog
offers as an action.

**OMK:REQ-027, network only when asked.** Channel reads and history reads happen only when a person asks: `marketplace
add`, **Check for newer versions**, **Get newer…**, or the move review. `singularity-flow check` never fetches (MCR
REQ-031 holds).

## 7. Safety review on first use

Imported text goes into an agent's prompt, so it is checked before its first use. The checks look for what a person
reviewing the text could miss, or what would work against SFlow's own rules. They are rules, not a model: the same text
always gives the same answer.

**OMK:REQ-030, the checks.** A new module, `src/import-safety.mjs`, checks a text and gives findings. Each finding has
a check ID, a line, a severity and words. The checks:

| Check | What it finds | Severity |
|---|---|---|
| `hidden-characters` | Bidirectional controls (U+202A–202E, U+2066–2069), zero-width characters (U+200B–200F, U+2060–2064, and U+FEFF anywhere but the first character), Unicode tag characters (U+E0000–E007F), and other invisible format characters | block |
| `rule-bypass` | Text telling an agent to skip or get around an approval; to approve, publish or merge on its own or without asking; to turn off or get around hooks, checks or SF Guard; to edit `singularity/`, `sflow/config`, `.github/hooks` or SFlow's records; or to ignore earlier or system instructions | block |
| `credential-access` | Text telling an agent to read or print credentials: `~/.ssh`, `~/.aws`, `.env`, keychains, `gh auth token`, `printenv`, tokens | block |
| `pipe-to-shell` | Downloaded content run straight away (`curl … \| sh`, `wget -O- … \| bash`, `iwr … \| iex`) | block |
| `secret` | Today's secret scan (`scanText`) | block, as today |
| `hidden-markup` | HTML comments or hidden elements that hold instructions; `display:none` | look |
| `encoded-payload` | Base64 or hex runs of 200 characters or more, and `data:` URIs | look |
| `data-upload` | Commands that send data out (`curl -d`, `--data`, `-F`, `POST` to a URL) | look |
| `destructive-command` | `git push --force`, `git reset --hard` against a remote branch, `rm -rf` on `/` or `~`, `--no-verify` | look |
| `sflow-command` | A line naming one of SFlow's approve, decision, override, pause, guard or confirmation commands (`singularity-flow approve`, `/sf-decide` …): the person checks that it asks the person and does not run it for them. The read-only forms are not flagged: `pause status`, `pause off`, `guard status`, `guard report`, `guard remote-check`, `approvals`, `decision show`, `decisions` with no answer, `appeal show`, `appeal list`, `appeal preflight`, `appeal evidence-prepare` | look |
| `outside-link` | Every URL whose host is not the marketplace's own, listed once per host | note |

**OMK:REQ-031, what each severity does.**
- **block.** The import is refused with `IMPORT_SAFETY_BLOCKED`. The refusal shows the lines, with every invisible
  character spelled out (for example `[U+202E]`). Each block is also a marketplace-owned finding, so the feedback of
  §10 offers to send it.
- **look.** The preview shows the lines under **Look at these lines**. The import needs the person's yes: the review
  card's checkbox in VS Code, or `--looked <check IDs>`, which the preview returns, in the terminal or Copilot. The
  import record keeps `source.safety: { checker, looked: [{ check, line, lineSha256 }] }`. A later update asks again
  only for lines that changed.
- **note.** Shown in the preview. It needs nothing.

**OMK:REQ-032, where the checks run.**
- **`import preview`** for a skill or a template, and **`workflow from-agent`** for an agent's `agent.md` and every
  skill it brings. In the conversion review they are rows under **Checks** (MCR §4.5).
- **Updates:** `import add … --replace`, MCR's Update, and the move review (§6), on every changed text.
- **Installed text, once per SFlow build.** This covers the library, the agents' skills and templates, and runs the way
  `custom-workflow-health.mjs` does. Results are kept in the Git folder, keyed by the text's SHA-256 and the checker's
  version. An installed text that gives a block-level finding is:
  - never offered by a task;
  - flagged on the Marketplace and All skills pages;
  - reported by `singularity-flow check` as a warning;
  - named in the plan line of a Story whose workflow attaches it.
  It is never removed, and running Stories are untouched (open question 3).

**OMK:REQ-033, honest limits.** The checks are labelled as what they are, "SFlow's text checks", and never called a
security review. They catch hidden text and plain attempts to get around SFlow's rules. They do not catch a clever
prompt. SFlow's hooks, approvals and frozen snapshots stay the safety boundary.

**Built in M2 (2026-11-26, branch `omk-m2`).**
- `src/import-safety.mjs` holds the checks of REQ-030 (checker `sflow-text-checks/2`), the gate that names what still
  needs a yes, the refusals `IMPORT_SAFETY_BLOCKED` and `IMPORT_SAFETY_LOOK_NEEDED` (each with a whole command or the
  review card's tick), and the words. A warning against a thing is no finding: a negation just before it ("never skip
  the approval"), or a clause that opens with one, also across a wrapped line ("Do not …, approve your own artifacts,
  disable checks/hooks"). A negation inside a condition is not one ("If the tests do not pass, skip the approval" is
  refused). `hidden-characters` also counts the control characters other than tab and line ends, and the Hangul fillers.
- Checker 2 (2026-11-26), from running the checks over SFlow's own skills and templates: naming SFlow's approve,
  decision, override, pause, guard or confirmation commands left `rule-bypass` for the look `sflow-command`, its
  read-only forms unflagged, because an SFlow-aware skill names them to tell the person what to run; and an HTML comment
  that is SFlow's own marker (`<!-- sflow:guidance … -->`, as well as `sflow-`) is no hidden markup. Every check still
  reads every line, a comment's included. Over the 389 tracked texts of `plugin/skills/` and `templates/`: 195 refused and
  87 with a look under checker 1; none refused and 26 with a look (46 `sflow-command` lines, in the approval, decision,
  confirmation, appeal and pause skills) under checker 2, held by `test/omk-safety-self-check.test.mjs`. A look recorded
  under checker 1 for an unchanged line is still honoured: the record matches a line by its check and digest, not by the
  checker. A line newly found by `sflow-command` is asked about once. The sweep's kept results are checked again, and a
  look its import record already holds is no flag there either.
- `import preview` refuses a block before anything is staged; its JSON carries `safety { state, findings, looks }`, and
  its add command carries `--looked` for the looks it listed. `import add` checks the staged bytes again before it builds
  the change, and Workflow Studio's apply checks them a third time from the bytes it adds. An agent replaced with
  `--replace` and no `--id` is found, for its record's looked lines, by the name its own file gives, as the replace finds
  it (2026-11-27). An import's `source.safety`
  is written only when there were lines to look at.
- `secret` stays today's refusal at import (`IMPORT_SECRET_DETECTED`, run first); it is a `secret` block in the sweep and
  the conversion review, which never scanned secrets before.
- `imports check` checks every changed text: a refused one keeps its row with no update command and says why; a look
  lists only the lines its record did not look at.
- `workflow from-agent` checks `agent.md` and each skill's `SKILL.md` (a Checks row named `text-checks`, with its lines);
  a block goes into the feedback for the marketplace as an `import-safety` finding and the workflow is not made; a look
  needs `--looked`, kept in the workflow's record with the file of each line.
- The sweep is `src/installed-text-safety.mjs`: every library skill (written here or imported), each import whose file is
  text (an agent's skill, a template, an agent, a workflow's agent file), kept in `.git/singularity-flow/` by text SHA-256
  and checker. `singularity-flow check`, `skill catalog`, `marketplace catalog` and a task's plan read it. The Copilot
  session-start hook never runs it (it costs one read of each text the first time): each run keeps the list of what it
  flagged beside its results, and the session's start says that list in one line with `/sf-marketplace` (or
  `singularity-flow marketplace catalog`) to see the lines. With nothing kept, or a list kept by another checker, it says
  nothing (2026-11-27).
- A task never offers or uses a refused library skill; the plan line says `not <ID>: SFlow's text checks refuse its
  text` at the step it would have fitted, and at each step of the team's own workflow that attaches it. Naming it with
  `--use-skill` is refused (`TASK_SKILL_TEXT_REFUSED`).
- VS Code: Studio's import review card shows **Look at these lines** with **I looked at these lines**; the conversion
  review's Checks row has the same tick, which re-reads the review with `--looked`. The Marketplace and All skills pages
  badge an installed copy **Refused by text checks** or **Lines to look at**. `/sf-import` shows the lines and asks.
- Probe P7 ran on the sample marketplace and SFlow's own library skills only: no block, no look. The office
  marketplace's run needs a person on the office host, and its result tunes the rules before M2 merges.

## 8. Deprecated and retired items still in use

**OMK:REQ-040, what counts as in use.** An item is in use here when any of these is true:
1. the library holds it, imported from the marketplace;
2. an agent's skill imports hold it;
3. a workflow here was made from it (MCR provenance);
4. a workflow here attaches a library skill that came from it;
5. an open Story's frozen snapshot holds its text (§9.1).

The item is deprecated in use, or retired in use, when its state at the trusted commit (REQ-011) is deprecated or
retired. With `--newest`, or in a move review, an item that is deprecated only at the newer commit is marked "deprecated
in the marketplace's newest commit".

**OMK:REQ-041, where it is flagged.** It is never removed, and it never blocks (open question 3). It is flagged on:
- the catalog row: `deprecatedInUse { state, replacedBy, sunset, uses: { library, agents, workflows, openStories } }`,
  and the words "Deprecated by Web QA on 20 Nov; still used by 2 workflows and 1 open Story. Use
  web-e2e-test-generation-v2.";
- the Marketplace page, with a **Deprecated in use** filter;
- the All skills page;
- Workflow Studio's view of each workflow that uses it, which offers **Make a workflow from the replacement** for an
  agent;
- `singularity-flow check`, as one warning line for each item. It reads the kept listing and never fetches. With no
  kept listing it says "not checked";
- the plan line of a task, when its workflow attaches a deprecated skill;
- the Story start line, when the Story's workflow was made from a deprecated agent;
- Copilot's `/sf-marketplace`.

When Bet 2's **Needs you** inbox lands, each deprecated-in-use item becomes one entry there.

**OMK:REQ-042, the replacement.** When `replaced-by` names an item that the same marketplace lists, the row offers
that item's preview and install, through the same reviewed import. A replacement that is itself deprecated or retired is
not offered, and the row says so.

## 9. Usage and outcomes, worked out here

### 9.1 Sources: the Story records already kept

**OMK:REQ-050, which Stories.** `src/marketplace-usage.mjs` reads Stories with no fetch and no checkout:
1. **Landed Stories:** `singularity/work-items/*/workflow.json` in this checkout, as `skill-catalog.mjs` reads it today.
2. **Open Stories on this machine:** the machine-wide Story index's entries for this repository (`story-index.mjs`).
   Their records are read from their local branch tips through Git objects.
3. **Under SSB** ([SSB-v1](SPEC-SSB-STORY-STATE-BRANCH-v1.md)), once it lands: the local `refs/singularity/state/<ID>`
   refs, read through SSB's single Story-path resolver.

The read is bounded:
- at most 500 Stories;
- `--since` (default 90 days) applies to when a Story started;
- each Story's result is kept in the Git folder, keyed by the digest of its records, so a second read costs nothing.

**OMK:REQ-051, which items a step used.** For each step of each Story, SFlow reads its frozen snapshot manifest:
- `workflow-skill`, `agent-skill` and `governed-agent` assets, each with its SHA-256 and its steps;
- the task composition's skills (`storyComposition`);
- the workflow ID.

It maps each one to an item and version through the import record at the Story's own configuration commit
(`policy.configurationSource.commit`), read from local Git objects:
- a skill's or template's SHA-256 maps to its `library-skill:` or `skill:` record, giving marketplace, entry and
  version;
- the workflow ID maps to its `workflow:<id>` provenance, giving marketplace, agent and version.

When the commit or the record is not available, today's import record is used, and the row says so. A text found in
neither is "not from a marketplace". The snapshot format does not change: older builds verify these snapshots strictly,
so OMK adds nothing to them.

**OMK:REQ-052, outcomes.** These come from the same Story's records, attributed to the steps that used the item:

| Outcome | Where it is read |
|---|---|
| Findings on its work | Review records (`context/reviews/<step>/gen-<N>/`) against a step that used it, by class and severity |
| Findings it raised | The same records, when a review step used it |
| Sent back | `phase_rejected` events and review-corrections rollovers for that step |
| Overridden | Finding overrides on that step (`finding-overrides.mjs`) |
| Failing tests sent back | `failing-tests-return.mjs` records that name that step |
| Credits | The step's Copilot-reported AI credits and premium requests, through `report.mjs`'s step attribution. The sources are SFlow's own kept session records on this computer (`copilot-session-usage.mjs`) and the step's committed usage records. Copilot's own logs are never read here (owner rule 2026-10-16): the figures are as last synced. |

**OMK:REQ-053, credits are a step's, shared.** A step that used three items counts its credits once for each of them.
Every figure says "credits of the steps that used it", never "what it cost". The report's total for the repository is
counted once, and each figure states its coverage: "credits recorded on this computer for 9 of 15 steps".

### 9.2 The report for each item

**OMK:REQ-054.** For each item, and for each version of it:
- Stories, steps, step intents and open Stories;
- the first and last use;
- credits: the total, and the median per step, with its coverage;
- findings on its work: the total, the number per step, and the counts by class and severity;
- findings it raised (review items only);
- times sent back, findings overridden, and failing tests sent back;
- deprecated in use, and the safety state.

Versions sit side by side, so that a team can see whether 1.2.0 came back from review less often than 1.1.0. The report
gives no scores and no rankings. These are counts, with the records they came from.

### 9.3 CLI, page and Copilot

**OMK:REQ-055.**
- **`singularity-flow marketplace usage [--marketplace ID] [--item KIND:NAME] [--since DATE] [--json]`.** It is
  answered in `src/commands/marketplace.mjs` without loading the monolith, as `catalog` is. It is read-only, needs no
  model and does no network read. With `--item` it lists that item's Stories and steps, by work ID, for this computer
  only.
- **The Marketplace page.** Each row's detail gets a **Used here** section: its counts, and links to the Stories that
  open their Story Analytics. A **Usage** summary sits above the tabs. There is a **Used here** filter.
- **The All skills page.** It shows the same counts for each skill, beside its `usedBy`.
- **Copilot `/sf-marketplace`.** The words "usage" or "used" make it run `marketplace usage --json` and show one table.

### 9.4 The export, for a future governance plane

**OMK:REQ-060.** `singularity-flow marketplace usage --export <FILE> [--since DATE]` writes one JSON document. Nothing
sends it. The command opens no network connection. v1 has no upload, no schedule and no background run.

```json
{
  "format": "sflow-marketplace-usage/v1",
  "generatedAt": "2026-11-26T10:00:00Z",
  "sflow": { "version": "0.0.0" },
  "repository": { "key": "sha256:<of the normalized origin URL>", "softwareKinds": ["web", "backend"] },
  "period": { "from": "2026-08-28", "to": "2026-11-26" },
  "coverage": { "stories": 42, "openStories": 5, "storiesWithCredits": 17, "sources": ["landed", "local-branches"],
    "aiCredits": 1840.5, "premiumRequests": 512 },
  "items": [
    {
      "marketplace": { "id": "acme", "repository": "https://git.example.test/acme/sdlc-marketplace", "channel": "stable" },
      "kind": "skill", "name": "web-e2e-test-generation", "version": "1.2.0", "contentSha256": "…",
      "owner": { "team": "web-qa", "name": "Web QA" },
      "lifecycle": { "state": "ga", "since": "2026-11-01", "guarded": true },
      "use": { "stories": 12, "openStories": 2, "steps": 15, "byIntent": { "test": 12, "code": 3 },
        "firstUsed": "2026-09-02", "lastUsed": "2026-11-25" },
      "credits": { "attribution": "step", "aiCredits": 312.4, "premiumRequests": 88, "stepsCounted": 9 },
      "outcomes": { "findingsOnWork": { "total": 21, "byClass": { "correctness": 9, "tests": 12 }, "bySeverity": { "blocking": 4, "advisory": 17 } },
        "findingsRaised": null, "sentBack": 3, "overridden": 1, "failingTestsReturned": 2 },
      "flags": { "deprecatedInUse": false, "safety": "clean" },
      "months": [ { "month": "2026-10", "stories": 5, "steps": 6, "aiCredits": 120.0, "findingsOnWork": 8, "sentBack": 1 } ]
    }
  ]
}
```

**OMK:REQ-061, what it never holds.**
- No Story IDs, branch names, file paths or person names.
- No finding, prompt, document or code text.
- No commit of this repository.

The repository is a key: the SHA-256 of its normalized origin URL. A plane that knows the organisation's repositories
can match the key, and nobody else can read a name from it. Finding classes and severities are SFlow's own fixed words.
A test greps every export for every work ID, path and person name in its fixture.

**OMK:REQ-062, a stable shape.**
- The format is versioned.
- v1 only ever gains optional fields.
- Items are sorted by marketplace, kind, name and version, and the same records give the same bytes, apart from
  `generatedAt`.
- The schema ships as `docs/contracts/omk/marketplace-usage-v1.schema.json`, with a topic page that explains each field.

A later spec adds sending, behind the owner's own decision.

## 10. Feedback to owners, with evidence

**OMK:REQ-070, from where.** A person gives feedback on an item from any of these:
- a Story's Story Analytics step card, as **Feedback on web-e2e-test-generation…** for each item the step used;
- the Marketplace page's item detail, as **Feedback to Web QA…**, which picks a Story from its **Used here** list or
  none;
- the terminal: `singularity-flow marketplace feedback <KIND>:<NAME> [--marketplace ID] [--work-id ID [--step STEP]]
  [--out FILE] [--json]`;
- Copilot's `/sf-marketplace`, with the words "feedback on …".

**OMK:REQ-071, what the evidence holds.** The engine builds one feedback document with MCR's `feedbackDocument` shape
`{ name, markdown, issue }`. Its parts:
- **The item:** marketplace, kind, name, version, channel, lifecycle state and owner.
- **What happened at the step:** its step intent (for example "a test step"), and its outcome counts from §9.1: findings
  on its work by class and severity, times sent back, findings overridden, failing tests sent back, and the step's
  credits. It also gives the SFlow version and the date.
- **Findings the person chooses.** Each finding of the step is listed in the preview with its words. None is included
  until the person ticks it, because finding words can name code.
- **Safety findings** on that item's text, and its lifecycle record findings. These belong to the marketplace (§4.2,
  §7).
- **The person's own note.**

By default it never holds the Story ID, the repository, a branch, a file path, code, a prompt or a person's name, which
is MCR REQ-011's rule (open question 2). The person reads all of it in the preview before anything opens.

**OMK:REQ-072, where it goes.** The issue goes to the first address that exists:
1. `owner.issues`;
2. the item's `source-repository`;
3. the marketplace repository.

The issue has:
- **title:** "Feedback on web-e2e-test-generation 1.2.0 from an SFlow Story";
- **labels:** the item's `feedback-labels`, where the host takes labels in the address;
- **actions:** MCR's own, which are **Save as Markdown**, **Copy** and **Open an issue**.

Open an issue opens the person's browser, and the person submits it. SFlow never posts, never emails and never opens an
issue itself. A body too long for the address is copied for pasting, as MCR does. On a host with no new-issue address
(probe P4), the page opens the repository's issues, and the body is copied.

## 11. The maintainer's guide: setting up a marketplace repository

This section becomes `docs/topics/marketplace-maintainers.md` at M1.

**1. Add an owner to each item.** Add the `owner:` block of §4.1 to each item's `apm.yml`. Use the team's code-owner
handle.

**2. Give each item a lifecycle record.** Create `lifecycle.yml` beside each `apm.yml` (§4.2). Keep `lifecycle-state` in
`apm.yml` equal to `state`, if APM tools read it.

**3. Declare the code owners.** The governance group owns every lifecycle record, and each team owns its items. GitHub
and GitLab use the last rule that matches, so the lifecycle rule comes last:

```text
# .github/CODEOWNERS (GitHub) or CODEOWNERS (GitLab)
*                                      @acme/marketplace-stewards
/skills/web-e2e-test-generation/       @acme/web-qa
/agents/qa-test-automation-agent/      @acme/qa-guild
/apm.yml                               @acme/marketplace-stewards
/registry/                             @acme/marketplace-stewards
# Last, so it wins: every lifecycle change needs the stewards.
**/lifecycle.yml                       @acme/marketplace-stewards
```

**4. Make the host enforce it.**
- **GitHub.** Protect the default branch and both channel branches. Turn on "Require review from Code Owners" and
  "Dismiss stale approvals". Allow no direct pushes.
- **GitLab.** Protect the branches. Turn on "Code owner approval" and use approval rules. A `[Lifecycle]` section can
  require more than one approval.
- **Azure DevOps.** It reads no `CODEOWNERS`. Set required reviewers by path in the branch policy
  (`*/lifecycle.yml` → the stewards). Keep a `CODEOWNERS` file as the declaration that SFlow reads, and keep the two in
  step (probe P2).

**5. Change a lifecycle.** Open a pull request that changes only the item's `lifecycle.yml`:
- set `state`;
- add one `history` entry with `from`, `to`, `at`, `approved-by` (the code owners who will approve it) and `change`
  (this pull request's address);
- for a deprecation, add the `deprecation:` block.

Title it `lifecycle: web-e2e-test-generation ga → deprecated`. The code owners approve it, and it merges. SFlow shows
the new state to a team when the team's pin next moves.

**6. Publish channels.** Declare them in `channels.yml` beside the root `apm.yml` (§4.3), never as a `channels` key in
`apm.yml`'s `marketplace:` block, which `apm pack` refuses. Create the `channels/beta` and `channels/stable` branches,
protected and fast-forward only.
- Move beta to a commit on the default branch. Use a pull request into `channels/beta`, or a protected fast-forward.
- After the soak time, move stable to a commit that is already on beta.
- Never rewrite a channel. SFlow asks every team for a yes when a channel is rewritten (REQ-023).

**7. Check the repository in CI.** Run `singularity-flow marketplace check-repository . --json` (REQ-080) on every pull
request. It applies the checks SFlow applies when it reads the marketplace: manifest, packages, owners, lifecycle
records and their moves, the code-owner guard, channels, and the safety checks on every text. It exits non-zero on an
error. A job of the same kind can refuse a stable move to a commit that is not on beta
(`git merge-base --is-ancestor <new stable> channels/beta`).

**8. What teams send back.** Feedback arrives as issues on `owner.issues`, with the label you named. Each issue shows
the item version and a step's outcome counts, never the team's code. Teams' usage stays in their own repositories until
a governance plane collects the export of §9.4.

**OMK:REQ-080, a check for maintainers.** `singularity-flow marketplace check-repository <FOLDER|URL> [--json]` reads a
marketplace exactly as a trust reads it: a folder as it is, or a URL at its default branch. It reports every
marketplace-owned finding, each with a fix. It needs no SFlow repository and writes nothing. The sample marketplace
fixture gains owners, lifecycle records, a `CODEOWNERS` and channels (in `channels.yml`). It also gains one seeded bad
item for the tests:
an unguarded record, a jump from proposed to ga, and a hidden character. Updating the public simulation repository is
its own reviewed push. That repository is public, so its content needs a de-identification review first.

## 12. Surfaces

| Surface | Read and show (§5) | Channels (§6) | Safety (§7) | In use (§8) | Usage (§9) | Feedback (§10) |
|---|---|---|---|---|---|---|
| VS Code: Marketplace page | owner, lifecycle, channel, guard | Channel badge; **Get newer…** opens the move review | a row badge; **Look at these lines** on install | badges and a filter | **Used here** and a summary | **Feedback to …** |
| VS Code: All skills | owner, lifecycle | channel | a badge | a badge | counts | — |
| VS Code: Workflow Studio | Library rows; the conversion review | the Trust form's Channel; the move review | the conversion review's Checks | on each workflow | — | MCR's buttons |
| VS Code: Story Analytics | the items on each step card | — | — | a step that used a deprecated item | — | **Feedback on …** |
| Copilot | `/sf-marketplace`, `/sf-task` plan line, `/sf-import` review | `/sf-marketplace` "newer versions" | `/sf-import` relays the lines and `--looked` | `/sf-marketplace` | `/sf-marketplace` "usage" | `/sf-marketplace` "feedback on …" |
| Terminal | `marketplace catalog`, `browse`, `skill catalog` | `marketplace add --channel`, the move flags | `import preview`, `import add --looked` | `check`, `marketplace catalog` | `marketplace usage [--export]` | `marketplace feedback` |

A Copilot turn may read and prepare. Trusting, moving, importing and updating stay the person's reviewed steps, as they
are today.

## 13. Acceptance

- **A1, nothing changes without metadata.** On today's sample marketplace and an index with no new fields, the
  answers of `marketplace catalog`, `browse`, `skill catalog` and a task's offers are what they are at `5ac41f37e`,
  apart from new fields that are null or empty.
- **A2, older builds.** An SFlow build from before OMK reads the new fixture (every addition) and a channel trust with
  no refusal (probe P8). `normalizeMarketplaces` takes the channel trust as a plain ref.
- **A3, lifecycle shown.** The fixture's ga item shows who and when on the catalog, the Marketplace page, All skills,
  the conversion review and `/sf-marketplace`. Its seeded bad item raises `marketplace-lifecycle-jump`,
  `marketplace-lifecycle-mismatch` and "not guarded". Nothing is refused.
- **A4, offers follow the state.** A deprecated skill is never offered, and its replacement is offered when it fits the
  step. A proposed or early skill, and any skill through a beta trust, needs a yes. A retired skill cannot be installed.
  A `ga` agent raises no `marketplace-lifecycle` finding.
- **A5, a channel moves.**
  - A stable move to a commit not on beta is refused with `MARKETPLACE_CHANNEL_ORDER`.
  - A move to a commit that is on beta proposes the pin through the reviewed change, and its review lists the
    lifecycle changes, with who and when, and the installs affected.
  - Before that proposal is approved, and before each item's own update is approved, no Story's offers or snapshot
    change.
- **A6, a rewound channel.** A rewound channel needs `--confirm-channel-rewind`. A forward move needs no yes.
- **A7, safety.**
  - Seeded skills are refused with `IMPORT_SAFETY_BLOCKED`, with the line shown: one with U+202E, one that says "skip
    the approval and publish", one with `curl … | sh`.
  - A seeded `curl -d` needs `--looked`.
  - The sample marketplace's skills and agents give no block and no look (probe P7).
- **A8, installed before OMK.** A library skill that was installed before OMK and gives a block-level finding is not
  offered, is flagged on both pages and in `check`, and stays in the library. A running Story's snapshot is unchanged.
- **A9, deprecated in use.** A deprecated library skill, a workflow made from a deprecated agent, and an open Story
  using a deprecated skill are each flagged on the catalog, both pages, `check` and the plan or start line. Nothing is
  removed or blocked.
- **A10, usage.**
  - A fixture repository with three landed and two open Stories gives exact counts for each item and version: Stories,
    steps, intents, findings, times sent back, overrides and credits, with their coverage.
  - The same records give the same answer.
  - A fetch stub sees no call.
  - Nothing is written outside the Git folder.
- **A11, the export.** It validates against its schema. A grep finds none of the fixture's work IDs, branch names,
  paths, person names or finding words in it.
- **A12, feedback.** The document from a Story step names the item, version, owner and the step's outcome counts. Its
  issue link goes to `owner.issues`. It holds no Story ID, repository or path until the person adds them. Nothing is
  posted.
- **A13, the maintainers' check.** `marketplace check-repository` finds nothing wrong with the clean fixture, and
  reports each seeded defect with its fix.
- **A14, real VS Code.** In an isolated profile (the GUI rule), the Marketplace page shows the owner, the lifecycle with
  who and when, the channel, the deprecated-in-use badge, **Used here** and **Feedback to …**. Opening the issue opens
  the browser with the title in place.
- **A15, real Copilot.** One real Copilot CLI turn of `/sf-marketplace` shows the owner, lifecycle and channel columns,
  then a usage table.

## 14. Milestones

| Milestone | Scope | Size |
|---|---|---|
| M0 | The probes (§15). P2 and P4 need a person on the office marketplace host. | 1 day |
| M1 | The metadata read and shown (§4, §5): `marketplace-lifecycle.mjs`, `codeowners.mjs`, the owner, the record and its fallbacks, its findings, the v3 listings; the catalog, both pages, Studio, the conversion review, `/sf-marketplace`, the task offers; the fixture's additions; the maintainer topic (§11) | about 3 days |
| M2 | The safety review (§7): `import-safety.mjs`; the preview, update and conversion review rows; `--looked` and its record; the sweep of installed text; offers withheld | about 2.5 days |
| M3 | Deprecated and retired in use (§8): detection, every surface, `check`, the plan and start lines, replacements | about 1.5 days |
| M4 | Channels (§6): `--channel`, the order and rewind checks with a bounded history read, the move review, **Move and update**, the beta yes, index channels, the Studio Trust form | about 3 days |
| M5 | Usage and outcomes (§9): the Story record reader for both layouts, the per-item report, `marketplace usage`, the page sections, Copilot, the export and its schema | about 4 days |
| M6 | Feedback (§10): the evidence document, the issue address, the Story Analytics and page buttons, `marketplace feedback`, Copilot | about 1.5 days |
| M7 | `marketplace check-repository`; the journeys and the Story fuzzer with a channel move between two actions; the real VS Code and Copilot checks (A14, A15) | about 2 days |

That is about 18.5 days, roughly four weeks. M1 comes first, because every later milestone reads its vocabulary. M2
lands before M4, so that a move review can show safety results. M5 needs nothing from M4. M6 uses M5's outcomes.

Each milestone lands on its own with its targeted tests. Touched-area runs include the tests that read source. The full
suite runs once, at the end. Skill edits run `npm run skills-html:generate`, and `sflow-marketplace` stays within its
skill-body budget (risk R6).

## 15. Probes before building (M0)

1. **P1, APM 0.35.** `apm pack` runs on the sample marketplace with `owner:`, `lifecycle.yml` and the channels in
   place. It warns and does not fail. `lifecycle.yml` either stays out of what it writes for each agent host, or
   is harmless there.
   **Result, 2026-11-26 (APM 0.35.0).** APM refuses `marketplace.channels`: `apm pack --offline` stops with "Unknown
   key(s) in marketplace: channels", so the channels moved to `channels.yml` beside the root `apm.yml` (§4.3). With
   `owner:` blocks, `lifecycle.yml` files and `channels.yml` in place, `apm pack --offline` passes with only its warning
   about a missing `license:`; it writes `.github/plugin/marketplace.json` for Copilot, and neither `lifecycle.yml` nor
   `channels.yml` appears in it.
2. **P2, the office host (needs a person).** Which host serves the office marketplace: GitHub Enterprise, GitLab or
   Azure DevOps. Whether it reads `CODEOWNERS`, and from where. Whether code-owner review can be required. Whether the
   maintainers can create protected channel branches.
3. **P3, channel reads from the office network.** How long an `ls-remote` of both channel refs takes. How long, and how
   large, a fetch of beta's history (`--depth=1000`) is in the isolated object repository, which today fetches with
   `--depth=1`. Whether `merge-base --is-ancestor` works there. A failure changes REQ-022's bound or approach before M4.
4. **P4, prefilled issues (needs a person).** The new-issue address on the office host. GitHub takes
   `issues/new?title=&body=&labels=`. GitLab's form reads `issue[title]` and `issue[description]`. MCR's
   `feedbackIssue` sends `title` and `body` to both today, so GitLab may drop them. Check it, and fix it in M6. Azure
   DevOps has no prefill, so it gets copy-then-open.
5. **P5, the speed of the usage read.** On a real repository with many landed Stories, a cold read of 500 Stories takes
   under 2 seconds, and a warm read with the kept results under 300 ms. Measure it, and set the bound in REQ-050 from
   the result.
6. **P6, credits coverage.** On the owner's machine, the share of the steps of landed Stories that have credits
   recorded here. The words of REQ-053 must match it.
7. **P7, false positives.** Run §7's checks locally over the sample marketplace and over the office marketplace's
   skills and agents, with nothing uploaded. The result must be no block, and few enough looks that each one is
   justified. Tune the rules before M2 lands.
8. **P8, older builds.** The released SFlow build before OMK reads the new fixture and a channel trust with no change in
   behaviour.

A probe that fails changes this spec before the milestone that depends on it.

## 16. Risks

- **R1, who and when are what the marketplace writes.** SFlow checks that the record holds together and that code owners
  are declared for it. It cannot see the host's approval itself. The guard words (REQ-014) and the maintainer guide
  reduce this risk. A later version could check signed commits or tags on the record's change.
- **R2, step credits can be misread as an item's cost.** A step that used several items counts its credits for each of
  them. The words (REQ-053) and `attribution: "step"` say so. Totals are counted once.
- **R3, local means partial.** The report covers Stories landed here and Stories open on this machine, and credits from
  this computer only. Every figure states its coverage. A governance plane can later join several repositories'
  exports.
- **R4, the safety checks are rules, not a review.** They miss clever text and may flag legitimate text. P7 tunes them.
  Unclear patterns are a look, not a block. The words never claim more than the checks do (REQ-033).
- **R5, reading a channel's history costs time and data.** A beta far ahead of stable needs a deeper read. The bound and
  its yes (REQ-022) keep the result deterministic. P3 measures the cost.
- **R6, the skill-body budget.** `sflow-marketplace` has the default limit of 800 tokens for its own text, and it gains
  usage and feedback routes. Keep the additions to one step each, or record a reviewed `maximumTokenOverride` with its
  reason in `plugin/skills/registry.yml`.
- **R7, the VS Code bundle ceilings.** The new page sections add to the panels bundle. Measure it at M1 and M5, and
  review any ceiling change as the bundle-budget documents require.
- **R8, older builds.** By design, no key is added to `workflow.yml` and nothing is added to the snapshot (REQ-006,
  REQ-051). The optional fields in import records are checked through the bundle reader and the transfer review at M1.
- **R9, privacy.** Feedback and the export must not carry Story or repository data. The tests in A11 and A12 grep for
  the fixture's identifiers. The export is a local file the person chooses to write.
- **R10, people never see hashes.** The pages and Copilot show versions and dates (the `person-text` rule and its test).
  The export is machine-readable and is never shown on a page.
- **R11, SSB.** The usage reader reads today's layout until SSB lands, then reads through SSB's resolver (REQ-050). It
  must not add a second resolver of its own.

## 17. Open questions for the owner

1. **An approval with no code owners.** Should an item count as approved when the marketplace does not guard its
   lifecycle record with code owners? **Default:** yes, as today, labelled "not guarded by code owners" everywhere
   (REQ-014). **Alternative:** treat it as proposed, so that it needs a yes, until the marketplace guards its records.
2. **Story details in feedback.** Should feedback to the organisation's own marketplace include the Story ID and the
   repository name by default? **Default:** no, which is MCR's rule. The person can add them in the preview.
   **Alternative:** include both by default for a marketplace the repository trusts, and never include paths, code or
   names.
3. **Stopping new Stories.** Should a new Story stop when it would use a retired item, or an installed text with a
   block-level safety finding? **Default:** no. It is flagged everywhere and never offered, and running Stories are
   untouched (REQ-032, REQ-041). **Alternative:** a new Story refuses to start until the team updates the workflow or a
   person says yes.
