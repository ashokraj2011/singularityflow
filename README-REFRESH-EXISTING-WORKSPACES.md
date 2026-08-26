# Refresh configuration in existing workspaces

Use this guide after upgrading Singularity Flow when a workspace or repository was created by an
older build. The refresh installs compatible packaged workflow changes, templates, prompts, agents,
and model-routing policy without editing application branches or rebuilding existing Stories.

## What refresh changes

For every selected repository, refresh works in an isolated temporary clone and updates two remote
authorities:

1. `sflow/config` receives the reviewed, merged configuration.
2. The configured orphan state branch (normally `state`) receives an exact mirror at the canonical
   `.github/agents/**` and `singularity/**` paths, plus `configuration/manifest.json` containing the
   configuration commit, product revision, and file hashes.

The state-branch refresh preserves runtime state such as `singularity/world-model/**`. Existing
Story and Initiative snapshots remain unchanged; newly started work uses the refreshed authority.
Dirty application checkouts, application branches, indexes, and active Story worktrees are not
switched, stashed, reset, or edited.

## Before starting

- Install the new Singularity Flow build.
- Ensure the workspace is registered: `singularity-flow workspace list`.
- Ensure Git can read and push the repository's `sflow/config` and state branches.
- Know the repository ID shown by `singularity-flow workspace current --json` or the Workspaces UI.

A clean application checkout is not required because refresh uses isolated clones. The remote
configuration itself must be valid enough to load and merge.

## Recommended VS Code flow

1. Open the Command Palette and run **Singularity Flow: Upgrade Capabilities & Workspaces**. This
   opens Workspaces and immediately checks every registered workspace. You can instead open
   **Workspaces** and select **Upgrade capabilities & workspaces** for a narrower review.
2. Choose **Review _workspace_** to inspect one workspace, or **Review all workspaces**.
3. Review every repository, file change, state-branch change, and conflict.
4. For each conflict choose:
   - **Keep repository** (`local`) to retain the existing value or file.
   - **Use packaged** (`bundled`) to replace it with the installed build's value or file.
   - **Merge lists** (`merge`) only when the UI offers it for compatible string lists.
5. If the preview reports that a phase has no default governed agent, choose **Repair missing or
   outdated agents**. This selects only the packaged agent paths reported by the engine and runs a
   new preview; it does not publish anything.
6. Apply the displayed plan. VS Code passes the same choices and plan ID back to the CLI.
7. Check again. A complete refresh should become `current`.

The broad **Use packaged templates, prompts and agents** convenience applies only to those asset
classes. It does not silently replace unrelated workflow policy.

## Recommended CLI flow

First verify the active boundary:

```bash
singularity-flow workspace current --json
```

Preview one repository:

```bash
singularity-flow workspace refresh-configuration \
  --repository singularity-platform \
  --dry-run \
  --json
```

The preview does not push anything. It returns a `planId` such as:

```text
cfgp-13b7dac8eb8e41cb066d0164
```

This is a SHA-256-derived plan fingerprint, not a credential or Work ID. It binds the repository
remotes, current `sflow/config` commits, state-branch commits, installed product revision, and exact
conflict choices. Apply recalculates the fingerprint before its first mutation. If an authority
moved after preview, the command returns `stale-plan` and requires another preview.

Apply the exact reviewed preview:

```bash
singularity-flow workspace refresh-configuration \
  --repository singularity-platform \
  --confirm-plan cfgp-13b7dac8eb8e41cb066d0164
```

If the preview used conflict resolutions, repeat the identical choices during apply because they
are part of the plan identity:

```bash
singularity-flow workspace refresh-configuration \
  --repository singularity-platform \
  --resolve singularity/templates/common/implementation.md=bundled \
  --resolve workflow.ledger.enabled=local \
  --confirm-plan <PLAN-ID>
```

Never reuse the example plan ID above. Generate a plan for the current repository state and copy
the ID from that output.

### Select the refresh scope

Refresh every unique repository in every registered, non-archived workspace:

```bash
singularity-flow workspace refresh-configuration --dry-run --json
```

