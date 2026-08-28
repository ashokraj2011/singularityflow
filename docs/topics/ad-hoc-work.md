---
id: ad-hoc-work
title: Ad hoc work and governed landing
aliases:
  - adhoc
  - ad-hoc
  - land-existing-work
commands:
  - adhoc
  - land
related:
  - starting-work
  - story-lifecycle
  - recovery
questions:
  - How do I work without creating a Story first?
  - How do I safely land code I already changed?
  - What is reverse-converged intent?
keywords:
  - baseline
  - disposition
  - landing packet
  - promotion
version: 1
---
Ad hoc mode lets work begin without a Story and later applies a small, exact safety envelope before publication. It does not fabricate a pre-work specification: confirmed intent is explicitly recorded as discovered at landing.

## Purpose and prerequisites

Use ad hoc mode for bounded work in one initialized Git repository. The thin pilot requires an unprotected branch, at most twenty changed resources by default, no protected-path contact, one allowlisted `spec.testCommands` entry, a configured Git identity, complete resource dispositions, and an exact human packet confirmation. Larger or uncertain work is preserved for promotion.

## Use it from each surface

**Shell:** Run `singularity-flow adhoc start` before editing, or `singularity-flow land` to observe work that already exists.

**Copilot:** Use `/sf-adhoc`. It relays deterministic CLI records, asks for missing human choices, and must not invent intent, claims, test selection, or packet confirmation.

**VS Code:** Use the integrated terminal with the same commands. Structured JSON output is available for host cards; direct publication remains behind the exact packet confirmation.

## Guided workflow

1. Start explicitly on a clean worktree, or run `land` and deliberately include existing effects.
2. Review the exact baseline, every changed resource, protected-path findings, and change-set SHA-256.
3. Confirm an objective and at least one observable success criterion. The record says `discovered-at-landing`.
4. Claim every resource against a confirmed criterion, or mark it for deviation, split, revert, or local-only handling. Anything not claimed blocks direct landing.
5. Run `adhoc landing preview`. SFlow executes one allowlisted deterministic test and returns either an eligible packet or explicit promotion reasons.
6. Publish only with the exact packet SHA-256. SFlow rechecks HEAD, effects, identity, and the required test, then uses the ordinary governed publication transaction.

## State and safety

Operational session records live under the repository Git common directory, so linked worktrees share the same session safely. Published authority records live under `singularity/adhoc-work/<WORK-ID>/`. Application paths and authority records are staged through an isolated temporary index; unrelated staged work is never borrowed. A staged application change, protected path, protected branch, unavailable test, or stale hash causes promotion or refusal while preserving source bytes.

The committed landing receipt binds through the lifecycle event and commit trailers because a file cannot contain the SHA of the commit that contains that same file. The machine-local receipt adds the resulting commit after publication.

## Troubleshooting

`ADH_DIRTY_START_CHOICE_REQUIRED` means existing work was found and needs explicit `--include-existing`; nothing was adopted. `ADH_CHANGE_UNCLAIMED` lists resources still needing a disposition. `ADH_PROMOTION_REQUIRED` preserves the branch and provides a workflow handoff. `ADH_PACKET_STALE` means HEAD or bytes changed after preview; create and review a replacement packet. Push failure retains the exact governed commit in the existing publication-recovery mechanism.

## Related topics

See `starting-work` for compiled Story entry, `story-lifecycle` for preplanned phase governance, and `recovery` for exact commit publication recovery.
