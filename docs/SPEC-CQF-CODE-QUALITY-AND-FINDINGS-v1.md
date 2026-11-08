# Code quality and findings (CQF) — v1

Status: owner decisions recorded 2026-11-08; M1, M2 and M4 to build first, then M3 and M5, then M6.

A code step should leave code that has been tested once and whose results every later step can use,
whose tests are shown to be enough, that passes SonarQube's checks and a security scan, and that fixes
what the security team and the technology lifecycle (TLM) list report. The model may edit what the change
needs, and every departure from the approved documents is recorded and decided once. A study of main
229441d9b found each of these missing or partial. This spec states the model and the work.

## Owner decisions (2026-11-08)

The owner took every recommended default from the study and added the sources:

1. **SonarQube** is the team's tool for complexity and vulnerabilities. **CodeQL** is used through GitHub
   (code scanning), as the team runs it.
2. **Sources are configured, not coded:** an API, a link, a Confluence page link, or an export file.
   Security and TLM are configured separately, because they can differ.
3. On a `new-and-changed` Story the existing tests that import changed code run once, at the last step that runs tests.
4. Coverage of changed lines is shown, and warns below 80%. It never refuses by default.
5. The check for tests that assert nothing warns by default.
6. Quality findings warn by default; enforce is chosen per capability. Only findings on new code count.
7. Local rules run inside the fix loop. The SonarQube server's quality gate is read once at submit, when a token is bound.
8. The fix loop has 3 attempts. The same finding three times goes to a person.
9. A critical or high vulnerability in a new dependency holds the step for a person. That person may accept
   it with a reason and an expiry of at most 90 days.
10. Security findings are accepted by the workflow's security reviewers when it names them, otherwise by the step approver. Never by the model.
11. A scanner or source that is missing or offline is recorded and never blocks.
12. The model records departures without asking. They are decided before the code step's approval, and publish goes ahead.
13. An accepted change to an earlier document makes a new generation of that step, with its old approval shown as amended.
14. "Accept all" covers files, supporting files and wording that touches no clause. Everything else is decided one by one.
15. A rejected departure is reverted by the model in the same generation.
16. Departures are decided on the VS Code card or in the Copilot CLI table. The terminal is the fallback, with SF Guard where the workflow asks for it.
17. Appeals fold into departures; the appeal read commands stay.
18. Findings in the files and packages a Story touches are fixed by default, each as a departure.
19. Fixed without asking first:
    - patch and minor upgrades;
    - critical and high code findings with a known fix.

    Major upgrades are planned for a person.
20. Remediation Stories are grouped per repository by due date, at most 10 findings each.
21. Remediation Stories run by themselves as an Auto flight to a tested Candidate. A person approves.
22. Remediation Stories run all existing tests.
23. SFlow prepares the update to the security team, and a person sends it, unless the owner sets a standing rule.

Added by the owner the same day:

24. For now the security team and the TLM owners upload an Excel workbook (or CSV) in SFlow's format. Later the same
    rows come from the security team's URL. Both land in one register.
25. The register lives on the SFlow state branch, so every developer and every Story reads the same list.
26. When a Story is created, the open items for its repository are shown, and the person picks the ones it addresses.
    A picked item becomes a clause of the Story. Items in touched files are still fixed on the way (decision 18).
27. A seeded workflow, `findings-remediation`, addresses security findings and TLM items as a Story of their own. So an
    item is addressed either inside a development Story or by that workflow.

Unchanged: approvals and risk acceptances are people's; nothing new refuses unless a decision above says so.

## Model

### Finding

One shape for every tool and source:

```
{ id, feed: security|tlm|quality, source, tool, toolVersion, rulesetSha256,
  rule, severity: blocker|critical|high|medium|low|info,
  kind: bug|vulnerability|hotspot|code-smell|complexity|duplication|dependency|end-of-life,
  file, line, endLine, package?, installedVersion?, fixedVersion?, cve?, dueAt?,
  message (bounded, redacted, never instructions), fingerprint, newCode: true|false }
```

The fingerprint is stable across runs: tool + rule + file + a normalised snippet hash, or tool + package + advisory.

### TLM item

