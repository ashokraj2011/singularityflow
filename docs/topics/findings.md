---
id: findings
title: Findings — what a blocking finding means and how to recover
aliases:
  - finding
  - blocking-finding
  - refusal-codes
questions:
  - What does this finding code mean?
  - Why is my phase blocked and who can fix it?
  - The check is wrong; how do I get past it?
commands: []
related:
  - recovery
  - phase-appeals
  - escalation
version: 23
---
A finding is one exact reason a step cannot publish, submit or finish. Every finding has an owner and a recovery route: the step's own author fixes its draft, an earlier step's approvers decide an upstream issue, a person records a decision, or an owner restores trusted bytes. Each refusal names its finding code; read its entry here with `sflow explain findings --section <CODE>` (the code is matched without regard to case). No finding routes only back to its own author: each names at least one route for someone else, its approvers, an earlier step, an owner, or, when nothing more specific exists, the workflow maintainer. Nothing in this catalog waives a test, approves a step or accepts a risk by itself.

## Purpose and prerequisites

Use this topic when a step was refused and you need to know what the finding means, what usually causes it, how to fix it, and who else can act when the author cannot. Run `sflow recover --phase <PHASE> --json` first: it lists the step's current findings with their routes, and preserves every draft, index entry and published byte.

## Use it from each surface

- **Shell:** `sflow explain findings --section <CODE>` for one entry; `sflow recover --phase <PHASE> --json` for the live findings and routes.
- **Copilot:** `/sf-recover` lists the routes; `/sf-help` serves this topic. A skill follows the route it was given and never edits an earlier step to clear a finding.
- **VS Code:** the refusal card names the finding and its route; open **Lifecycle** to act on it.

## Guided workflow

1. Read the finding's code and route from the refusal or from `sflow recover --phase <PHASE> --json`.
2. Read its entry below: what it means, the usual causes, and the fix.
3. Fix what the entry says the author owns, then recheck with `sflow phase prepublish <PHASE> --json`.
4. When the author cannot fix it (the finding belongs to an earlier step, a person must decide, or the check misreads correct work), use the route its entry names for someone else instead of repeating the same repair.
5. When the same finding returns a third time after real changes, the result says so: a refusal's first step becomes "Stop" with the routes for someone other than the author, and `sflow phase prepublish` reports `repairLoop.status: escalate`. A recheck with nothing changed is not counted. The count is kept on this computer only and accepts nothing.

## Finding classes

Every finding belongs to one class. A finding without its own entry below is documented by its class.

### author-correction

The step's own author fixes its current draft: the artifact, its tags, its tests or its planned evidence. Fix the listed item in the open generation and recheck with `sflow phase prepublish <PHASE> --json`. Published content needs a successor generation, never an edit in place. If the same finding returns unchanged after a real repair, stop repeating it: the check may be misreading correct work. Where its entry offers a dispute, prepare one with the evidence; otherwise name the finding and its evidence to the step's approvers.

### quality

A document-quality shortfall, such as a placeholder left in, a required section that is too short, or an empty heading. The author fixes it in the draft. For a pilot phase, the step's approvers may instead carry the exact shortfall forward with an expiry through `sflow appeal risk-prepare`; it stays unmet, never passed, and tests, review and approval still apply.

### test-repair

`CODE_TEST_FAILED`, `CODE_TEST_TIMEOUT`, `CODE_TEST_SKIPPED` and `CODE_TEST_ZERO_DISCOVERED` require repair of the current phase's implementation, tests or owned test environment, followed by a fresh recorded run. Read the retained output before retrying. A timeout or missing prerequisite keeps its actual cause and explicit environment/setup route; it is not proof that an assertion failed. Skipped or undiscovered tests are not passing evidence. A test that ran and failed must be fixed; no documentation change, plan amendment or private-copy action can waive it.

### upstream-defect

An honest check found that an earlier step's delivery is incomplete. Do not edit the verdict or the earlier step. Raise an upstream issue with `sflow upstream-issue raise --phase <EARLIER-STEP> --about <CLAUSE> --problem <TEXT>`; that step's approvers decide it (return, amendment, plan correction or accepted risk).

### upstream-decision

