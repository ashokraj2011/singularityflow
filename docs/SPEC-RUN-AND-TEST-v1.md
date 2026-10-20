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

## IDE-style run configurations (amendment, owner request 2026-10-19)

The owner asked that starting an application follow the IDEs people already use, for every platform:

| Platform | IDE | Its run configurations |
|---|---|---|
| Java, Kotlin | IntelliJ IDEA | `.run/*.run.xml`, `.idea/runConfigurations/*.xml`: Application, Spring Boot, Maven, Gradle |
| Python | PyCharm | the same files: Python (script or module), Django server, FastAPI/uvicorn |
| Node, TypeScript | WebStorm | the same files: Node.js, npm (script) |
| Go | GoLand | the same files: Go Build |
| .NET | Rider / Visual Studio | `Properties/launchSettings.json` profiles, Rider's `.run` files |
| any | VS Code | `.vscode/launch.json` (types java, python/debugpy, node/pwa-node, go, coreclr) |

Real applications need many options: JVM options, system properties, profiles, interpreter options,
program arguments, environment variables, a working directory and a debug port. A start entry already
holds any number of arguments (`argv`), and `environments.yml` already gives each environment its own
variables (for example `SPRING_PROFILES_ACTIVE`, `DJANGO_SETTINGS_MODULE` or `NODE_ENV` as flags with a
default, `DATABASE_URL` as an endpoint, passwords as secrets). Three things are added.

### 1. Arguments per environment

```yaml
start:
  - id: api
    argv: [./mvnw, -q, spring-boot:run]
    environments: [dev, qa]
    arguments:                      # appended to argv for the chosen environment
      dev: [-Dspring-boot.run.profiles=dev]
      qa:  [-Dspring-boot.run.profiles=qa, "-Dspring-boot.run.jvmArguments=-Xmx2g"]
```

- Each key must be one of the entry's `environments`.
- Each value is a list of 1 to 64 strings, validated like `argv`.
- `app plan` shows the resolved argv per environment, and `commandSha256` covers it, so a changed
  argument asks for confirmation again.
- A long or machine-specific option set may instead live in an argument file in a `localFiles`
  folder, e.g. `java @resources/dev/jvm.args`. It may change locally and is never committed.

### 2. Debug start

```yaml
    debug:
      runtime: java          # java | python | node | go | dotnet
      port: 5005             # loopback; defaults: java 5005, python 5678, node 9229, go 2345
      suspend: false         # java and node only: wait for the debugger before running
```

`app start <ID> --debug` starts the same entry with the runtime's debugger listening on `127.0.0.1`
only. How the listener is added depends on the launcher, detected from `argv`:

- **java**
  - `java …`: add `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:<port>`
    before `-jar` or the main class.
  - Maven `spring-boot:run`: merged into `-Dspring-boot.run.jvmArguments`, keeping any existing
    value.
  - Gradle `bootRun`: `--debug-jvm` is refused, because it binds every interface and suspends. Use
    `JAVA_TOOL_OPTIONS` with the agent string, set for the application process only.
- **python**: `python -m debugpy --listen 127.0.0.1:<port>` before the script or `-m module`, for
  example `uvicorn` or `manage.py runserver --noreload`. A missing `debugpy` is a coded refusal that
  names `pip install debugpy` for the person to run.
- **node** (as WebStorm does)
  - `node …`: add `--inspect=127.0.0.1:<port>` after `node`.
  - `npm`, `pnpm`, `yarn` and `npx` scripts: `NODE_OPTIONS=--inspect=127.0.0.1:<port>` for the
    application process only.
- **go**: `go run <pkg> <args>` becomes
  `dlv debug <pkg> --headless --listen=127.0.0.1:<port> --api-version=2 --accept-multiclient --continue -- <args>`.
  A missing `dlv` is a coded refusal.
- **dotnet**: no listener. The person attaches to the started process, whose pid `app status`
  reports.

An entry may give an explicit `debug.argv` (full replacement) or `debug.arguments` (appended)
instead. It may also set `debug.environment` with only `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS` or
`JDK_JAVA_OPTIONS`, whose value must be the debugger flag alone. Every debug address must be
loopback: a `0.0.0.0`, `*` or non-loopback address anywhere in the debug arguments is refused.