```
{ id, source, component, ecosystem: npm|maven|gradle|pypi|nuget|go|runtime-node|runtime-java|runtime-python|container-image,
  currentVersion, targetVersion, endOfLifeAt, dueAt, owner?, exception? }
```

SFlow finds where a component is pinned:
- manifests and lockfiles;
- `pom.xml` and `build.gradle`;
- `pyproject.toml` and `requirements*.txt`;
- `.nvmrc`, `.node-version` and `engines`;
- a Dockerfile's `FROM` line;
- setup steps in CI.

### Configuration

Two places, both governed configuration that changes through configuration approval:

- `singularity/workflow.yml` `codeDelivery` and each step's `qualityCommands`: what runs inside the code step (M3, M4, M5).
- `singularity/findings.yml`: where findings and the TLM list come from, and what to do with them (M6).

```yaml
schemaVersion: 1
# Uploaded workbooks need no source entry: `findings import` names its source (REQ-062).
security:
  sources:
    - { id: security-team, type: upload, columns: { id: Ticket, severity: Risk } }   # optional header map for uploads
    - { id: sonar, type: api, provider: sonarqube, url: https://sonar.example.internal,
        project: payments-api, environment: sonar, include: [vulnerability, bug, code-smell, hotspot] }
    - { id: codeql, type: api, provider: github-code-scanning, tool: CodeQL }   # the GitHub CLI's own sign-in
    - { id: sec-jira, type: api, provider: jira, jql: 'project = SEC AND component = payments-api AND statusCategory != Done' }
    - { id: sec-export, type: file, path: security/findings.sarif, format: sarif }
  policy: { bringIntoCodeStep: touched, autoFix: { dependencies: [patch, minor], code: [critical, high] }, exceptions: honour }
  stories: { workType: findings-remediation, group: per-repository-by-due-date, maximumFindings: 10, open: on-sync, auto: candidate }
  accept: { authority: security-reviewers, fallback: step-approver }
tlm:
  sources:
    - { id: tlm-page, type: confluence, page: https://example.atlassian.net/wiki/spaces/ENG/pages/123456,
        environment: confluence, table: 1,
        columns: { component: Component, currentVersion: Version, endOfLifeAt: EOL, targetVersion: Target } }
    - { id: tlm-link, type: link, url: https://tlm.example.internal/export/payments-api.csv, format: csv, environment: tlm }
    - { id: tlm-api, type: api, provider: generic-json, url: https://tlm.example.internal/api/v1/components?app=payments-api,
        environment: tlm, fields: { component: name, currentVersion: version, endOfLifeAt: eolDate, targetVersion: target } }
    - { id: tlm-file, type: file, path: tlm/payments-api.csv, format: csv }
  policy: { bringIntoCodeStep: touched, autoFix: { upgrades: [patch, minor] }, dueSoonDays: 60, exceptions: honour }
  stories: { workType: findings-remediation, group: per-component, open: on-sync, auto: candidate }
  accept: { authority: step-approver }
```

A token is never written in either file. A literal that looks like a credential is refused, as quality command `env` is today. Hosts are limited to the configured URLs.

## M1 Test results carry forward `[CQF:REQ-010]`

- `[CQF:REQ-010]` Every step's test runs, fresh or reused, are bound into the Story record that Release and the evidence graph read.
  - Today `src/story-lineage.mjs:468` builds that record from code steps only, and `reusedExecutionDetails` in `src/phase-execution-evidence.mjs` picks up only reused runs.
  - A run is judged by its counts. A zero-test run that exits 0 is recorded as "no tests ran". It is shown, and it refuses only where an existing minimum already applies.
- `[CQF:REQ-011]` Documentation paths are hashed separately, as test inputs are, and are not part of the reuse rule or of stale binding. There is one definition of documentation, the one `src/delivery-evidence.mjs` already uses to exempt documentation edits.
- `[CQF:REQ-012]` A non-code step that runs repository tests runs or reuses them in its publish check, so its document can cite its own run. Submit reuses that run.
- `[CQF:REQ-013]` When runs of one command on the same code and environment disagree (a fail and a pass), the command is marked flaky. This is shown in the review packet, `tests summary` and VS Code. It never refuses.
- `[CQF:REQ-014]` A failed test's message is shown in three places, bounded and redacted as the JSON already is:
  - the VS Code Test summary page (a message column);
  - the `tests summary` text;
  - `/sf-test`.