A code step's planned delivery is incomplete, and every clause still missing is named by an open upstream issue raised against an earlier step. More code from this step cannot clear it. The earlier step's approvers decide the issue in the decision list (`sflow decisions <WORK-ID>`, or `/sf-decide`): a return, a plan correction, an accepted risk or a dismissal. Copilot tells the person and never decides or records it for them. A clause no issue names stays this step's to deliver.

### integrity-or-authority

A protected path, an identity, a signature, a configuration authority, a source boundary or a secret check refused. These protect the Story and cannot be waived by an appeal or a risk decision. Preserve your edit, then restore the trusted bytes or use the original configuration authority; `sflow doctor --json` shows what changed.

### current-phase-preparation

The current generation is not prepared yet: no composed prompt, no open generation intent, or grounding not ready. Prepare it (`sflow wm compose --phase <PHASE>` or `sflow phase begin <PHASE> --json`) and recheck. Existing work is kept.

### worktree-review

Uncommitted or staged changes need review before the step can continue. `sflow recover --phase <PHASE> --json` shows the exact bytes and can offer a hash-confirmed scoped commit; unrelated edits and the index are preserved.

### human-input

A person must answer a clarification. Ask the question, then record the actual reply with `sflow clarification record <PHASE> --question <TEXT> --answer <TEXT>`. A missing record is not an unanswered question, and an answer is never invented.

### operational-prerequisite

The environment, a host, a remote, an integration or the test runner is unavailable. The step's work is fine; resolve the prerequisite with its owner (`sflow doctor --json` names it), then retry. Retrying an unchanged condition changes nothing.

### lifecycle

The Story or step is not in a state that allows this transition. Resume it, prepare a successor, or follow the route the refusal names.

### owner-resolution

No automatic repair or decision is registered for this finding. Give the workflow maintainer the exact finding and the output of `sflow doctor --json`; nothing is discarded while it waits.

## Finding catalog

### CODE_DELIVERY_EVIDENCE_REQUIRED

The code step's delivery is not publishable: no product source changed, no acceptance test was found, owed `@ac` or `@clause` tags are missing, or a fulfillment obligation is unmet. Common causes: a test that does not run, tags on the wrong line or naming a criterion the specification does not hold, or a test file outside every recognised test folder (the refusal names such a file). Fix the listed items in the open generation and recheck with `sflow phase prepublish <PHASE> --for-agent --json`. Never edit product source only to make a generation look changed: a generation a person's rejection returned to the code step may change only tests and carries the previous generation's unchanged source and clause comments, while a first generation must implement. A generation left unchanged after a return names its way out: make the requested change, or a reviewer of the returning step withdraws the return with `sflow story rework roll-forward --change-request <CR-ID>`. When every item is delivered and the finding still returns unchanged, the check is misreading the delivery: stop the repair loop and dispute it. `sflow appeal risk-prepare --phase <PHASE> --finding CODE_DELIVERY_EVIDENCE_REQUIRED --evidence-file <PATH> --expires <YYYY-MM-DD> --reason <TEXT>` binds the exact problems, this candidate and the evidence (test output, the test file); one of the step's approvers reviews it live with `sflow appeal risk-accept` and the same arguments plus `--confirm`. The gate then publishes this exact candidate with the finding recorded as an exception, never as passing evidence; tests still run, and any change to the candidate or a new problem ends the exception. `sflow appeal risk-revoke` withdraws it.

### CODE_DELIVERY_RETAINED_EVIDENCE_MISSING

A planned evidence file (usually a screenshot) has not been produced. Start the app from the Story's own checkout on a port you confirmed is free, bring it to the planned state and save the file at exactly the planned path, then recheck. When a test captures it, the test saves under its runner's output (for example `test-results/`) and you copy the file to the planned path once: a test that saves straight to that path replaces the published image on every later run, and a later step's commit then refuses the change (`RETAINED_EVIDENCE_CHANGED`). Never take it from another checkout's server and never fabricate it; a person witnesses it after submission.

### RETAINED_EVIDENCE_CHANGED

