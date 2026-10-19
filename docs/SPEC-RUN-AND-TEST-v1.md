# Run and test from a capability (RUN) — v1

Status: owner decisions recorded 2026-10-19; implementation in progress.

A person working on a capability can start its application, run its tests and read one summary of
every test case, from VS Code, Copilot or the Shell. All three use the same model-free commands.
Integration tests that need private values (endpoints, credentials, local resource files) can run on
the person's machine, and that run counts as evidence for the Story, labelled as a local run.

## Owner decisions (2026-10-19)

1. **Where the commands live.** The start commands and the capability's test selection live in
   `singularity/capabilities.yml`, edited through the normal reviewed capability proposal.
2. **Local runs as evidence.** A local run of an integration test counts as evidence for the Story.
   Local resources live in folders that may change on the person's machine and are never committed,
   and secrets never reach Git. This amends `docs/ENVIRONMENT-BINDINGS.md`, which kept
   environment-bound commands blocked until an isolated runner existed (see "Amendment" below).
3. **Surfaces.** VS Code and Copilot both start the application and run the tests.

## What already exists and is reused

- `singularity/environments.yml` (docs/ENVIRONMENT-BINDINGS.md) declares, per environment:
  - the names of the values it needs (`requires`: `secret`, `endpoint`, `flag`);
  - `localFiles`: globs for local resource files and folders, for example `resources/local/**` or `.env.qa`;
  - repository-wide `neverCommit` globs;
  - `checks`: which quality-command IDs need which environment.
  
  Commit and publication gates already refuse `localFiles` and `neverCommit` paths, even after
  `git add -f`. Values are bound privately with `singularity-flow env bind <ENV> --stdin`, stored
  below the Git common directory and never printed. **These are the "resource folders": no new file
  type is introduced.**
- Phase `qualityCommands` in `singularity/workflow.yml` hold every test command, in the object form
  (`id`, `kind`, `argv`, `workingDirectory`, `timeoutMs`, `result.adapter`, `result.path`). The test
  runner (`src/quality-command-runner.mjs`) and the report adapters already record each test case in
  an attempt's `occurrences[]`. The adapters `junit-xml`, `node-tap`, `jest-json` and `vitest-json`
  give results per test case. The others give totals only.
- `@ac:` / `@clause:` tags tie a test case to the requirement it proves (src/verification/).
- `repositoryReadiness.applicationStart` already runs a 5-second start smoke check.

## Configuration

### `singularity/capabilities.yml`: a new optional `application` block on a delivery capability

```yaml
capabilities:
  payments-web:
    kind: delivery
    repositories: [payments-web]
    application:
      start:
        - id: web
          repository: payments-web        # required when the capability has several repositories
          argv: [npm, run, dev, --, --host, 127.0.0.1, --port, "5173"]
          workingDirectory: apps/web      # repository-relative
          url: http://127.0.0.1:5173/     # loopback only: 127.0.0.1, localhost or [::1]
          ready: { http: /, timeoutMs: 90000 }   # or { log: "ready in", timeoutMs: 90000 }
          environments: [dev, qa]         # optional: environments.yml environments; the first is the default
      tests:                              # optional: absent means "what the code step runs"
        - use: module-tests               # a qualityCommands ID from workflow.yml
        - use: integration-tests
          environments: [dev, qa]         # optional: the environments this command may run against
    policy:
      localIntegrationEvidence: allowed   # off (default) | allowed; inherited parent → child
```

Rules:

- **`start[].argv`** is shell-free and non-empty. Its strings carry no control characters.
- **`id`** is lower-kebab case and unique within the capability.
- **`workingDirectory`** is repository-relative and must not contain `..`.
- **`url`** is `http` or `https`, on the host `127.0.0.1`, `localhost` or `[::1]`. It has no
  credentials, query or fragment.
- **`ready`** takes either `http` or `log`, never both.
  - `http` is a path starting with `/`. Ready means any HTTP response below 500.
  - `log` is literal text of at most 200 characters, matched in the process output.
- **`ready.timeoutMs`** is between 1,000 and 600,000.
- **`start[].environments` and `tests[].environments`** each list one or more environments declared
  in `environments.yml` (`dev`, `qa`, `uat`, …), without duplicates. The first is the default.
  A person picks one at run time with `--environment`. The chosen environment's bound values are
  given to that process only, as for an integration test below.
- **`tests[].use`** must name a `qualityCommands` ID that the code step resolves. This is checked when
  a run resolves it, because the workflow is a separate file. A missing ID refuses the run and names
  the IDs that are available.
- **`policy.localIntegrationEvidence`** is `off` or `allowed`. It is folded like the other policy
  fields: a child capability may turn it `off` but may not turn it `allowed` under an `off` parent.
- `schemas/capabilities.schema.json` gains these fields. It also gains the fields it already lacks:
  `jira`, `teams`, `appId`, `testConfigurationPaths` and `sourceHashExcludedRoots`.
- **Compatibility:** an older engine ignores fields it does not know in a capability. A test pins
  that.