- `[CQF:REQ-015]` `tests summary` shows the run bound to the step by default, with reused runs merged in. `--latest` shows the newest run.
- `[CQF:REQ-016]` The review packet no longer says submission runs the tests again.
- `[CQF:REQ-017]` On a `new-and-changed` Story, the last step that runs tests runs once the existing tests that import changed modules (`extractModuleSpecifiers`, `src/verification/incremental-verification-graph.mjs`).
  - The reuse rule applies.
  - A failure is handled as any test failure at that step.
  - The review says which tests ran and why.

## M2 Departures in the code step `[CQF:REQ-020]`

- `[CQF:REQ-020]` `/sf-code` edits whatever the change needs, inside the hard limits below.
  - The skill's "pin/scope changes need humans" and "stop on unowned changes" become "record a departure".
  - The guard's hard limits are unchanged.
- `[CQF:REQ-021]` Each departure is one record, `DEP-NNN`. It is append-only, authored as governed-agent, and recorded by a command a `/sf-code` turn may run. It holds:
  - its kind: `path`, `supporting`, `plan-row`, `test`, `wording` or `clause`;
  - its target document, with generation and approved sha256;
  - the diff, the reason and the clauses it touches;
  - the hash of each file;
  - any finding IDs it fixes (M6).

  SFlow records path departures itself at prepublish, from `unreconciledCandidatePaths`.
- `[CQF:REQ-022]` Publish includes files with an open departure. They no longer raise `GENERATION_EXCLUDED_CHANGES_UNRESOLVED`. A path another step's plan owns is still refused.
- `[CQF:REQ-023]` While any departure is open, the step sheet holds the code step's approval. The hold names who clears it. Publish and submit go ahead.
- `[CQF:REQ-024]` Departures are decided in one table: the VS Code decisions card, the Copilot CLI table, or the terminal table.
  - "Accept all" covers `path`, `supporting` and clause-free `wording` rows.
  - `test`, `plan-row` and clause-touching `wording` rows are decided one by one, each with a reason.
  - `clause` rows are decided by scope approvers only, one at a time, with the steps they reopen shown. Any test changed under the same clause is shown beside them.
- `[CQF:REQ-025]` Accepting writes the existing records under their existing authority rules, signed by SF Guard where the workflow requires:

  | Departure | Record written |
  |---|---|
  | path, supporting | plan amendment |
  | plan row, test | plan row correction |
  | wording | forward amendment |
  | clause | intent amendment |
- `[CQF:REQ-026]` Rejecting marks the departure rejected. The model reverts it in the same open generation, and the next prepublish checks the file is back to its base hash.
- `[CQF:REQ-027]` An amended earlier step gets a new generation whose origin names the departure. Its old approval is shown as "amended by DEP-x", and its readers' revalidation rows are in the same table.
- `[CQF:REQ-028]` A file edited again after its departure was accepted reopens only that row. This is the plan amendment hash rule.
- `[CQF:REQ-029]` `appeal prepare` records a departure, and the appeal read commands stay. These never become departures:
  - secrets and environment files;
  - other Stories' files;
  - workflow and config files, protected paths, `.git`;
  - approvals and risk acceptances;
  - an earlier document's managed input block;
  - deleting, skipping or loosening a planned test, which "Accept all" never covers.

## M3 Are the tests enough `[CQF:REQ-030]`

- `[CQF:REQ-030]` A test command's coverage report is captured as a second raw report beside its test report, and is reused with its attempt.
  - Formats: lcov, Cobertura, JaCoCo, Istanbul JSON.
  - The path is a command's `coverage: { format, path }`, or a known default such as `coverage/lcov.info`, `coverage/cobertura-coverage.xml`, `target/site/jacoco/jacoco.xml` or `coverage.xml`.
  - SFlow does not add coverage flags to a command, because that would change its pin.
