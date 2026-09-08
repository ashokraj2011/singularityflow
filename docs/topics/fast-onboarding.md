---
id: fast-onboarding
title: Fast onboarding and safe Git acceleration
aliases:
  - onboard-existing-repository
  - authority-pin
  - git-speed
  - derived-cache
commands:
  - onboard
  - authority
  - cache
  - doctor
related:
  - getting-started
  - starting-work
version: 3
---
Fast onboarding attaches an existing Git checkout to one exact reviewed configuration authority.
It performs no clone, source scan, AST or World-Model build, model call, application checkout, or
application-branch commit. The verified authority pin is machine-local and Story start reuses it.

## Purpose and prerequisites

Use this topic for an existing checkout. Ordinarily the repository already advertises reviewed
`sflow/config` or a verified `state` projection. An explicitly unmanaged repository can instead
use the package-approved local-only bootstrap preset. With multiple remotes, choose one explicitly;
`origin` is never assumed to be more authoritative. Credential-bearing and external-helper
remote forms are refused before persistence or network access.

## Use it from each surface

- **Shell:** `singularity-flow onboard <LOCAL-PATH> [--remote <NAME> | --authority-local]`.
  Advance an existing pin only with `singularity-flow authority refresh <LOCAL-PATH>`.
  Add `--no-cache` only when comparing the reference read path; it changes no policy or receipt.
  Use `--offline` only for an already attached pin whose retained approved `singularity/fos.yml`
  policy permits bounded offline onboarding. For a new unmanaged local repository use
  `--bootstrap --policy unmanaged-local-v1 --authority-local`. Remote bootstrap additionally needs
  `--publish` and an installed trusted organizational policy/kernel provider.
- **Copilot:** ask `/sf-init` to attach the current existing checkout and require it to show the
  exact repository and authority route before running the command.
- **VS Code:** use **Fast Onboard Existing Repository**, **Refresh Repository Authority Pin**,
  **Create Local-Only Configuration Authority**, **Use Approved Offline Authority Pin**,
  **Inspect or Enable Safe Git Acceleration**, or **Clear Disposable Derived Cache**.

## Guided workflow

1. Open the existing checkout; do not clone it again.
2. Run `singularity-flow onboard <LOCAL-PATH>`. Name `--remote <NAME>` when more than one
   configured remote exists, or use `--authority-local` only for a deliberately local authority.
3. Review the returned full authority commit, fold digest, pin, and receipt status.
4. Start or resume normal governed work. Onboarding never launches AST, a World Model, or a model.
5. When reviewed configuration moves, run `singularity-flow authority refresh <LOCAL-PATH>`;
   ordinary repeated onboarding intentionally keeps the previous exact pin.
6. Use `--no-cache` only for diagnosis or semantic comparison. It does not clear durable caches.

Offline results say `pinned-offline`, show their age and expiry, and never claim to be current or
latest. Missing retained bytes, expiry, revocation, an incompatible policy, or a required-live rule
refuses without contacting a remote or creating authority.

## State and safety

Repeated onboarding returns `already-attached` without silently advancing authority. A different
route is a rebind and needs normal reviewed authority configuration. Derived caches are
non-authoritative; clearing them preserves pins, journals, receipts, evidence, Story state, and
recovery checkpoints. Git speed changes are repository-local, explicit, verified, and receipted.

## Troubleshooting

- Multiple remotes: re-run with `--remote <NAME>`.
- Authority moved: use `singularity-flow authority refresh <LOCAL-PATH>`.
- Auth, SSO, TLS, proxy, or network refusal: repair approved Git access and retry; never put a
  credential in the URL or weaken TLS.
- Invalid pin: run `singularity-flow doctor --json`; do not edit attachment records by hand.
- Optional cache unavailable: continue uncached and repair disk or permissions separately.

## Related topics

Continue with `sflow explain getting-started` or `sflow explain starting-work`. The full operator
guide is `docs/FAST-ONBOARDING-AND-GIT-PERFORMANCE.md` in the product repository.