Retained evidence a step published is not what the checkout holds now. `RETAINED_EVIDENCE_CHANGED` refuses a later step's publication or submission that would commit other bytes for the file, or delete it; `WITNESS_EVIDENCE_UNPUBLISHED` refuses a witness of a file that is not the published image. Each names the step that published it, its generation commit, the published and the current SHA-256, and two ways on. To keep the published image, restore it with `git restore --source=<GENERATION-COMMIT> -- <FILE>` and run the command again. To keep a new image, the step that owns the evidence publishes it in its next generation, which records the new bytes: the refusal names the return (`sflow reject <STEP> --to <OWNER>` once the step awaits approval) or the upstream issue (`sflow upstream-issue raise --phase <OWNER> --about <CLAUSE>`) that takes the Story there. When the file changed while the command ran, a test saves its capture to the evidence path and every run replaces it, so running the command again is refused again: that test changes, in the owning step, to save under its runner's output (for example `test-results/`), and the image is copied to the evidence path once. SFlow never restores the published image for you; a refused command puts back only the Story's own files that changed while it ran.

### CODE_DELIVERY_TEST_COMMAND_REQUIRED

No supported structured test command can be inferred for the changed code. `sflow capability test-setup --json` suggests one; repair the repository's own test script within the step's scope. An Nx project's Playwright target is inferred since this release, so updating Singularity Flow may be enough. For this Story, request the exact command with `decision test-command <WORK-ID> --phase <PHASE> …`; a person who approves the step accepts it from the decision list, and its tests must pass. For every later Story, propose it with `capability test-setup --step <STEP> … --confirm <digest>`; once a configuration approver activates it, the current Story adopts it through a reviewed policy amendment. The code step reports a missing runner for its planned paths as it opens.

`TEST_MODULE_UNCOVERED` takes the same routes. A changed file belongs to the nearest build file of any ecosystem: a folder with `requirements.txt`, `setup.py`, `setup.cfg` or a `Pipfile` runs pytest, and an Xcode project, a CMake or Meson build, a conda environment or a nox file has no inferred runner, so a root `package.json` never covers them. A command Singularity Flow infers counts only for its own language's files (`npm test` never covers a `.py` file); a command a person configured or accepted covers the roots they gave it, unless it names an `ecosystem`: a test setup suggestion accepted as offered keeps its own, so a root `mvn test` with `affectedRoots: ['.']` never covers the `.js` beside it. The `node --test` fallback runs only test files that import `node:test`.

A test file is one named as a test in a test folder (`value.test.cjs` and `value.test.cts` count, like `.js` and `.ts`), or any script below a `__tests__` folder, as Jest's default match runs it (`__tests__/value.js`); `fixtures`, `__fixtures__`, `__mocks__` and `__snapshots__` below it are support, never the acceptance test.

### TEST_MANIFEST_INVALID

A build manifest test detection reads (a `package.json`) is not valid JSON. The refusal names the file and where the parser stopped; fix the JSON within the step's scope and run the command again. At a repository root with another build beside it, test setup still suggests that build's command and lists this beside it.

### TEST_COMMAND_PIN_CHANGED

A test command changed since its first gate run pinned it for the Story: its argv or adapter, or a script, workspace, runner configuration or preloaded file it resolves through (the refusal lists each change; a file the command names that is not there is pinned as missing, so creating it is a change too). Nothing ran. It is also the refusal for a suite the Story pinned that its module no longer declares (a deleted `test:node` beside Jest): the refusal says `removed`, and the request with the same `--repin` asks that it no longer run. Restore what was pinned, or restore each changed definition entry to its recorded generation-baseline value while keeping every other binding unchanged (`restoredToBase`, with baseline and entry hashes recorded by the next successful gate). This requires no human acceptance; an unnecessary re-pin request stays in history as inactive. For a genuine change, request the new pin with `decision test-command <WORK-ID> --phase <PHASE> --repin <COMMAND-ID> --reason <TEXT>`; a person who approves the step accepts it from the decision list, and the next gate run records it. An agent may request, never accept.

### TEST_COMMAND_BASELINE_UNAVAILABLE

SFlow could not verify a proposed restoration against the recorded generation baseline. The
diagnostics distinguish a missing ref or object, an unreadable or oversized file, a timeout, and
an invalid file type. Pending requests remain pending. Recover the named local Git data and retry
the same authoring action; this error never accepts a re-pin or substitutes a different baseline.

### PHASE_NOT_AWAITING_APPROVAL

