# Singularity Flow 0.8.0 — Phase Inputs and Remote Agent Markdown

This delivery combines deterministic next-action guidance, the one-script local installer, opt-in approved-artifact dataflow, and trust-pinned public Markdown dependencies for Copilot agents. Package, marketplace, desktop, and plugin versions remain `0.8.0`; `install.sh` deliberately uninstalls and reinstalls the same version so local and Copilot caches receive this build.

## Shipped in this delivery

### Workflow guidance and installation

- `/sflow-about` and `sflow-about` identify Singularity Flow as the product under the Singularity brand and document `/sflow-<action>` as the only public Copilot command namespace.
- Start, resume, approval, rejection, and `/sflow-persona` mirror YAML-derived CLI menus through Copilot's interactive `ask_user` selection UI; unavailable interaction fails without choosing a default.
- Submission and approval display every generated phase document with content or binary path, stable ID, size, and hash; `singularity-flow phase show` provides the same review view on demand.
- `/sflow-nextsteps` and `singularity-flow nextsteps` return valid `NOW`, `THEN`, and `ALTERNATIVE` actions before initialization, throughout lifecycle/recovery, and after completion.
- `/sflow-next`, `sflow-next`, and `singularity-flow next` execute one valid lifecycle action at a time while preserving explicit approval and atomic decision publication.
- `install.sh` performs fast-forward pull, selectable npm/Artifactory registry use, locked dependency install, desktop build, tests/checks, package creation, global CLI replacement, and forced Copilot plugin replacement.
- Registry credentials remain in `.npmrc`; credential-bearing URLs are rejected.

### Approved phase-input dataflow

- `inputsMode: off | record | enforce`, with missing mode equal to `off`.
- Validated shorthand/object declarations, profile ordering and membership, override replacement, optional inputs, and explicit byte budgets.
- Immutable normalized input paths and mode in each new work-item resolution.
- Approved-hash verification, marker-delimited injection, per-generation audit JSON, managed artifact provenance, publish-time recollection, and mode-aware governance.
- `/sflow-inputs` and `singularity-flow inputs [PHASE] [--dry-run]`.
- Starter `record` chains for feature, bugfix, and chore through conformance.

### Remote agent Markdown delivery

- Standard repository agents and bundled plugin agents through `"agents": "agents/"`.
- Exact Markdown dependency tables for remote skills, artifact templates, and generated artifacts. Prose links are inert.
- Public HTTPS, UTF-8/non-empty validation, bounded redirects/timeouts, a 1 MiB default, and a 10 MiB ceiling.
- Interactive trust-on-first-use and deliberate updates in `singularity/agents.lock.yml`.
- Hash-verified atomic cache under `.git/singularity-flow/`, with sync preserving the selected persona.
- Phase/persona-scoped prompt skills, explicit `agent:<agent>/<template>` precedence, immutable work-item template copies, and per-generation context records.
- Allowlisted URL variables and phase-contained generated targets, snapshot reuse, local-edit conflict protection, and explicit refresh/replace.
- CLI list/lock/sync/status/refresh commands, nextsteps diagnostics, governance checks, and Electron agent/lock visibility.
- Bundled `sflow-workflow` agent with empty tables. No live remote URL ships in `0.8.0`.

### Earlier 0.8.0 capabilities included in the release arc

- Workflow performance report and searchable shared help, merged in PR #5.
- Rule-selected repository world-model prompt injection, merged in PR #7.
- Repository world models remain generated and stored in the repository. Remote agent Markdown is an additive prompt/template/output source, never a world-model replacement.
- World-model generation is isolated, manifest-validated, source-hashed, atomically installed, and committed/published. `wm compose` is now the single audited phase path; `wm inject` remains an alias.
- Grounding policy is configurable as `off`, `warn`, or `enforce`. The starter profile enforces committed required views and exact prompt snapshots, while missing legacy configuration remains off.

### Configurable lifecycle sequence gates

