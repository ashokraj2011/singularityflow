# Golden developer journey

Singularity Flow's front door is **My Work** in VS Code, `sflow home` in a shell, and `/sf-home` in
Copilot. All three read the same durable Git records and route ordinary developer intent through the
same gateway operations. They do not share chat memory or an in-memory lifecycle store.

## Available journeys

The current deterministic routes cover:

- orienting to current work;
- continuing governed work;
- opening manual, Jira-backed, or GitHub Issue intake;
- bounded repository exploration;
- deterministic bug triage; and
- quick change-impact analysis.

Typed Home requests and Home buttons use the same VS Code destination resolver. Reads may run
immediately. Starting work, changing a branch, publishing, submitting, or deciding an approval still
uses the existing preview and confirmation boundary.

GitHub Issue intake accepts an issue URL or `owner/repository#number`, normalizes it to the same
source contract as Jira and manual work, and keeps repository-plus-issue-number as its stable
identity. Repeating the same source attaches to the existing governed Story instead of minting a
duplicate.

## Bounded exploration and investigation

Repository exploration returns structural counts, manifests, entry points, declared commands, test
paths, and bounded dependency/churn facts. Bug investigation returns bounded text-match locations,
dirty paths, recent commits, and an optional deterministic regression range. Neither operation
returns source bodies, host paths, or a causal verdict. Assisted investigation falls back to these
same observations and labels model assistance unavailable when the host did not invoke one.

## Readiness

`work.readiness` joins lifecycle blockers with nine deterministic authorities at one repository
revision:

- published artifact byte freshness;
- configured and recorded quality checks;
- stale approval detection;
- clarification/grounding record integrity;
- specification claims for changed paths;
- reconciliation and unplanned changes;
- AST predicates when enabled;
- visual assurance when required; and
- external build status when configured.

Every row is `met`, `unmet`, or `unknown`. An unavailable authority remains unknown and blocks a
ready verdict; it is never converted to a passing zero. Fixable rows route through existing governed
continuations. A decision only an authorized reviewer can make is shown as a wait, not a developer
task.

## Submission receipt

After a successful phase submission, the CLI prints a compact evidence receipt and includes the
same `evidenceReceipt` object in its structured command result. It reports the exact source commit,
change count, requirement claims, checks, approvals, context provenance, review-packet hash,
publication state, and next human action. `exact`, `partial`, and `unavailable` labels are preserved.

The receipt is a deterministic projection over the existing review packet and Story records. It is
not another evidence store and does not alter evidence hashes. Its immutable core covers durable
packet and lifecycle identity and therefore reproduces the same core hash in another clone. Live
observations, including publication visibility and local changes, are reported and hashed
separately so clone-local state cannot silently change the durable receipt identity.

## Return on another machine

New Stories carry a hash-checked `context/return-locator.json`. The locator names the Work ID,
capability, repository identity, lifecycle/work refs, pinned configuration, and clone strategy. It
contains no credentials or absolute filesystem path. Portable HTTPS and SSH remotes are retained
after credentials and URL parameters are removed; machine-local remotes are represented only by a
fingerprint and are marked non-portable.

`sflow return <WORK-ID>` fetches and verifies the locator, then shows a read-only plan including
required repositories, local branch disposition, dirty paths, remote freshness, and the exact attach
action. `sflow return <WORK-ID> --apply --confirm <WORK-ID>` creates or fast-forwards only the local
Story branch and attaches its governed agent. The VS Code command **Return to Work on This Machine**
shows the same preview and exact confirmation. Dirty, ahead, or divergent local work blocks apply
before checkout; no reset, stash, clean, or forced checkout is used.

## Safety rules

- Intent never authorizes a mutation.
- Missing evidence never passes a gate.
- Repository reads remain bounded and contain no source bodies.
- Return data contains no credentials, prompt text, chat content, or machine paths.
- Dirty/divergent work and existing publication recovery remain preserved by the lifecycle kernel.

## Troubleshooting

- If readiness shows unknown evidence, open its named authority and repair the underlying record;
  do not treat the row as passed.
- If a Story locator says `machine-local`, configure a portable remote before expecting a second
  machine to discover it.
- If investigation finds matches but no reproducer, treat them as suspects rather than causes.
- If Home cannot resolve a destination, run `sflow home` or `/sf-home` again after refreshing the
  active workspace; no mutation was performed by the failed read.