The current phase has not been submitted for approval. Its existing draft remains authoring work:
follow the returned preparation, prepublish, source-review or submit route in a new turn. No
approval receipt or packet is created, and no draft cleanup is required by this premature approval
attempt. Once submitted, source changes outside the exact reviewed packet still require the
existing recovery boundary before approval.

### CODE_TEST_NARROWED

A required test command passed, but narrowed by this Story: a filter in its argv or pinned script, a focused test (`.only`), skipped tests, or fewer tests than its first passing run in this Story (the refusal names each). Narrowing is measured against the Story's base commit: a filter already in the same script there (a team's `playwright test --project=chromium`) or a focused test already in the base version of the file is the team's own setup and is recorded as standing, not refused; skipped tests count only when the Story's changed test files add skip markers or a run skips more than its first passing run. Remove the narrowing and publish again, or a person who approves the step accepts it with `decision test-narrowing <WORK-ID> --phase <PHASE> --command <COMMAND-ID> --reason <TEXT>`; it covers the same or a smaller narrowing of the same pin. An agent never accepts it.

### SPEC_COVERAGE_INCOMPLETE

A clause the step owes has no evidence, a changed path is not claimed by any clause, or recorded evidence is invalid. Add the missing evidence in the draft. An unplanned path is accounted for by the plan's approvers (`sflow decision plan <WORK-ID> --add-location <CLAUSE>=<PATH> --reason <TEXT>`) or through a scope appeal (`sflow appeal prepare`). Missing coverage on a pilot phase may be carried as an expiring risk by the step's approvers.

### Unclaimed changed paths

A file changed that no clause claims, such as a test helper, mock data or a new module. Each changed path belongs to a clause row: tests in the Planned tests column, product files under Expected paths. The plan's approvers add it with `sflow decision plan <WORK-ID> --add-location <CLAUSE>=<PATH> --reason <TEXT>` or `--add-test <CLAUSE>=<PATH>`; while the code step is open, `sflow appeal prepare` accounts for it after review of the exact diff.

`GENERATION_EXCLUDED_CHANGES_UNRESOLVED` means publication would leave changed application files outside its planned candidate. Resolve them in the current code phase: a plan approver accounts for intended Story edits through a narrow amendment to existing clauses; a person preserves unrelated edits using recovery's exact, hash-confirmed private-copy action. Local isolated diagnostic tests can still run, but do not authorize publication with unresolved files. Earlier approved artifacts remain unchanged. For an already-submitted phase, recovery offers an authorized return to the same phase before a successor is published, tested and resubmitted; do not commit submitted edits by hand or discard them to clear approval.

### Agent brief findings

`AGENT_BRIEF_SUMMARY_REQUIRED`, `AGENT_BRIEF_PRESERVED_SECTION_REQUIRED`, `AGENT_BRIEF_MAXIMUM_BYTES_EXCEEDED`, `AGENT_BRIEF_HEADING_AMBIGUOUS` and `ARTIFACT_COMMENT_UNCLOSED`. The Agent brief is not readable: write it as visible text under its own heading, outside any template comment, keep it within its size, close every comment, then recheck.

### Document quality findings

`artifact.placeholder.unresolved`, `artifact.required.too-short` and `artifact.heading.empty`. A template placeholder is still in the draft, a required section is too short, or a heading has no content. Complete the section in the draft and recheck; see the quality class above for pilot risk.

### conformance.verdict-incomplete

The conformance comparison is honest and found the delivery short. It is an advisory, never a publication blocker: keep the partial or missing verdict as written, and never upgrade it to clear a check. The step that delivered the clause owns the gap. Raise an upstream issue against it if none names the clause (`sflow upstream-issue raise --phase <DELIVERING-STEP> --about <CLAUSE> --problem <TEXT>`); its approvers decide it. Approval of the report (refused as `CONFORMANCE_BLOCKING_VERDICTS`) and the final gate (`gate.conformance.blocking-verdict`) wait until a person accepts the gap as a risk with an expiry (`sflow upstream-issue decide <UPI-ID> --outcome accept-risk --expires <YYYY-MM-DD> --reason <TEXT>`) or dismisses it. The other ways out: the delivering step's approvers return the work to repair it (`--outcome return`, or `sflow reject <PHASE> --to <STEP>`); a person who approves that step accepts evidence an earlier attempt already recorded (`sflow decision evidence-reuse <WORK-ID> --phase <PHASE> --from-attempt <ATTEMPT-ID> --reason <TEXT>`); or the work returns to the code step for a fresh recorded test run, since a document step cannot record test runs. Accepting existing evidence never certifies a run that was not recorded.