When the debugger port accepts connections, `app start --debug` prints `Debugger listening at
127.0.0.1:<port>`, then waits for the readiness check as usual. A suspended JVM becomes ready only
after attach. `app status` reports `debug: { runtime, port, listening }`.

### 3. Suggest entries from IDE run configurations

`singularity-flow app suggest [--capability ID] [--json]` is a read. It reads the files in the table
above, plus the platform's own markers when no IDE configuration exists (package.json scripts, the
Spring Boot Maven/Gradle plugin, `manage.py`, a FastAPI/uvicorn app, a Go `main` package, a .NET
project with launchSettings). It returns:

```json
{ "resultType": "sflow-app-suggestions", "capability": "payments-web",
  "suggestions": [{ "source": { "kind": "intellij|pycharm|webstorm|goland|rider|vscode|launch-settings|detected",
                                "file": ".run/Api.run.xml", "name": "Api (dev)" },
                    "start": { "id": "api", "argv": [], "workingDirectory": "services/api",
                               "url": "http://127.0.0.1:8080/", "ready": { "http": "/actuator/health", "timeoutMs": 180000 },
                               "arguments": {}, "debug": { "runtime": "java", "port": 5005 } },
                    "environmentNames": [{ "name": "SPRING_PROFILES_ACTIVE", "kind": "flag", "default": "dev" },
                                         { "name": "DB_PASSWORD", "kind": "secret" }],
                    "notes": ["IntelliJ computes the classpath; this runs through the Maven wrapper instead."] }],
  "applicationDraft": "<YAML for the capability's application block>",
  "environmentsDraft": "<YAML additions for singularity/environments.yml>" }
```

Rules:

- **Translation:** IDE-only launches become build-tool launches that work from a terminal, with
  options carried over. An IntelliJ Application or Spring Boot config becomes the Maven or Gradle
  run. A PyCharm config uses the project interpreter path relative to the repository (for example
  `.venv/bin/python`), else `python3`. A WebStorm npm config becomes `npm run <script>`.
- **Several configurations for one app**, for example "Api (dev)" and "Api (qa)", that differ only in
  arguments or variables, become one entry with `arguments` per environment when their names or
  profiles map to declared environments.
- **Secrets are never copied.** Any variable whose name looks secret (password, secret, token, key,
  credential, private) or whose value looks like one becomes a `secret` name with no value. The
  person binds it with `env bind`. A non-secret value becomes a `flag` default, or an `endpoint`
  value when it is a URL with no credentials. The suggestion output never contains a secret value.
- **Writing.** Nothing is written by `suggest`. The drafts go through the existing reviewed paths:
  - `capability set <ID> --application-file <FILE>` (local), or
    `capability edit <ID> --lead <URL> --application-file <FILE>` (proposal), for the application
    block;
  - the configuration proposal for `environments.yml`.

### Surfaces

- **VS Code**
  - The Run & test section gains "Suggest from run configurations". It lists the suggestions with
    their source files, and the person picks which to keep, then reviews and proposes them.
  - Each start entry gains **Start (debug)**. Once `Debugger listening` appears, VS Code attaches
    with a loopback attach configuration:
    - Java: `type: java`;
    - Python: `type: debugpy`, `connect` host and port;
    - Node: `type: node`;
    - Go: `type: go`, `mode: remote`;
    - .NET: a coreclr attach with the pid.
  - When the debugger extension for that language is missing, VS Code names the extension to install
    instead of failing silently.
- **Copilot:** `/sf-run-app` offers `--debug` and "suggest from run configurations". It shows the
  drafts and proposes them only on the person's confirmation.

### Milestones (amendment)

7. **Engine:**
   - per-environment `arguments`;
   - the `debug` block, `app start --debug` and `app status` debug state;
   - `app suggest` with readers for JetBrains `.run`/`.idea` XML, VS Code `launch.json` (with
     comments), .NET launchSettings and the detected platform markers;
   - `capability set|edit --application-file`.
