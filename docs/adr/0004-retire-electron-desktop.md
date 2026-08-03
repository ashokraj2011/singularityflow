# ADR 0004: Retire the Electron Desktop App

- Status: accepted
- Date: 2026-08-03
- Baseline: `main@ebcb37d`
- Decision owner: Ashok Raj

## Context

Singularity Flow had three user surfaces: the `sflow` CLI, the Electron desktop app
(Singularity Horizon), and the VS Code extension. Maintaining three frontends spread product
polish thin, duplicated read-model and credential paths, and introduced a separate Electron
build, signing, notarization, test, and distribution pipeline that is difficult to approve on
locked-down corporate machines.

The core CLI does not depend on Electron. The VS Code extension already provides intake,
workflow selection, approvals, dashboards, journeys, configuration, and workspace views. Native
Copilot surfaces execute governed agents directly, so an Electron-owned ACP controller is no
longer part of the product architecture. A VSIX delivered through an approved internal registry
is also materially easier to distribute than a custom desktop binary.

## Decision

The product is the **`sflow` CLI plus the VS Code extension**, with native Copilot chat or CLI as
the generation surface. The Electron desktop app is retired. Its final source is preserved at
the `desktop-final-v0.9.0` tag and on the `archive/desktop-app` branch.

The CLI workspace registry remains the canonical local workspace store. VS Code `globalState`
may retain presentation preferences, but must not become a competing workspace database.

## Migration disposition

| Capability | Disposition |
|---|---|
| Planning Studio / ACP control | Replaced by governed-session handoff to native Copilot |
| Jira credentials | VS Code `SecretStorage`; credentials are injected only into CLI child processes |
| Storage credentials | VS Code `SecretStorage`, using provider-scoped secret identifiers |
| SharePoint OAuth | Time-boxed extension redirect-flow spike; unsupported until it passes corporate validation |
| Onboarding profile and roles | VS Code settings and walkthrough |
| Workspaces and recent locations | Existing CLI workspace registry and Workspaces view |
| `desktop snapshot` | Public `sflow snapshot`; former command retained temporarily as a deprecated alias |
| Electron IPC, security, dev server, packaging | Retired |

## Product boundary

```text
sflow engine and CLI
        ↓
VS Code lifecycle and configuration UI
        ↓
Native Copilot agents for generation
```

Personas that do not keep an editor open should be notified through a direct approval link. The
pilot must explicitly test whether Product Owners and Business Analysts can complete the intended
two-minute review flow in VS Code. If that bet fails, the fallback is a thin web or Teams approval
surface, not restoration of Electron.

Teams-webhook notifications are therefore a required pilot follow-up rather than an optional
desktop replacement feature. They are not part of this removal commit; broad PO/BA rollout must
not be declared complete until a governed notification links reviewers directly to the matching
VS Code approval item.

## Removal gates

1. Jira and provider tokens are stored through VS Code `SecretStorage`.
2. Jira connection, reset, doctor, and status actions are reachable from VS Code.
3. Intake through approval is executable through VS Code and the CLI.
4. Native Copilot receives the governed agent, prompt, world model, and phase context.
5. A role-aware onboarding walkthrough exists.
6. `sflow snapshot` is the extension read-model command.
7. SharePoint support has an explicit supported or unsupported result.
8. Shared lifecycle behavior remains covered after desktop-only tests are removed.

## Consequences

The project has one governed engine and one primary visual surface. Electron dependencies,
platform installers, code-signing requirements, IPC, and duplicate credential stores leave the
active product. The accepted cost is that PO and BA users work in VS Code; a future non-editor
surface would be a new thin client over the same CLI contracts.