- `[CQF:REQ-031]` Changed-line coverage is the lines this Story changed (from the change set's hunks) that the report marks run. It is shown per changed file and per clause in the review packet, the approval card and `tests summary`.
  - Setting: `codeDelivery.changedLineCoverage: { mode: off|warn|enforce, minimum: 80 }`, default warn.
- `[CQF:REQ-032]` The assertion and edge-case check (`src/verification/corner-case-obligations.mjs`) runs at the gates in warn mode by default. `off` and `enforce` keep their meaning.
- `[CQF:REQ-033]` The approval card and review packet show, for each criterion, how many tests prove it and whether each asserts.
- `[CQF:REQ-034]` With no coverage report, "coverage not measured" is shown. It never refuses.

## M4 Findings in the code step's loop `[CQF:REQ-040]`

- `[CQF:REQ-040]` Finding readers live in `src/findings/readers/`: `sarif`, `eslint-json`, `sonarqube` (issues, hotspots, measures, quality gate JSON). Each yields the finding shape above.
- `[CQF:REQ-041]` `qualityCommands` of kind `lint`, `static-analysis` or `security` may name `result: { adapter, path }` and `gate: { failOn: [severities] }`.
- `[CQF:REQ-042]` Only findings on lines this Story changed count (`newCode: true`). The others are shown as existing.
- `[CQF:REQ-043]` A code step runs these commands in its publish check, beside its tests. Findings come back through prepublish `findings`, with a same-turn continuation shaped like `repairContinuationForTestFailure`.
  - The loop has 3 attempts per generation.
  - A fingerprint seen three times escalates to a person through the existing finding escalation.
- `[CQF:REQ-044]` A suppression the model adds on a changed line is itself a finding. Examples: `NOSONAR`, `eslint-disable`, `@SuppressWarnings`, `# nosec`, `// codeql[...]`.
- `[CQF:REQ-045]` Non-test commands use the reuse rule of `[TCE:REQ-080]`, with tool version and ruleset digest in the key, so a later gate does not run them again on unchanged code.
- `[CQF:REQ-046]` `codeDelivery.staticAnalysis.mode` is `warn` (default), `enforce` or `off`.
  - In every mode, a missing or offline tool is recorded as `unavailable`, shown to approvers, and blocks nothing
    (decision 11).
  - `enforce` holds the step only for findings that remain after the loop.
- `[CQF:REQ-047]` `decision finding-risk` accepts one finding with a reason of at least 20 characters and an expiry of at most 90 days. It binds the fingerprint, rule and tool version. It is append-only and a person's decision. The authority is decision 10's.
- `[CQF:REQ-048]` SonarQube:
  - **In the loop:** local rules. For JavaScript and TypeScript, `eslint-plugin-sonarjs` through ESLint JSON when installed; other languages through their linters.
  - **Server:** `sonar-scanner`, `mvn sonar:sonar` or `gradle sonar` with `sonar.qualitygate.wait=true` on the Story branch, run once at submit, and only when the server supports branch analysis. SFlow then reads, for the branch's new code, `api/issues/search`, `api/hotspots/search`, `api/qualitygates/project_status` and `api/measures/component` (`complexity`, `cognitive_complexity`, `duplicated_lines_density`, `new_coverage`).
  - **No branch analysis on the server:** SFlow never analyses into the main project. It reads that project's findings (M6) unless the owner names a scratch project key.
  - The token and host come from environment `sonar`, bound with `env bind`.
- `[CQF:REQ-049]` CodeQL comes from GitHub code scanning, as the team runs it:
  - SFlow reads the open CodeQL alerts for the Story's branch with `gh api repos/<owner>/<repo>/code-scanning/alerts?ref=<branch>&tool_name=CodeQL&state=open`. It uses the GitHub CLI's own sign-in and host resolution, as `src/github-evidence.mjs` does for check runs, so no token is stored.
  - The alerts exist once the branch is pushed and the CodeQL workflow has run. They are read at submit and in later steps, are new-code findings when they fall on changed lines, and are shown with the analysis's commit. Before that, they show as "CodeQL has not analysed this branch yet", which never blocks.
  - A capability's `requiredChecks` can still require the CodeQL check run to pass.
  - Optional: a local `codeql` CLI writing SARIF, where one is installed.
  - Team import and Build with Copilot classify `sonar-scanner`, `codeql`, `semgrep`, `npm audit`, `pip-audit`, `osv-scanner`, `dependency-check` and `eslint` as checks, and propose CI `uses:` steps such as `github/codeql-action` and the SonarQube scan action.

## M5 Security checks `[CQF:REQ-050]`

- `[CQF:REQ-050]` Dependency audit on the manifests and lockfiles the Story changed: `npm audit --json`, `pnpm audit --json`, `pip-audit -f json`, `osv-scanner --format json`, OWASP dependency-check JSON.
  - A new or upgraded package with a known advisory is a new-code finding.
  - The advisory database's date is recorded. A database more than 7 days old informs.
- `[CQF:REQ-051]` Static security analysis through SARIF: semgrep with a pinned ruleset, and CodeQL (M4). It runs in the same loop.
- `[CQF:REQ-052]` A critical or high vulnerability in a new dependency holds the step for a person, as a step-sheet hold, not a refusal. Fixing it or a finding-risk acceptance clears it. Other security findings warn.
- `[CQF:REQ-053]` The authority for security findings is decision 10's.
- `[CQF:REQ-054]` A missing scanner or database is recorded and never blocks.
- `[CQF:REQ-055]` The approval card shows a capability's GitHub `requiredChecks` results, such as CodeQL and SonarCloud, as evidence.
- Secret scanning is unchanged. Tests against the running app (DAST) are not in v1.

## M6 Security team and TLM findings `[CQF:REQ-060]`

- `[CQF:REQ-060]` **Workbook format.** One `.xlsx` workbook with a `Security` sheet and a `TLM` sheet; either may be
  absent. A single sheet, or a CSV file, is read with `--feed security|tlm`. The first row holds the headers. Headers
  are matched by name, ignoring case, spaces and punctuation, with the aliases below. A team whose sheet uses other
  headers maps them in `singularity/findings.yml` (`columns:`), so no code changes.
  - **Security** (required columns in bold): **ID**, **Title**, **Severity** (Critical, High, Medium, Low, Info),
    **Repository**, Type (Code, Dependency, Configuration, Container), File, Line, Package, Installed version,
    Fixed version, CVE, CWE, Rule, Tool, Description, Due date, Status (Open, In progress, Accepted risk,
    False positive, Fixed), Exception expiry, Owner.
  - **TLM** (required columns in bold): **ID**, **Component**, **Repository**, **Target version**, Ecosystem
    (npm, maven, gradle, pypi, nuget, go, runtime, container, os), Current version, End of life date, Due date,
    Status (Open, In progress, Waiver, Done), Waiver expiry, Owner, Notes.
  - Dates are ISO dates or Excel date cells. Repository is a repository name or URL and matches the Story's repository.
  - `findings template [--out FILE]` writes an empty workbook with both sheets, the headers and one example row each.
- `[CQF:REQ-061]` **Reading a workbook.** SFlow reads `.xlsx` itself, with no new dependency. The reader is bounded:
  - a size limit on the file and on each unzipped part;
  - no formulas evaluated, only their cached values;
  - shared and inline strings, numbers, booleans and dates.
  A row that fails validation is reported with its sheet, row number and reason. The rest import. Cell text is data:
  bounded, quoted, and never read as instructions.
- `[CQF:REQ-062]` **Import.** `findings import FILE [--feed security|tlm] [--source NAME] [--dry-run] [--json]`:
  - reads, validates, normalises and de-duplicates rows into the register;
  - a later import from the same source replaces that source's open rows. An item missing from a later import is
    marked "not in the latest import", never deleted;
  - records who imported, when, the file's SHA-256, the row counts and every rejected row.
  The VS Code command "Upload security or TLM findings…" opens a file picker and runs the same import. In Copilot CLI,
  `/sf-findings import PATH` runs it.
- `[CQF:REQ-063]` **Register on the state branch.** The register is a governed file on the SFlow state branch, written
  through the existing state-branch writer (`src/ledger.mjs`, "Put a governed file on the orphan state branch"):
  - `findings/security.json`, `findings/tlm.json` and `findings/imports.json` (the import history);
  - the uploaded workbook itself is never committed, only the normalised rows;
  - each item records its state: open, in a Story (with the Story ID), fixed awaiting proof, closed, accepted risk,
    waiver, not in the latest import;
  - reads go to the local state ref, as other state-branch readers do; a Story never fetches it by itself.
  On a public repository the register stays in the private local store and the import says why, because the state
  branch is readable by anyone who can read the repository.
- `[CQF:REQ-064]` **Later sources.** The security team's URL (`link`, HTTPS returning the same columns as JSON, CSV or
  `.xlsx`) and the `api` providers (SonarQube, GitHub code scanning, Dependabot, Jira) write into the same register
  through `findings sync`. Credentials come only from bound environments, and requests go only to configured hosts. A
  source that fails is recorded, and nothing blocks. A source's own exceptions are honoured: SonarQube's won't-fix,
  false-positive and accepted issues, hotspots reviewed as safe, Jira statuses mapped as accepted, and a row's Status,
  exception or waiver columns.