8. **VS Code:** Start (debug) with attach, the Suggest list, and the arguments shown per environment.
9. **Copilot:** `/sf-run-app` debug and suggest.
10. **Verification:**
    - fixtures for Spring Boot (Maven), FastAPI, a Node npm script and a Go module;
    - a real VS Code check of debug attach for every runtime whose debugger is available on the
      machine; the others are reported as not verified.

## IntelliJ-style run configurations (amendment, owner request 2026-10-20: "a proper one like IntelliJ")

A start entry was a command line. People who use IntelliJ, PyCharm or WebStorm expect *typed* run
configurations, edited in a form, run from an always-visible run widget, with tests in the editor's
test tree. This amendment adds all three. Plain `argv` entries keep working unchanged as type
`command`.

### 1. Typed run configurations (engine)

```yaml
start:
  - id: api
    name: Api                       # display name; defaults to id
    type: spring-boot               # see the table
    launcher: maven                 # spring-boot: maven | gradle
    mainClass: com.example.api.ApiApplication
    vmOptions: [-Xmx1g, -Dfile.encoding=UTF-8]
    programArguments: [--server.port=8080]
    activeProfiles: [dev]
    workingDirectory: services/api
    env: { FEATURE_FLAGS: "a,b" }   # literal non-secret values only; secrets stay in environments.yml
    beforeLaunch:                   # optional, like IntelliJ's "Before launch"
      - argv: [../../mvnw, -q, compile]
    perEnvironment:                 # any field above, overridden per environment
      qa: { activeProfiles: [qa], vmOptions: [-Xmx2g] }
    environments: [dev, qa]
    url: http://127.0.0.1:8080/
    ready: { http: /actuator/health, timeoutMs: 180000 }
    debug: { port: 5005 }           # runtime follows from the type
```

| Type | Fields | Runs as |
|---|---|---|
| `spring-boot` | launcher, mainClass, vmOptions, programArguments, activeProfiles | Maven `spring-boot:run` (`-Dspring-boot.run.main-class`, `.jvmArguments`, `.arguments`, `.profiles`); Gradle `bootRun` (arguments via `--args`, JVM options and profiles through the same private init-script route the debugger uses) |
| `jar` | jar, vmOptions, programArguments | `java <vmOptions> -jar <jar> <programArguments>` |
| `application` | launcher (maven-exec \| gradle-run), mainClass, vmOptions, programArguments | Maven `exec:java -Dexec.mainClass=…`, or the Gradle `run` task |
| `maven` / `gradle` | goals or tasks, profiles, properties, arguments | the wrapper when present, else `mvn`/`gradle` |
| `python` | script or module, interpreter, interpreterOptions, parameters | `<interpreter> <interpreterOptions> <script \| -m module> <parameters>`; interpreter defaults to `.venv/bin/python`, then `python3` |
| `django` | manage (path), host, port, settings | `<python> manage.py runserver 127.0.0.1:<port>` (`--settings` when set) |
| `fastapi` / `flask` | app (`module:attribute`), port, reload | `<python> -m uvicorn <app> --host 127.0.0.1 --port <port>`; `flask --app … run --host 127.0.0.1` |
| `node` | script, nodeOptions, applicationParameters, nodeInterpreter | `node <nodeOptions> <script> <applicationParameters>` |
| `npm` | packageManager (npm \| pnpm \| yarn), script, arguments | `<pm> run <script> -- <arguments>` |
| `go` | kind (package \| file \| directory), target, goToolArguments, programArguments | `go run <goToolArguments> <target> <programArguments>` |
| `dotnet` | project, launchProfile, configuration, arguments | `dotnet run --project … [--launch-profile …] [-c …] -- <arguments>` |
| `command` | argv | as written (the existing form) |

Rules:

- Every field is validated as `argv` is: strings with no control characters, and repository-relative
  paths without `..`.
- Hosts are pinned to loopback where the type takes a host.
- `env` refuses reserved variables and any value that looks secret, as `app suggest` judges it.
- `beforeLaunch` steps run in order, and a failing step stops the start.
- `app plan` returns `type`, `name`, the fields, and per environment
  `resolved: { argv, envNames, beforeLaunch }`.