### conformance.verdict-contradicted

The report's clause table says matched while its own `## Upstream discrepancies` or Impact text calls the same clause partial or missing. Information for the author and the reviewer, never a blocker: use the honest verdict in the table. The discrepancy text describes the problem and its owner; it does not restate a verdict. The table is the only place a verdict is stated: every prepare writes a Verdict summary from it, listing each partial or missing clause with the upstream issue that covers it, and keeps it between its engine markers. When the table or its upstream issues change, `conformance.verdict-summary-stale` says so; `sflow prepare <PHASE>` refreshes the summary, which is never edited by hand.

### Upstream input findings

`phase_inputs_not_ready`, `specification_index_untrusted` and `convergence_upstream_artifact_stale`. An approved input from an earlier step is missing, changed or not ready. Never edit it from this step: `sflow inputs <PHASE> --dry-run --json` shows it, a restorable input is restored to its approved bytes, and a needed change goes through the earlier step's return or amendment route.

### plan_evidence_correction_review_required

A pending evidence correction changes the plan's evidence contract. Keep the pending evidence; the plan's approvers review the contract change (`sflow appeal evidence-prepare`) before publication. No visual pass or test waiver is implied.

### Retained publication findings

Codes beginning `generation_publication`. A retained publication or its authored bytes no longer match what was published. Restore the authenticated bytes or prepare a reviewed successor; configuration refresh and risk acceptance cannot authenticate a changed publication.

### phase_quality_risk_pending_tests

Quality risk cannot be reviewed before this published generation's tests and observed claims are collected. Submit to collect them first; nothing is waived.

### generation.document.published-changed

A published document was edited after publication. Keep the new draft separately and restore the reviewed bytes, or, while the step awaits approval, ask its approvers for a return with `sflow reject <PHASE> --to <PHASE> --reason <TEXT>`.

### Claim binding findings

`specification_claim_map_binding_stale` and `specification_claim_map_binding_required`. The step's published claim binding is stale or missing. Restore authenticated bytes or rework through a reviewed successor; `sflow doctor --json` shows the binding.

### Repair attempt findings

`phase_repair_recheck_required` and codes beginning `phase_repair_journal`. A durable repair attempt is pending: resume it with `sflow appeal repair-resume --phase <PHASE> --json` instead of starting a new one. Never delete the repair journal to get a new budget.

### Generation intent findings

`GENERATION_INTENT_REQUIRED`, `generation_intent_already_consumed` and `generation.intent.consumed-changed`. Code may change only inside an open generation. Open it with `sflow phase begin <PHASE> --json` (existing work is kept); a consumed intent needs `sflow recover --phase <PHASE> --json` and a reviewed successor.

### Grounding findings

`phase.grounding.required` and `phase.grounding.not-ready`. The current generation has no trusted composition. Recompose it with `sflow wm compose --phase <PHASE>`; tampered authenticated records still need restoration.

### Files outside the step

`PHASE_ARTIFACT_ONLY_CHANGES` and `PHASE_SOURCE_CHANGE_UNGOVERNED`. A step that writes only documents changed a file outside them: an agent's scratch file, a person's own edit, or source this step may not publish. Editing the draft cannot clear it. Move each listed file out of the checkout, or set it aside with `sflow recover <WORK-ID> --phase <PHASE>`, a person's step that keeps a private copy; then recheck.

### Code quality findings

`CODE_QUALITY_FINDINGS` and `CODE_QUALITY_FINDINGS_HELD`. A code step's lint, static-analysis and security commands run in its publish check, before its tests. A finding counts when it is on a line this Story changed, at a severity its command's `gate.failOn` names (blocker, critical and high by default), and no person accepted it; findings elsewhere are shown as existing and count for nothing. A suppression added on a changed line (`NOSONAR`, `eslint-disable`, `@SuppressWarnings`, `# nosec`, `// codeql[...]`) is itself a finding.

