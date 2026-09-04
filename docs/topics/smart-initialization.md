---
id: smart-initialization
title: Smart repository initialization
aliases:
  - smart-init
  - zero-config-init
  - automatic-initialization
commands:
  - init
  - precheck
  - configuration
related:
  - workspaces-and-sessions
  - capability-management
  - recovery
version: 1
---
Smart initialization turns a fresh local Git repository into an explicitly accepted Singularity
Flow repository without asking people to hand-author commands or capability maps. It is a bounded,
deterministic inspection—not a model prompt, package installation, test run, build, or network
probe.

## Purpose and prerequisites

Use `sflow init --smart-detect` only when the repository has no approved Singularity Flow
configuration in its checkout, configuration branch, state branch, or corresponding locally cached
remote-tracking ref. Existing authority wins and must be changed through configuration review.

The detector reads Git and a closed set of ecosystem manifests under explicit file, byte, module,
command, and suggestion limits. Sensitive-looking files contribute path facts only; their contents
are never read into a proposal. Every command candidate cites the source path, content digest,
locator, detector version, and detector implementation digest that produced it.

## Use it from each surface

- **Shell:** run `sflow init --smart-detect --dry-run --json`, then activate one reviewed digest.
- **Copilot:** use `/sf-init` and explicitly request smart initialization; the skill must show the
  proposal and may not execute detected repository commands.
- **VS Code:** run **Singularity Flow: Smart Initialize This Repository**. The form previews the
  same engine proposal, optional protections, proof gap, and final exact-digest confirmation.

## Guided workflow

Start with the effect-free proposal:

```text
sflow init --smart-detect --dry-run --json
```

The result discloses detected stacks, selected and discarded commands, proof readiness, the implicit
`repository-root` capability, optional unchecked protection suggestions, built-in invariants, every
target byte, and one proposal SHA-256. The same input identity produces the same proposal bytes.

For a reviewed file journey, write the proposal inside the repository and later accept it:

```text
sflow init --smart-detect --activation proposal-only --output init-proposal.json
sflow init --smart-detect --accept-proposal init-proposal.json --confirm sha256:<PROPOSAL>
```

Acceptance regenerates the proposal from current repository bytes. A changed manifest, ref, base
commit, detector, preset, renderer, or target invalidates the old digest. `--yes` is only a shortcut
for visible, unambiguous defaults; it never selects optional protections or accepts unavailable
verification. Use `--allow-unavailable-verification` only after reviewing the disclosed proof gap.

Local activation writes and commits only the declared SFlow paths plus its activation receipt. It
does not stage unrelated application changes. `review-proposal` and `proposal-only` produce a
candidate file and never make it active repository law. `--dry-run` is strictly effect-free and
therefore refuses `--output`.

### Verify and explain

After activation, inspect readiness without executing repository code:

```text
sflow precheck --quick
sflow config explain --pointer /commands/verification/0
```

Quick precheck verifies receipt and configuration hashes, origin records, the implicit capability,
wrapper or PATH metadata, and proof readiness. Configuration explanation reports what an installed
field means, why it exists, which source and accepted proposal established it, how it affects later
work, and the safe change path.

## State and safety

Dry-run does not write files, Git state, logs, or receipts. Activation is subject-locked and
revalidates its exact ref, commit, manifests, and absent targets immediately before writing. A known
pre-commit failure removes only paths declared by that activation and retains a Git-private journal.
After a hard interruption, another proposal is refused until the exact transaction is reconciled:

```text
sflow init --recover --proposal sha256:<PROPOSAL>
```

Recovery verifies the journal, branch, base commit, declared paths, and byte hashes. It either proves
the proposal-bound activation commit complete or removes only unchanged files that this fresh
activation created. Advanced history or user-edited target bytes are preserved for human review.
If the repository is already governed, use `sflow configuration`, `sflow doctor`, or the approved
configuration refresh journey instead of smart initialization.

## Troubleshooting

- `INI_ALREADY_GOVERNED` means an approved working-tree, configuration, or state authority already
  exists. Change that authority through its normal review flow; smart init changes nothing.
- `INI_DETECTION_AMBIGUOUS` means two incompatible candidates have equal authority, such as two
  package-manager lockfile families. Correct or explicitly narrow the manifest evidence and preview
  again.
- `INI_VERIFICATION_UNAVAILABLE` is an honest proof gap, not a failed test. Either configure a
  structured verifier or explicitly accept the disclosed later admission blocker.
- `INI_PROPOSAL_STALE` means the ref, source manifest, renderer, preset, or target bytes changed.
  Generate and review a new proposal rather than reusing the old digest.
- `INI_RECOVERY_REQUIRED` means a journal must be reconciled with the exact recovery command shown
  by the CLI. Never delete the journal or the listed files manually.

## Related topics

Continue with `sflow explain workspaces-and-sessions`, `sflow explain capability-management`, or
`sflow explain recovery`.
