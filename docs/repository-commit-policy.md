# Repository commit policy

RCP is the Repository Commit Policy namespace, version 1. It connects a repository's approved commit rules to SFlow's existing writers. It does not add another publication owner or human approval store.

Use Configuration Center → Commit policy to inspect effective hooks, edit the JSON policy, and **Validate and propose policy**. Saving uses the existing configuration proposal and review; discovery never activates a suggested policy. Review the exact hook implementations, dependency inputs and equivalence differences before adoption.

- Copilot: `/sf-git-policy show`
- Shell: `singularity-flow git-policy show --json`
- VS Code (model-free): `@sflow /git-policy`

`git-policy discover` reads inherited Git configuration, the effective `core.hooksPath`, hook hashes and known setup files. It does not read commit history, execute hooks, evaluate JavaScript configuration or install tools. Checked-in Husky/pre-commit files do not prove that the hooks were installed on this laptop.

## Modes and configuration authority

The opt-in is `git.commitPolicy` in approved `singularity/workflow.yml`.

| Mode | Behavior |
| --- | --- |
| `off` | Existing compatibility behavior, without a claim of policy validation |
| `discover` | Read-only discovery, without automatic enforcement or adoption |
| `enforce` | An exact owner-issued plan, approved coverage and actual-object verification are required |

A branch-local edit cannot adopt its own policy. Configuration projections retain their original repository's approved authority. A stricter current policy applies to a retained push without automatically amending its existing object.

The template supports `{trackingKey}`, `{summary}`, `{type}`, `{scope}` and `{phase}`. Required values are typed, single-line, bounded UTF-8 text. The original body and SFlow transaction trailers are preserved and validated. Defaults and type/scope allowlists must come from the repository's approved configuration.

An example **message-only equivalent profile** follows. It is suitable only when its complete obligations are actually approved. It is not an automatic equivalent for an arbitrary pre-commit or pre-push hook.

```yaml
git:
  commitPolicy:
    schemaVersion: 1
    mode: enforce
    subjectTemplate: '{trackingKey}: {summary}'
    subjectPattern: '^[A-Z]{2,8}-[0-9]{1,8}: .+$'
    maxSubjectBytes: 120
    tracking:
      required: true
      allowedKinds: [story]
      keyPattern: '^[A-Z]{2,8}-[0-9]{1,8}$'
      bindings:
        story: repository-story
    validation:
      adapter: registered-checks
      profile: message-v1
    profiles:
      message-v1:
        schemaVersion: 1
        adapter: registered-checks
        platforms: [darwin, win32, linux]
        checks:
          - id: message
            rule: message-envelope
        coverage:
          - stage: repository-message
            checks: [message]
```

Patterns use a bounded full-string matcher. Literals, character classes and repetitions are supported. Groups, alternation, lookarounds and backreferences are rejected; there is no backtracking regex execution on untrusted messages.

## Canonical work identity

A Story key comes from its canonical workflow state. Jira-backed Stories need the retained immutable issue identity and current key. Local IDs must satisfy the destination grammar. Branch text alone, a temporary plan ID, an Epic's parent key, or a plausible-looking ticket in unrelated text cannot substitute for that association.

Epic planning, standalone runs, configuration changes and the state ledger may need an explicit real planning/maintenance reference. Configure it once under `tracking.references`, with its exact repository fingerprint and owner subject ID, and select the purpose binding. SFlow does not create a hidden Story or fake ticket to satisfy a hook. Noncommitting analysis remains possible.

The ledger subject is `{kind: ledger, id: <ledger.branch>}`; the standing configuration subject is `{kind: configuration, id: repository-configuration}`. Each destination resolves its own policy and reference. One repository's approval of a reference grants no authority in another.

Metadata defaults to the ordinary policy. An explicit `metadata.mode: scoped-profile` names a profile and exact `refs`, `paths` and `purposes`. A source file outside those prefixes invalidates that profile. `metadata.requireBranchAgreement: false` is an explicit reviewed branch-name exception for those exact metadata scopes; it does not remove the real-key, full-message, signature or organization-floor obligations. Server and CI rules still apply.

## Adapters and capability boundaries

| Path | Contract |
| --- | --- |
| Registered equivalent | Exact staged-tree blobs and the complete proposed message; labels native hooks **not executed** |
| Native Git | Original working directory and branch semantics, with an explicitly compatible private Git directory; real Git runs the adopted hooks before the owner's authoritative ref moves |
| Native merge-message semantics | Unsupported; no alternate strategy is selected |
| Native pre-push tracing | Unsupported by the commit adapter; requires a reviewed registered publication equivalent or separately qualified adapter |
| Git-directory-sensitive hooks or native execution from a configuration projection | Unsupported unless a faithful contract is separately qualified; use an approved metadata equivalent where appropriate |
| Unknown hook bytes, undeclared dependency inputs, missing tools or unsupported OS | Setup/unavailable/unsupported, never a guessed replacement or passing check |
| Legacy writer without a qualified owner bridge | Admission refused before an authoritative write; universal compatibility is not claimed |