Refresh one registered workspace by ID, name, Jira anchor, or directory:

```bash
singularity-flow workspace refresh-configuration payments --dry-run --json
```

Limit either form to one or more repository IDs:

```bash
singularity-flow workspace refresh-configuration payments \
  --repository payments-api \
  --repository payment-events \
  --dry-run \
  --json
```

## Conflict policy

Repository customizations are preserved by default. A conflict is reported when both the packaged
configuration and repository-owned configuration changed relative to the recorded package
baseline, or when an older repository has no baseline proving ownership.

Use `bundled` only after reviewing the local and packaged values. `merge` is valid only for
compatible string lists. `--accept-bundled-conflicts` selects packaged values broadly and should be
reserved for a deliberate reset to packaged policy; it is not the normal upgrade command.

Exact byte-for-byte model-routing maps shipped by older SFlow releases are recognized as packaged
assets rather than user customizations. Current builds safely migrate those known maps to provider
`auto`. Even a one-byte change prevents automatic replacement and keeps the file as a visible local
choice.

## World-model routing upgrades

Older repositories may contain model tiers that pin retired models such as `gpt-4o` and
`gpt-4o-mini`. A current packaged refresh changes only a recognized historical bundled map to:

```yaml
modelTiers:
  relay:
    model: auto
  reason:
    model: auto
    params:
      effort: high
  clarify: relay
  summarize: relay
  code: reason
  analyze: reason
```

After refresh, rerun the same world-model command with resume enabled:

```bash
singularity-flow wm build \
  --depth deep \
  --views all \
  --parallel \
  --workers 4 \
  --resume
```

When the only checkpoint change is the recognized bundled routing migration, completed discovery
packets are validated and reused. Synthesis runs with Copilot provider-auto selection instead of
regenerating the completed views. User-authored routing changes remain strict checkpoint boundaries.

## Protected configuration branches

If a direct push to `sflow/config` is rejected, refresh retains the exact candidate on a branch
named like:

```text
sflow/config-refresh/<product>-<source>-<candidate>
```

Review and merge that branch into `sflow/config` using the repository's normal controls, then rerun
the same refresh. The rerun is idempotent: completed repositories become no-ops, unfinished
configuration or state publication resumes, and the state mirror is verified.

## Verify the result

Run another preview:

```bash
singularity-flow workspace refresh-configuration \
  --repository singularity-platform \
  --dry-run \
  --json
```

Expected repository status is `current`, with both `configurationChanged` and `stateChanged` false.
For world-model routing, also check:

```bash
singularity-flow wm status --json
singularity-flow wm check
```

## Common refusals and recovery

| Result | Meaning | Recovery |
|---|---|---|
| `stale-plan` | Configuration, state, product revision, or choices changed after preview. | Preview again and use the new plan ID. |
| `preserved-local` | The repository file/value cannot be proven package-owned. | Keep it or explicitly choose `local`, `bundled`, or offered `merge`. |
| `CONFIGURATION_REFRESH_INVALID` | Preserved files and the refreshed workflow do not form a valid executable contract. | In VS Code choose **Repair missing or outdated agents**, review the selected packaged files, and preview again. The CLI equivalent is `--resolve .github/agents/<name>.agent.md=bundled`. |
| `review-required` | Branch protection rejected direct `sflow/config` publication. | Review and merge the reported `sflow/config-refresh/*` branch, then rerun. |
| `partial` | At least one repository or state projection did not publish. | Correct the named repository failure and rerun; completed repositories are no-ops. |
| Remote read failure | Git cannot inspect the configuration authority. | Restore normal Git authentication, proxy, certificate, and repository access; do not disable TLS checks. |

## Installer behavior

A normal `./install.sh` runs this refresh across registered workspaces after installing product
surfaces. Use `--no-workspace-configuration-refresh` only when you intentionally want installation
to finish without touching remote configuration authorities. You can run the same preview/apply
flow later from VS Code or the CLI.

On Windows, use the same commands from Git Bash after installing through
`install-windows-git-bash.sh`.