No change to `environments.yml` or `workflow.yml` is required. An integration test is a quality
command linked to an environment: through `checks` in `environments.yml` (one environment), or
through `tests[].environments` here (several).

### Several environments (dev, qa, uat, …)

`environments.yml` already declares any number of environments. Each has its own value names, its
own `localFiles` (for example `resources/dev/**` and `resources/qa/**`) and its own private
binding (`env bind dev --stdin`, `env bind qa --stdin`). A run names one environment:

- **Which environments a run may use:** the start entry's or test entry's `environments`, else the
  single environment `checks` links to the command. Any other environment is refused, and the
  refusal names the allowed ones.
- **Default:** the first listed environment. VS Code remembers the last one chosen per capability.
- **What counts for a Story.** When `checks` links the command to an environment, only a run in that
  environment counts for the step's obligation. Without a `checks` link, a run in any of the
  command's declared environments counts. The receipt and every label name the environment used,
  for example "Local integration run …, environment `dev` …".
- **A run in another environment** is still shown, labelled with its environment and "does not count
  for this step: it requires `qa`".

## Evidence classes

| Class | Produced by | Counts for a Story | Label shown everywhere |
|---|---|---|---|
| `governed` | publish and submit running a command with no environment (as today) | yes, as today | none (unchanged) |
| `local-integration` | an environment-linked quality command run on the person's machine, with its private values given to that process only, when the capability policy is `allowed` | yes, for that command's obligation | "Local integration run by <identity>, environment `qa`, commit `<abc1234>`; values never recorded" |
| `local-preview` | `tests run --capability` outside a Story | never | "Local preview, not evidence" |

Rules for `local-integration`:

1. **Which commands qualify:** only commands linked to an environment, either through
   `environments.yml` `checks` or the command's own `environment` field. Commands with no environment
   still run in publish and submit exactly as today.
2. **The binding must be complete** (`env status` says `bound`). A missing or partial binding stays
   `unavailable`, never `passed`, as today.
3. **Where values go:** into the child process environment only. They never go into argv, a file,
   the worktree, a receipt, a log, a prompt or an export. Before stored or printed output is
   bounded, every bound `secret` value of 4 or more characters in stdout or stderr is replaced with
   `[redacted:NAME]`.
4. **Source binding is unchanged:** the candidate is a commit and tree. Paths matching `localFiles`
   or `neverCommit` are never committed, so they never change the candidate. The run is still
   refused when tracked source differs from the candidate.
5. **The receipt** is the existing attempt shape plus:
   - `evidenceClass: 'local-integration'`;
   - the existing safe environment metadata: name, declaration SHA-256, binding revision and
     fingerprint, and the names of the requirements present;
   - `ranBy`: the actor key, as approvals record it.
6. **At the gate.** When the policy is `allowed` and the binding is complete, publish and submit run
   an environment-linked command through the same runner and record it as `local-integration`. They
   no longer refuse with `ENVIRONMENT_ISOLATED_RUNNER_REQUIRED`. When the policy is `off`, the
   behaviour is unchanged, and the refusal now names the policy switch and who changes it (a
   capability proposal).
7. **Surfaces.** The approval page, the evidence matrix, the test summary and the decision list show
   the label. A reviewer is never told a governed run happened when it did not.
8. **Who may bind values.** Copilot may run tests and start the application. It never runs
   `env bind`: values come only from the person's own secret helper, on standard input.

### Amendment to docs/ENVIRONMENT-BINDINGS.md