- `[CQF:REQ-065]` **At Story creation.** When a Story is created (CLI, VS Code new-Story form, `/sf-start` in Copilot),
  SFlow lists the register's open items for the Story's repository, highest severity and nearest due date first:
  - the person picks the ones the Story addresses (`--address ID,…` on the CLI, tick boxes in VS Code, a choice in
    Copilot). Nothing is picked by default;
  - each picked item becomes a clause of the Story, with its proof (REQ-068), and its state becomes "in a Story";
  - an item already in another open Story is shown with that Story's ID and cannot be picked twice.
- `[CQF:REQ-066]` **Fix on the way.** When `/sf-code` starts, entry also lists the open items on the files and
  packages the Story touches: changed and planned paths, and the manifests of touched modules. The model fixes the
  eligible ones by default (decision 19), each as a departure carrying the item's ID. The others are listed.
- `[CQF:REQ-067]` **Seeded workflow `findings-remediation`.** A seeded work type in `templates/workflow.yml`, protected
  like the other seeded workflows:
  - `findings-intake`: the Story's clauses are the picked items, one clause each, read from the register;
  - `remediation-plan`: the fix per item. A major upgrade is listed for a person to approve and is never made by itself;
  - `implementation`: the code step, with the findings loop (M4, M5);
  - `verification`: all existing tests run (decision 22), plus each item's proof;
  - `conformance`.
  `findings plan` previews groups (security per repository by due date, at most 10; TLM per component) and
  `findings start` opens a Story of this work type for a group. With `auto: candidate` it runs as an Auto flight to a
  tested Candidate, and a person approves it.