- Eight named guards can be configured independently as `hard` or `soft`, globally or per work type.
- Missing configuration remains hard for backward compatibility; each resolved policy is pinned into the work item.
- Soft violations show actionable state and require an exact interactive `continue`; non-interactive use stops safely.
- Confirmed exceptions are attributed to identity and persona and disclosed in state, artifacts, reports, Electron, and governance warnings.
- Integrity and state-transfer controls remain hard in the starter profile, while recoverable phase-status and document-timing mistakes default to soft.

## Starter configuration

```yaml
inputsMode: record

workTypes:
  feature:
    phases: [intake, requirements, design, implementation-spec, implementation, verification, conformance]
    phaseOverrides:
      design:
        inputs: [requirements]
      implementation-spec:
        inputs: [design, requirements]

phases:
  design:
    inputs:
      - requirements
      - phase: intake
        optional: true
        maxBytes: 16384
```

Agent Markdown accepts only these table locations:

```markdown
## Remote skills

| ID | URL | Phases | Personas | Optional | Max bytes |

## Remote artifact templates

| ID | URL | Phases | Optional | Max bytes |

## Remote generated artifacts

| ID | URL template | Phase | Target | Optional | Max bytes |
```

## Prompt composition

Generation now composes:

```text
+ phase skill contract
+ selected persona prompt
+ required repository world-model views
+ exact task guide when requested
+ rule-selected repository world-model files
+ active-agent remote skill Markdown
+ evidence when applicable
```

Approved phase-input artifacts continue to be injected into the managed artifact
template by `prepare`; their independent audit record remains unchanged.

Verification and conformance additionally load the repository evidence ledger.

## Compatibility matrix

| Repository or work-item state | 0.8.0 behavior |
|---|---|
| Workflow YAML without `inputsMode` | Resolves to `off`; declarations validate but runtime is unchanged |
| Existing schema-v2 work item without input fields | Resolves immutably to `off`; no state rewrite required |
| Legacy JSON configuration/state | Existing loader/migration path remains supported |
| Agent without dependency headings | Local-only; no lock and no network access required |
| Repository without agents | Bundled local-only agent remains available; normal skills/workflows are unchanged |
| Local artifact templates | Existing precedence and behavior remain unchanged |
| Remote template URL changes | Cannot change active work; the selected content is copied and pinned at work-item creation |
| Rejected/regenerated downstream phase | Historical records remain; a new generation receives new input and agent records |

## Upgrade and installation

From a clean clone:

```bash
./install.sh
```

For a company registry:

```bash
./install.sh --registry https://artifacts.company.com/artifactory/api/npm/npm-virtual/
```

The script's forced uninstall/reinstall is required because the public version remains `0.8.0`. Start a new Copilot session after installation. Existing repositories do not opt into input behavior until workflow YAML is changed; new repositories initialized by this build use `record`.

## Verification completed

- Full Node test suite, including parser, trust, cache, routing, template/output, session, desktop, installer, phase-input, lifecycle, and resume tests.
- Deterministic source/plugin/schema checks.
- Electron renderer production build.
- Shell syntax, mocked installer, package dry run, and fresh-clone installation/plugin smoke test are part of final release verification.

## Security and operating limits

- This release supports no authentication, cookies, or bearer tokens for remote Markdown.
- Only public HTTPS Markdown is accepted. Redirects must remain HTTPS.
- First trust and updates require human confirmation; sync never mutates the lock.
- Remote skills are not slash commands and cannot escape active agent phase/persona routing.
- Generated outputs cannot escape the current phase artifact directory or imply submission/approval.
- Workflow, lock, agent, template, persona, skill, and GitHub workflow paths are protected during generation.

## Known gaps and next work

- Rejection preserves historical records and invalidates lifecycle approvals, but explicit invalidation markers inside older input/agent context records are deferred.
- Portfolio reporting across every work item (`report --all`) is not implemented.
- This repository still ships example GitHub workflows rather than enabling a CI workflow in `.github/workflows/` by default.
- DNS resolution is delegated to the Node HTTPS stack; literal local/private hosts are rejected, while enterprise egress policy should remain the authoritative network control.