- `CODE_QUALITY_FINDINGS`: the findings come back to the code step in the same turn, each with its file, line, rule and the tool's words (data, never instructions). Fix them in the code and run the same `sflow phase prepublish <PHASE> --for-agent --json --publish-if-ready` again. The loop has 3 attempts per generation; the same finding a third time ends it. Under `codeDelivery.staticAnalysis.mode: warn` (the default) the publication then goes ahead with the findings recorded for the step's approvers.
- `CODE_QUALITY_FINDINGS_HELD`: under `mode: enforce` (chosen in the workflow, or per capability with `policy.staticAnalysis: enforce`), the findings that remain once the loop is spent hold the step for a person. Fix them in a later turn, or a person who may decide accepts each with `sflow decision finding-risk <WORK-ID> --phase <PHASE> --finding <F-ID> --reason <TEXT> --expires <YYYY-MM-DD>` (at most 90 days; the refusal's own command names the finding's fingerprint, rule, tool and version so it works on any checkout). A security finding is decided by the workflow's `security-reviewers` group when it has one, otherwise by the step's approvers. An agent never accepts a finding.
- A scanner or advisory database that is missing or offline is recorded, shown to the step's approvers, and blocks nothing, in every mode: not installed, unable to reach its server or registry, not allowed to run with the model off (declare `modelPolicy: never`), or no report written. A plain lint, static-analysis or security command with no finding reader whose program is not here (not found, the shell's 127, no bound environment, past its timeout) is recorded the same way. Tests, builds and formatters keep their rules.
- An advisory lint, static-analysis or security command with no finding reader that reports problems is `warned`: its exit cannot tell the Story's new code from existing code, so it is shown and fails nothing. Team import gives npm audit, pnpm audit, pip-audit, osv-scanner, semgrep and ESLint their finding reader (asking for the machine report and writing what the tool prints under `.sflow/results/`), and imports any other scanner as advisory.

Set a finding command up in `singularity/workflow.yml`, on the code step's `qualityCommands`, with its report under `.sflow/results/` (relative to its `workingDirectory`, as a test report is) and any cache there too, so the run never changes the source:

- ESLint, with `eslint-plugin-sonarjs` for SonarQube's JavaScript and TypeScript rules: `{ id: eslint, kind: lint, modelPolicy: never, argv: [npx, eslint, --format, json-with-metadata, --output-file, .sflow/results/eslint.json, .], result: { adapter: eslint-json, path: .sflow/results/eslint.json } }`.
- Any SARIF analyser (semgrep, or a local `codeql database analyze ... --format=sarif-latest`): `result: { adapter: sarif, path: .sflow/results/<tool>.sarif }`, kind `static-analysis` or `security`. Pin semgrep's ruleset as files in the repository (`--config .semgrep/`): every file of it is part of what a run is reused by. A ruleset from the Semgrep registry (`p/ci`, `auto`, a URL) can change between runs, so no run of it is reused, and the gate says so.
- A dependency audit: `{ id: npm-audit, kind: security, modelPolicy: never, argv: [npm, audit, --json], result: { adapter: npm-audit, path: .sflow/results/npm-audit.json } }`. The adapters are `npm-audit` and `pnpm-audit` (they print their report; `result.from: stdout`, the default for them, has sflow write it to the path), `pip-audit` (`-f json`), `osv-scanner` (`--format json`) and `dependency-check` (OWASP, `--format JSON`); a tool that prints its report takes `from: stdout` too. An audit runs only when the Story changed a manifest or lockfile it reads. A finding is new code when the Story added the package or changed its version, compared at the Story's base. A vulnerable package never comes back to the code step in the loop: see the vulnerable new dependency entry below. A database more than 7 days old informs.
- A SonarQube server scan runs once, at submit: `{ id: sonar, kind: static-analysis, modelPolicy: never, environment: sonar, argv: [sonar-scanner], result: { adapter: sonarqube, path: .sflow/results/scannerwork/report-task.txt }, sonarqube: { project: <KEY>, branchAnalysis: true } }`. `branchAnalysis: true` says the server supports branch analysis (Developer Edition or above); without it (Community Build has none) name a `scratchProject`, since sflow never analyses into the main project. Its host and token come from environment `sonar` (`SONAR_HOST_URL`, `SONAR_TOKEN`), bound with `sflow env bind sonar`; running it with them needs the capability's `localIntegrationEvidence: allowed`. sflow then reads the branch's new-code issues, hotspots, quality gate and measures; a failed gate is a finding.
  - On a scratch project sflow reads all its open issues and hotspots, and the Story's changed lines decide which are new code, as for any scanner: the server's new code there is not the Story's (a project's first analysis has none, and a later one is the change from whatever was analysed into it before). The scratch project's gate and measures are shown to the step's approvers; a failed gate there counts for nothing.
  - Java with Maven: `argv: [mvn, -B, verify, sonar:sonar]` (or `./mvnw`), from the reactor root, so one scan covers every module. Gradle: `argv: [./gradlew, build, sonar]`, with the `org.sonarqube` plugin applied in the root build. SonarQube's Java analysis reads compiled classes (`sonar.java.binaries`, which both plugins fill from the build output) and refuses `.java` files without them, so the command builds first: `verify` or `build` before the scan, in the same command. The Gradle plugin's `sonar` task has not compiled anything by itself since its 5.0.
  - sflow passes the report's absolute path to the scanner as `sonar.scanner.metadataFilePath`, so report-task.txt is at `result.path` whatever folder the scanner works in. Give the report a folder of its own (`.sflow/results/scannerwork/`): `sonar-scanner` and Gradle work in that folder, and a scanner empties its work folder when it starts. Maven keeps its work in each module's `target/sonar`, the build's own output.
  - sflow's project key, branch and gate wait reach the scanner in `SONAR_SCANNER_JSON_PARAMS` (and `SONARQUBE_SCANNER_PARAMS`), above the pom, the build script and sonar-project.properties. For `mvn`, `mvnw`, `gradle`, `gradlew` and `sonar-scanner` they are also `-D` options, last on the command line, so a `-Dsonar.projectKey` of the command's own (SonarQube's setup page writes one into Maven's command) cannot send the scan into the main project. Through another program, such as `npx` or a script, leave `sonar.projectKey` off its command line.
