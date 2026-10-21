# Story intake wizard

**Start new work → Story** follows four steps:

1. **Details** — identifier, description and acceptance criteria. Work type and
   tracker selection remain available in the source/type disclosure.
2. **Workflow & branch** — the approved workflow, its phases, and an explicitly
   selected base branch. Existing workflow favourites and branch search remain.

3. **Documents & checks** — supporting documents, read-only reference repositories,
   baseline choices, test selection, quality gates and any exact recovery review.
4. **Review & start** — a summary of those choices, Edit links and all outstanding
   readiness findings. Only this step exposes **Start Story**.

Workflow favourites are personal VS Code preferences, not approved configuration or Story intent.
They follow the repository's observed logical identity across branch clones and its verified Git
common directory across Story worktrees. Old checkout-keyed favourites migrate without deleting
their original preference data. Pending clicks survive reopening the panel, and an explicit removal
(including clearing every star) takes precedence over older saved aliases. Restoring or starring
favourites adds no Git, network, readiness or workflow-selection operation.

Back, Next and step selection change only the local view; they do not ask Git,
refresh a catalog, run tests, or create a Story. Required text is checked locally
on Next. Navigation is not approval or readiness: the existing host validation,
exact request binding and engine gates still decide whether Start can run.
Finishing the last step never starts automatically.

The current step is retained in this webview's state alongside search, focus and
caret information. Background region patches preserve the step and in-transit
text. Problem links reveal the step containing the relevant field. While creation
is running, step controls are disabled. Switching to Epic or Initiative leaves
their existing forms and creation paths available without a new editor reload.

Review summaries escape repository text and do not expose attachment source paths.
Documents disclose Git/local storage and the selected phases. Optional documents,
acceptance criteria and baseline runs have not become new mandatory gates.

## Size and qualification

The wizard adds one on-demand panel module, no new runtime dependency, CLI command
or process. After integrating main through `a80d85c7`, the Node 22/macOS build
measures 3,122,862 bytes / 254 modules for the
panels bundle, compared with 3,110,886 bytes / 253 modules before this feature.
Its reviewed ceiling is 3,130,000 bytes / 254 modules. All startup, gateway, other
entry and total-byte ceilings remain unchanged. This is a bundle-size review,
not a claim of measured command latency savings.

`test/vscode-intake-wizard.test.mjs` covers navigation, draft retention, local
validation, final-action visibility, recovery links, busy locking, shape changes,
escaping and integration with patch/focus restoration. Existing intake catalog,
attachment, branch-search, scheduling, preparation and test-policy suites remain
applicable. Browser checks additionally exercise the complete production script
under delayed readiness and background patches in light, dark and high contrast.

Favourite persistence has dedicated preference-store and built-host regressions for
legacy migration, pending saves during immediate reopening, checkout changes, late
logical identity, explicit removals, unrelated repositories and failed writes.
The scoped intake suites, built-host regressions, typechecking, unchanged bundle
ceilings and project checks passed on native macOS and Windows with Node 22 and 26.