Registered content rules are `no-trailing-whitespace`, `final-newline` and `valid-utf8`. Registered authoring normalizers are `trim-trailing-whitespace` and `ensure-final-newline`. They require the existing author's exact path authorization before source freeze. They protect hooks, policy and dependency inputs, preserve unrelated staging, and consume a durable finite changed-attempt budget (default two). Unchanged failures do not cause automatic retries. A crash journal can be reconciled from exact before/after observations without rewriting user files.

A native profile declares `context: original-worktree-private-git`, `gitDirectory: candidate-compatible`, supported platforms, exact hook coverage, dependency hashes and execution/effects budgets. It does not claim operating-system or network containment. If the required effect observation exceeds its bounded file/byte scope or cannot be established, validation is unproven. Repository and Git-control changes outside the admitted scope are retained and reported.

Native profiles may declare a message transformation with the actual producing hook, subject/body suffix placement, exact delimiter/prefix, Unix-seconds encoding and clock tolerance. The actual hook generates the timestamp. SFlow compares the before/after messages and final object; it never simulates that timestamp or claims a prior linter checked a later transformation. A post-commit notification failure is distinct from object-creation failure.

Policy schema validation uses trusted packaged code only when the policy is present. Use the managed SFlow runtime, or Node 22.12 or later for synchronous ESM policy validation. Discovery is not execution of repository JavaScript.

## Transactions, retries and takeover

The existing publication unit of work retains its subject lock, journal, rollback/preimage rules, parent expectations, ref compare-and-swap, remote leases and pending-push recovery. RCP checks the actual tree, parents, identity, full message and required signature before admitting its object. It rechecks relevant policy, hooks, inputs, tracking and ref bindings before the owner's CAS.

Plans and execution grants are not interchangeable. `git-policy plan|validate --operation sha256:<OWNER-ISSUED-ID>` accepts only an existing host-bound operation; a model-authored JSON document cannot authorize execution. `validate` performs registered checks only. Native object production remains inside the commit owner. Neither command commits, pushes, activates a policy or approves work.

A known retained object is reused, including its timestamp and signature. An uncertain object-production outcome requires owner reconciliation and cannot blindly rerun hooks. Push failure does not produce another lifecycle event or authorize an amendment/history rewrite. The outgoing contract can require the newest object or all bounded new commits. Missing/shallow history is unproven; an earlier invalid or unbound outgoing object cannot hide behind a valid newest subject.

Private records live under the existing Git-common sidecar in `singularity-flow/repository-commit-policy`. They are content-addressed, versioned, bounded, and outside the candidate they validate. Mutable operation journals use the existing machine-integrity primitive. They keep object-created, object-verified, ref-advanced and remote outcomes separate and do not contain environment secrets or replayable cross-host grants.

When the existing ledger records a source publication, portable facts are projected to `evidence/repository-commit-policy/<commit>.json` on the state branch. The source candidate never includes its own receipt. A second machine checks the exact state-provider fact against the actual object and rebinds current local policy, hooks, declared dependencies and host capabilities. Portable facts are evidence, not execution permission or approval. A missing fact or incompatible new native binding requires a reviewed remedy; the message hook is not rerun against a retained object. The ledger's own receipt is not recursively inserted into its own commit.

RCP never records an application's human **All good** or triggers its final screenshots. Actual formatting changes require a new candidate and affected checks/application review. A message-only timestamp does not change product bytes; existing commit-bound witness rules still apply.

## Writer coverage

- Story, Initiative and run lifecycle writes use the shared publication object/ref bridge, regardless of standard or custom phase names.
- Reviewed authoring and the normal configuration proposal/membership bridges validate before advancing their owner ref.
- Ledger object writes use their destination's approved metadata/ordinary policy. Detached state projections advance only their private HEAD before the existing state owner publishes them.
- Incoming state convenience refs mirror exact reconciled remote objects; they do not mint a policy receipt or lifecycle approval.
- The central Git boundary fences other commit/ref writers. The asynchronous push boundary revalidates retained exact objects and leases. Unsupported legacy/direct writer forms remain refused rather than gaining an exemption.
- Discovery and non-enforced repositories preserve compatibility behavior. Unsupported or uncovered paths do not establish universal compliance.

The Git bypass audit records the new bounded call sites. No new general process/publication owner, hook-disable escape hatch, approval database, branch/history scan or automatic storage migration is added.

## Qualification scope

The `test/repository-commit-policy-*.test.mjs` suite exercises full-message rendering, canonical Jira identity, approved policy drift, exact-tree checks, finite formatter budgets, actual native hooks, hook-created files and index drift, SSH signatures, retained-object retries, metadata restrictions, and state-provider takeover from a second clone. Standard and custom phase owners use the same publication bridge. `test/cli-bundle.test.mjs` also executes an enforced commit through the compiled writer and its optional source service, checking that they share one admission boundary.

Native merge messages, native pre-push tracing, and Git-directory-sensitive/projection hook contexts remain explicitly unsupported. The feature does not qualify arbitrary hook frameworks or every legacy writer by implication. An unsupported path requires an approved compatible profile or a qualified owner bridge; it cannot fall back or report universal compliance.