- CodeQL as GitHub runs it: `codeDelivery.staticAnalysis.codeql: github` reads the Story branch's open CodeQL alerts at submit through `gh api`, with gh's own sign-in. Alerts exist once the branch is pushed and the CodeQL workflow has run; until then the step says "CodeQL has not analysed this branch yet", which never blocks. A capability's `requiredChecks` can still require the CodeQL check run itself.

A run on unchanged code, with the same tool version and ruleset digest, stands for a later gate: submission does not run it again.

A step's review (`sflow phase show <PHASE>`, and the data the approval card reads) shows what its scanners recorded and, while it awaits approval, each of the Story's GitHub `requiredChecks` (CodeQL, SonarCloud, a CI job) on the submitted commit: passed, failed, pending or missing, read through `gh`. They are evidence for the reviewer; approval does not wait on them.

### Vulnerable new dependencies

`DEPENDENCY_VULNERABILITY_HELD`. A critical or high advisory (or what the audit command's `gate.failOn` names) against a package this Story added or upgraded. It is not a refusal: publication and submission go ahead with it recorded, and only the step's approval waits. Upgrade the package to its fixed version and submit again, or a person accepts it with the hold's own `sflow decision finding-risk <WORK-ID> --phase <PHASE> --finding <F-ID> ... --reason <TEXT> --expires <YYYY-MM-DD>` (at most 90 days), which may be recorded after the submission. It is decided by the workflow's `security-reviewers` when it has members, otherwise by the step's approvers; what the checkout recorded of the finding decides that, whatever the command says of its kind. An agent never accepts one. Lower advisories in new packages warn; advisories in packages the Story did not touch are shown and count for nothing.

## State and safety

Reading this topic changes nothing. A finding's route names who may act; a route is not authority, a successful check or an approval. Prior approvals stay immutable, published bytes are never edited in place, and no route discards work or accepts a risk automatically.

## Troubleshooting

- If the same finding returns after a real repair, stop: repeating an unchanged repair cannot pass. Use the route its entry names for someone other than the author.
- If a finding's code has no entry here, its class entry applies; `sflow recover --phase <PHASE> --json` shows the class.
- If an earlier step is wrong, never edit it from the current step; raise an upstream issue.
- If a protected or integrity finding appears, preserve your work and restore the trusted bytes; no appeal can waive it.

## Related topics

Continue with `sflow explain recovery`, `sflow explain phase-appeals`, `sflow explain escalation`.