The adopted text ("Environment-bound commands therefore remain blocked until an approved isolated
runner is active. The product does not inject secrets into the application worktree or relabel local
execution as governed evidence.") becomes:

> Environment-linked commands run only when the capability policy `localIntegrationEvidence` is
> `allowed` and the binding is complete. Values go to that command's process only, never to the
> worktree. Output is redacted. The run is recorded as `local-integration`, never relabelled as
> governed or isolated evidence. With the policy `off` (the default), they stay blocked.

## Commands (model-free; Shell, VS Code and Copilot use the same ones)

- **`singularity-flow app plan [START-ID] [--capability ID] [--json]`** returns
  `{ capability, repository, id, argv, workingDirectory, url, ready, environments: [{ name, status, default }], commandSha256 }`
  for each start entry, or for the one named. When `--capability` is omitted, the capability is the
  one that owns the current checkout.
- **`singularity-flow app start [START-ID] [--capability ID] [--environment ENV]`** runs the
  application in the foreground, with the chosen environment's values (if any) given to that process
  only.
  - It prints `Ready at <url>` once the readiness check passes, or a coded refusal after the timeout,
    which also stops the process.
  - Ctrl+C or `app stop` stops the whole process tree.
  - It keeps a private run record (pid, url, start time, commandSha256) under the Git common
    directory at `singularity-flow/app/<capability>/<id>.json`.
- **`singularity-flow app status [--capability ID] [--json]`** lists each start entry: declared,
  started (pid alive), ready (URL responds), and the URL.
- **`singularity-flow app stop [START-ID] [--capability ID]`** stops only a process that `app start`
  recorded.
- **`singularity-flow tests run [--capability ID | --work-id ID [--phase PHASE]] [--command ID]... [--environment ENV] [--json]`**
  resolves the commands: the capability's `tests`, or what the code step runs, or the named
  commands.
  - **Capability scope** saves a `local-preview` run under the Git common directory at
    `singularity-flow/test-runs/<capability>/<RUN-ID>.json`, keeping the last 20 runs.
  - **Story scope** stages attempts for that phase, as publish preflight does. Environment-linked
    commands become `local-integration` when allowed.
  - It prints totals per command and the `tests summary` command to read next.
- **`singularity-flow tests summary [--capability ID | --work-id ID [--phase PHASE]] [--run RUN-ID] [--json]`**
  returns one read model:

  ```json
  { "resultType": "sflow-test-summary", "schemaVersion": 1,
    "scope": { "kind": "capability|story", "capability": "payments-web", "workId": null, "phase": null },
    "run": { "id": "RUN-…|TA-…", "evidenceClass": "local-preview|local-integration|governed",
             "label": "…", "environment": "dev|null", "countsForStep": true,
             "startedAt": "…", "commit": "…", "uncommittedChanges": false, "ranBy": "…" },
    "totals": { "discovered": 0, "passed": 0, "failed": 0, "skipped": 0, "flaky": 0, "durationMs": 0 },
    "commands": [{ "id": "module-tests", "kind": "test", "adapter": "junit-xml", "status": "passed",
                   "exitCode": 0, "tests": { }, "perCase": true, "note": null }],
    "cases": [{ "command": "module-tests", "suite": "…", "name": "…", "file": "…", "line": 12,
                "outcome": "passed|failed|skipped|flaky", "durationMs": 5, "clauses": ["W-1:AC-001"] }],
    "truncated": false, "untagged": 3,
    "history": [{ "runId": "…", "at": "…", "evidenceClass": "…", "totals": { } }] }
  ```

  The case list stops at 5,000 entries (`truncated: true`). For an adapter that gives totals only, a
  command shows `perCase: false` with a note naming the report format that would give test cases.
  Clause tags come from the same scanners and join used by the evidence matrix.

`tests` and `app` are new top-level commands, registered with their read and mutation
classification. `plan`, `status` and `summary` are reads. `start`, `stop` and `run` execute code and
are never cached.

## VS Code

- **Capability page:** a "Run & test" section for a delivery capability whose repository is the open
  checkout.
  - For each start entry: Start, Stop and Open in browser, with the readiness state shown.
  - Run tests: all, or one command.
  - The last run in one line, with "Open test summary".
- **Environment picker:** for each environment, shows whether it is bound ("qa: not bound"). An
  unbound one shows the command to run with the person's own secret helper,
  `singularity-flow env bind qa --stdin`; VS Code never asks for or holds a value.
- **Starting:** runs `singularity-flow app start <id>` as a VS Code task (a process execution with
  argv, never a shell string). Its terminal shows the log, Stop ends the task, and the page reads
  `app status --json`.
- **Test summary page** (lazy panels):
  - totals;
  - per-command tables of test cases: outcome, duration, file link to the line, and requirement tags;
  - "failed only" and "untagged" filters;
  - a run picker that labels each run by evidence class.
  
  It opens from the capability page and from a Story step (Story scope).
- **Safety:**
  - Nothing runs in an untrusted workspace.
  - The first run of each `commandSha256` asks for confirmation, remembered per workspace, and
    asks again when the command changes.
  - Values are never shown.

## Copilot

- `/sf-run-app` (start, status, stop) and `/sf-test` (run and summarise) are guided skills. When
  several environments are allowed and none was named, they ask which one.
- The authoring turns' local-verification guidance names `app plan` and `app start` and
  `tests run`, instead of letting the agent guess a dev command.
- The Copilot guard permits `app plan|start|status|stop` and `tests run|summary` in authoring turns
  and in these two skills' turns. It never permits `env bind`.
- Visual capture defaults its target URL to the declared start entry's `url`.

## Milestones

1. **Engine: configuration and application.**
   - The `application` block, its validation and the schema.
   - `app plan|start|status|stop`.
   - The readiness smoke check uses a declared start entry when one exists.
2. **Engine: tests.**
   - `tests run` (capability and Story scope) and the local preview run store.
   - The `tests summary` read model.
3. **Engine: local integration evidence.**
   - The `localIntegrationEvidence` policy.
   - Giving values to the process only, with output redaction.
   - The `local-integration` class at the gate and on every surface.
   - The amendment to ENVIRONMENT-BINDINGS.md.
4. **VS Code:** the "Run & test" section, the tasks, the Test summary page, and the confirmations.
5. **Copilot:** the skills, the guard and the authoring guidance.
6. **Verification:** a real VS Code check against a Vite fixture and a JUnit fixture, plus docs and
   bundle budgets.