- `[CQF:REQ-068]` Proof:
  - **Security:** the same tool, rerun on the changed code, no longer reports the finding. A finding only the security
    team can rescan is recorded as "fixed, awaiting rescan", and closes when a later import or sync no longer lists it
    as open.
  - **TLM:** the manifest, lockfile or runtime file shows at least the target version.
  - **Both:** all existing tests run, and the build passes.
  When the Story's change merges, its items move to "fixed awaiting proof" or "closed" in the register.
- `[CQF:REQ-069]` After merge, `findings report` prepares the update for the security team and the TLM owners: an
  export in the same workbook format with each item's state, Story and evidence. A person sends it, unless
  `report: { send: automatic }` is set for a configured source.
- `[CQF:REQ-070]` Surfaces:
  - the CLI (`findings template | import | list | plan | start | report`);
  - `/sf-findings` (import, list, plan, start);
  - a VS Code Findings view with Security and TLM tabs, due dates, and which Story addresses each item, plus the upload
    command.

## Acceptance

- **M1:** a Story whose verification step runs fresh tests shows that run's counts at Release. A README edit after the code step reruns nothing. A fail-then-pass shows flaky. The VS Code page shows the message.
- **M2:** a real `/sf-code` turn adds a file the plan does not name and publishes it with `DEP-001`. The person accepts it in one table and the code step approves, with no `/sf-appeal`, no `/sf-decide` turn and no terminal trip.
- **M3:** a Vitest project with lcov shows changed-line coverage per clause. A test with no assertion warns.
- **M4:** an ESLint sonarjs finding on a changed line comes back to `/sf-code` in the same turn and is fixed within 3 attempts. A missing scanner under `warn` blocks nothing. A real SonarQube server's quality gate is read at submit.
- **M5:** adding a package with a known critical advisory holds the step until fixed or accepted by a person.
- **M6:** a workbook with one security row and one TLM row imports into the register on the state branch. A new development Story picks the security row as a clause. `findings start` opens a `findings-remediation` Story for the TLM row that reaches a tested Candidate with its proof.