- `commandSha256` covers the resolved form. A field change asks for confirmation again.
- Debug injection uses the type: it knows where VM options or interpreter options go.
- `app suggest` emits typed entries when the source is typed. An IntelliJ Spring Boot configuration
  becomes `type: spring-boot` with its own fields, so it reads back as the person wrote it.
- **`app config preview --application-file <FILE> [--json]` (a read)** validates a whole application
  block and returns, per entry and environment, the resolved command line or the located errors. The
  editor shows it as IntelliJ shows "Command line" in its run configuration preview.
- **Writing** uses the existing `capability set|edit --application-file`.

### 2. VS Code: Run/Debug Configurations editor

**"Singularity Flow: Edit Run Configurations…"** opens a page laid out like IntelliJ's dialog. It is
also reachable from the run widget and from the capability page.

- **Left:** the configurations grouped by type with type icons, and a toolbar with these actions:
  - **Add**, from templates per type;
  - **Copy**, **Remove**, **Move up/down**;
  - **Import from IDE run configurations**, which uses `app suggest`.
- **Right:** a form for the selected configuration's type:
  - name, the type's fields, and working directory with a folder picker;
  - environment variables as a name/value table. Secrets are shown as "bound privately on this
    computer" with the `env bind` command and are never typed into the form;
  - **Before launch** steps;
  - URL and readiness, and debug port and suspend;
  - a tab strip **Base | dev | qa | …** for per-environment overrides, showing which fields differ.
- **Command line:** a read-only preview per environment, from `app config preview`, with inline errors.
- **Saving:** **Apply** / **OK** show a review page with the YAML diff of the application block, then
  write it through the existing local or proposal route. Unsaved changes are marked and kept across
  reloads of the page.

### 3. VS Code: run widget and Run view

- **Status bar run widget**, like IntelliJ's toolbar: `$(play) Api · dev`.
  - Clicking the name opens a quick pick of configurations and environments, plus "Edit
    Configurations…".
  - Next to it: **Run**, **Debug**, and **Stop** while running, which become **Rerun** and **Stop**
    once started.
  - Palette commands **Run Selected Configuration** / **Debug Selected Configuration** / **Stop**
    exist without default keybindings, because IntelliJ's macOS defaults clash with VS Code's;
    people can bind them.
- **"Run" view** in the Singularity Flow container, like IntelliJ's Services window:
  - one row per configuration, with a state icon (stopped, starting, ready, debugging, failed), the
    environment and the URL;
  - inline Run / Debug / Stop / Open in browser / Show log;
  - a context menu with Edit, Copy command line and Run in environment ▸.
- **Logs:** each run keeps its own terminal tab (existing tasks), named by configuration and
  environment.

### 4. VS Code: tests in the Testing view

A `vscode.tests` controller, **Singularity Flow**:

- **Tree:** one node per test command from `tests plan`, with its test cases from the latest
  `tests summary`, each with a file and line so VS Code shows ▶/✓/✗ beside each test.
- **Run profile:** runs `tests run --command <id>` for the selected commands (environment from the
  run widget). Each case's result comes from the new summary: passed, failed with its message,
  skipped, with duration.
- **"Re-run failed tests"** reruns the commands that have failures.
- **Labels:** results stay labelled by evidence class in the Test summary page. The Testing view
  shows the engine's label in each run's output.
- A debug profile for tests is out of this amendment.

### Milestones (amendment)

11. **Engine:**
    - the typed configurations and their resolution, per-environment overrides, `env` and
      `beforeLaunch`;
    - type-aware debug injection;
    - typed `app suggest`;
    - `app config preview`.
12. **VS Code:** the Run/Debug Configurations editor.
13. **VS Code:** the status bar run widget, the Run view, and the Testing view controller.
14. **Copilot and verification:**
    - `/sf-run-app` reads the typed plan;
    - a real VS Code check with Spring Boot (Maven, typed), Node (npm, typed) and a Python FastAPI
      fixture, as far as their tools exist here.
