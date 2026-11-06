# Environment files (ENVF) — v2: what is private without setup

Status: owner decisions recorded 2026-11-05. It extends `docs/SPEC-ENVIRONMENT-FILES-v1.md`, which still
holds for the private store, placement and the `env files` commands.

v1 protects a file once someone has registered it. Before that nothing does: in a repository with no
declaration, Copilot can read `.env`, the secret scan passes `.env` and an unquoted `password: Xq7m…` in
`application.yml`, and a commit takes them. People put real keys in config files to test with, and they
expect those keys to stay on their laptop whether or not they remembered to set anything up.

## Owner decisions (2026-11-05)

1. **Copilot and a value in shared config.** Copilot does not read or edit a shared config file that holds
   a real value, until the value is moved out. A file with no value stays readable.
2. **A tracked file.** Commit `${NAME}` and keep the value in an always-local file or an environment
   binding. A private copy over a tracked file is a later step, only for a framework that cannot read
   `${VAR}`, because hiding changes to a tracked file is risky.
3. **Rollout.** First decided as a warning for one release, then changed the same day: a commit refuses a new
   value straight away, as it does an always-local name.
4. **Classification.** A `.env.*` file is not judged by its name alone. It is private until a person classifies
   it as shared, and its values are read either way.

Decided 2026-11-06:

5. **Plain chats.** A Copilot chat with no `/sf-` command gets the same refusals, and a capability can turn that
   off. See "Plain chats" below.
6. **Attachments.** The repository never holds a secret. What SFlow can read it scans, and what it cannot read
   stays out of Git. See "Attachments" below.

## Model

Every file is one of four kinds. The first match wins.

| Kind | Examples | Rule |
|---|---|---|
| Template | `.env.example`, `.env.local.example`, and the same with `sample`, `template`, `tmpl`, `dist`, `defaults` or `schema` | Shared. Its values are read like any shared config, so a real key in one is still found. |
| Always local | `.env`, `.env.*`, `application-local.yml\|yaml\|properties`, `*.local.yml\|yaml\|json\|properties\|toml\|ini` | Never added to Git, never shown to Copilot, never a document or a specification source. Needs no setup. A repository can add to this list with `neverCommit`, and cannot remove from it. A file with one of these names that a team already tracks stays shared config. |
| Declared local | `localFiles`, `neverCommit`, the personal registry | As v1. A class does not override it. |
| Classified shared | An always-local name with `sflow-shared: <why>` in its first ten lines | Treated as shared config. Git can carry it, Copilot can read it, and its values are read. |
| Shared config | `*.yml`, `*.yaml`, `*.properties`, `*.toml`, `*.ini`, `*.cfg`, `*.conf`, `*.env`, `.envrc`, and settings JSON by name (`appsettings*.json`, `config*.json`, `*.config.json`, `local.settings.json`, …) | Can be committed. Its values are read, including under test folders such as `src/test/resources`. |

Names are matched by file name in any folder, ignoring case.

### What counts as a value

A shared config file is read setting by setting, whichever way it is written: YAML with or without
quotes, a `- NAME=value` list item, a Kubernetes `name:` and `value:` pair, `.properties`, INI, TOML, env
style and settings JSON. Both the name and the value have to say so.

| Setting | Result | Why |
|---|---|---|
| `password: Xq7mA2pLz9vB` | Value | The name ends in a credential word and the value is real |
| `spring.datasource.password=Xq7mA2pLz9vB` | Value | Same, with a dotted name |
| `api-key: abc123xyz987LMNopq456` | Value | `key` with a qualifier |
| `key: abc123xyz987LMNopq456` | Value | `key` alone, with a token's shape |
| `password: ${DB_PASSWORD}` | Not a value | A reference |
| `password: ${DB_PASSWORD:Xq7mA2pLz9vB}` | Value | A reference whose default is real |
| `password: ENC(…)`, `{cipher}…`, `vault:…`, `arn:…` | Not a value | Encrypted, or a pointer to a secret store |
| `password: changeme`, `<your-key>`, `****` | Not a value | Written as a placeholder |
| `password: postgres`, `password: test1234`, `password: abc` | Not a value | A local fixture, not a credential |
| `password: Password`, `existingSecret: my-secret-v2`, `DB_CREDENTIALS` | Not a value | A label or a name |
| `client-key: certs/client.key`, `secret: kv/data/app`, `public-key: …` | Not a value | A path, a store path, or public |
| `token_ttl: 3600`, `auth_mode: oauth`, `secret_name: prod-db-2` | Not a value | A setting about a credential |
| `checksum: 3fa85f64…` | Not a value | No credential word in its name, outside an env-style file |
| `SIGNING_SALT=Zq7vK2mP…` in a `.env*` file | Value | An env-style file holds little else, so a token's shape is enough |
| `url: https://x.io/a?sig=Zx9fK2mQ7vLp4Tn8` | Value | A link is judged by its parameter and its value |
| `url: https://x.io/a?auth=true` | Not a value | Same rule |
| `Db: Server=x;Password=Xq7mA2pLz9vB;` | Value | A connection string carrying a password |

The scanner's rules for known provider keys and quoted credentials still run on every file, so nothing it
caught before is lost. Other formats, such as XML, keep only those rules for now.

## Who does what

| Point | Always local | Value in shared config |
|---|---|---|
| Commit and publication gates | A change that adds one is refused, even after `git add -f`, unless it is classified shared. | A new value is refused. One already in Git warns on stderr. |
| `secrets scan --staged` and the pre-commit hook | Refused | Same as the gates |
| Git's own view | Listed once in the clone's `.git/info/exclude`, so it never shows as a change. The team's `.gitignore` is never edited. | None |
| Copilot | Refused by file tools, search globs and shell lines that name one, whether or not it exists. `echo`, `ls`, `test`, a search for the text, `git status` and `git rm --cached` stay allowed. | Refused until the value is gone. |
| Documents and specification sources | Refused | Refused now, because a document reaches a model. |
| World Model, grounding and knowledge reads | Skipped | Unchanged |
| `env audit` | Reported if tracked, with advice to classify it | Reported, in the working tree, the index and the last publication |

`env audit` works with no declaration. A value already in the last publication is reported as being in
Git's history: the advice is to rotate it. History is never rewritten automatically.

A declared rule covers the whole tree, as in v1. An always-local name covers only what a change adds, so
a repository that was committing yesterday still commits. A file a team already tracks, such as
`tsconfig.local.json` or `.env.development`, can be edited and merged. Its values are read as shared
config, Copilot can read it if it holds none, and `env audit` asks for its class.

## Classification

A team may deliberately keep non-secret test defaults in `.env.test`, and a laptop may keep real keys in a
file with the same name. Only a person knows which, so the class is theirs to record.

| Class | Means | Where it comes from |
|---|---|---|
| `private` | Stays on this laptop | The default for an untracked file |
| `shared` | Git can carry it | `singularity-flow env files classify <PATH> shared --reason <why>` |
| `unclassified` | Tracked, with nobody having said why | A tracked file with no marker. It keeps working, and `env audit` asks. |

`env files classify` with no path lists each file, its class, how many real-looking values it holds and what
to do next. It names settings and never prints a value. When a commit refuses a new `.env.test`, the refusal
names this command.

Classifying as shared writes `# sflow-shared: <why>` as the file's first line, so the decision shows in the
diff, is reviewed and travels with the file, and it lets that one path back in through `.git/info/exclude`. It is
refused while the file holds a real value, and the refusal names the settings to move. JSON has no comments, so
a person adds `"_note": "sflow-shared: <why>"` by hand. Classifying as `private` removes the marker and the
exclude line, and says to run `git rm --cached` if Git still tracks the file.

Copilot may not run it: what may leave the laptop is a person's call. A class never stops the value check, so a
key pasted into a shared `.env.test` later is refused at the commit like any other. A classified file is still
refused as a document or a specification source, because nothing needs one to be.

The class lives in the file rather than in `singularity/environments.yml` because that schema is strict, so an
older engine would refuse the whole declaration over a new key, and because a file that travels with its own
decision cannot drift from a list kept elsewhere.

### Plain chats

The rest of the guard runs only in a `/sf-` turn. This check also runs in a chat with no `/sf-` command, because
a real run on 2026-11-05 showed `.env` and `application.yml` values reaching the model there.

- **Where it applies.** A file in a repository that uses SFlow: one with `singularity/workflow.yml`,
  `capabilities.yml` or `environments.yml`, SFlow's private folder under `.git`, or an `sflow/config` branch. The
  plugin runs in every chat on the machine, so `.env` in an unrelated project or in no repository is left alone.
- **The setting.** `policy.plainChatSecrets` on a capability: `refuse` (the default) or `allow`. The capability that
  owns the file decides, so one service can allow while the rest of the repository refuses. A child may refuse under
  a parent that allows, and allowing under a parent that refuses is rejected when the map is validated. A `/sf-` turn
  always refuses, whatever this says.
- **How it changes.** `singularity-flow capability plain-chat <ID> --secrets refuse|allow|inherit`, `--plain-chat-secrets`
  on `capability set|edit`, or **Secrets in plain chats** on the capability page in VS Code. In a repository with
  `sflow/config` it is a reviewed proposal, and it applies once the proposal is merged and this clone has fetched it.
  `capability show` says which applies to a path.
- **What it reads.** The approved map on this machine, with no network, and only for a call that would be refused,
  so an ordinary call pays nothing for it. An edit to `singularity/capabilities.yml` in a checkout does not stand in
  for `sflow/config`. A repository with no such branch has only its working-tree map. A map that cannot be read leaves the
  refusal standing.
- **Pause.** `/sf-pause` asks for native Copilot on this machine, so it turns this check off too.
- **A failure.** If the check itself fails, the call goes ahead. A plain chat is someone's ordinary work, and the launcher
  already refuses when the runtime cannot load.

Copilot runs the guard before every tool in every chat, and starting Node takes 100-180 ms, so with no turn recorded
the launchers look at the call first. They start Node for a name that could be private: a dotfile such as `.env`, a settings
or key extension (`yml`, `yaml`, `properties`, `toml`, `ini`, `cfg`, `conf`, `env`, `json`, `pem`, `key`, `p12`, `pfx`,
`jks`, `keystore`) or the word `secret` or `credential`. A false match costs one Node start. A declared file with none of
these in its name, such as `config/uat.txt`, is therefore not seen in a plain chat, though a `/sf-` turn still refuses it.

### Attachments

A document, an Epic source or a note can reach Git and a model, so each is checked before anything is stored.

| What is attached | In Git | On this laptop only |
|---|---|---|
| Text of any kind, including Markdown, CSV, SQL, logs and SVG | Scanned. A value is refused | Scanned. A value is refused |
| Word, Excel and PowerPoint | Their extracted text is scanned. One with no text is refused | Their extracted text is scanned |
| A PDF, an image, an archive, or an older `.doc`, `.xls` or `.ppt` | Refused: SFlow cannot read it | Kept. It never leaves the laptop |
| A file with an always-local name | Refused | Refused |

An attachment's text is read more closely than a source file: a value in a sentence (`the password is …`), a setting
in any text file and SQL's `IDENTIFIED BY '…'` all count, with the same waiver marker. Markdown, text, log, CSV and SQL
files get the same reading at a commit. A value already in Git warns there, as it does in shared config.

- **Story documents.** `documents upload`, `documents fetch` and `--document` at `start` follow the table, and so
  does moving a local document into Git. VS Code does not offer Git for a file it would refuse. Another clone lists a
  local document as unavailable, which is the cost of this rule.
- **Epic sources.** `epic sources add` and `note` are scanned too. The `local` provider commits what it is given, so it
  follows the Git column: a PDF brief is saved as text or a Word document, pasted with `epic sources note`, or pinned with
  a provider that holds bytes outside Git. Those providers are scanned the same way and take binary files unread.
- **Already in Git.** Nothing is moved or deleted. A file committed earlier stays in history until a person removes it.

These still reach Git unread, and the spec does not claim otherwise:

- A PDF, image or archive added to the application's own code by a commit. Applications ship such files, so the gate
  skips them.
- A viewable file in a reviewed agent folder, and the evidence screenshot an Outcome sign-off commits.

### Searches

A search can print the line that holds a value without naming the file: a real run of `grep -rn password .` put an
`application.yml` value in the session log. So a search is refused when its pattern would match a line holding a real
value, in a file it would read, and for a search that reads hidden files (`grep -r`, `rg --hidden`, VS Code's search
tool), any line of an always-local file. The refusal names the file and line, never the value, and says how to search
without it. Everything else runs:

- A search for words with no credential in them. Only a pattern with `pass`, `pwd`, `secret`, `credential`, `token`,
  `key` or `auth` is checked, in `/sf-` turns and plain chats alike, so a pattern as broad as `.` is not seen.
- A search with no matching line, or one that leaves the file out: `--exclude`, `--exclude-dir`, `-g '!x'`, `':!x'`, a
  narrower folder, an include pattern.
- A search that shows only names or counts: `-l`, `-L`, `-c`, `-q`, `output_mode: files_with_matches`.

The check walks at most 20,000 entries and skips `.git`, `node_modules`, `dist`, `build`, `target`, `out`, `vendor`,
`.venv`, `venv`, `__pycache__`, `.gradle`, `.idea`, `coverage`, `.next`, `.sflow` and `.singularity-flow`. A plain chat
and the launchers treat it like any other secrets check: a repository that does not use SFlow is left alone, a capability
can allow it, and a failure lets the search run.

### Hosts

Each host reads hooks from its own place and reads the answer in its own shape, so a guard can run and still do nothing.

| Host | Where hooks come from | What it obeys | Result |
|---|---|---|---|
| Copilot CLI | The installed plugin | `permissionDecision` at the top level | Checked in real chats |
| VS Code's default chat (Local) | The installed plugin in `~/.copilot` | `hookSpecificOutput.permissionDecision` only, ignoring the top level without a word | Checked in real chats since this was added. Before it, every SFlow refusal ran the tool anyway |
| IntelliJ (Copilot plugin 1.10.1) | Only `<workspace>/.github/hooks/*.json`, not the plugin | `permissionDecision` at the top level | SFlow writes no such file, so no guard runs. Its calls carry no session ID, so a hook could give the plain-chat checks and no `/sf-` turn rules |

`hookAnswerForEveryHost` writes both shapes. A real `/sf-phase` in VS Code recorded its clarification, wrote the specification and
published with no refusal.

### What the Copilot check cannot see

It reads what a call says. These still get through, and the spec does not claim otherwise:

- A path in a variable or a script, or a shared config file reached through `cd` first. A search from another folder after `cd` is judged from the first.
- Other ways of printing many files, such as `cat **/*.yml` or `find . -exec cat`, and a search whose pattern has no credential word.
- A running program that reads the file for itself. `source .env` and `--env-file .env` are refused because
  they name it; a test command that loads it is not.
- A file attached to the chat itself. In VS Code, Add Context on `.env` put its value in front of the model with no tool
  call, in a real run, so no tool guard sees it. Typing `#file:.env` without picking the file attaches nothing.
- A local attachment the model opens. A PDF kept on this laptop stays out of Git, but SFlow offers it to the step, and VS Code
  can open it in its browser tool after asking the person.

## Nothing dead-ends

Each refusal gives one way forward, and testing keeps working.

- **An untracked file with a value.** `singularity-flow env files add <ENV> <PATH> --personal`, then
  `env files adopt <ENV> <PATH>`, moves it to the private store and links it back. With no declaration, any
  environment name will do.
- **A tracked file.** Commit `${NAME}` and keep the value in an always-local file such as
  `application-local.yml` or `.env`, or in `env bind` where the repository declares that name.
- **An always-local file that was committed.** `git rm --cached <PATH>`, then a commit that names no paths,
  keeps the local copy, and the gates let that removal through. Copilot may run it.
- **A file the team means to share.** `singularity-flow env files classify <PATH> shared --reason <why>`.
- **A value already in Git.** It does not stop the commit. The warning says to rotate it and move it out.
- **A false alarm.** A person puts `# sflow-allow-secret: <why>` on the line or the line above it. On the line
  above is the safe place in a `.properties` file, and in JSON a neighbouring `"_note"` string carries it. It
  appears in the diff and is reviewed. It clears the commit warning and the Copilot refusal for that line.

A scan that cannot read a file still fails closed at the commit, as before. The Copilot check does not: a
file it cannot read or that is over 256 KiB is left to the existing rules.

## What a commit refuses

`CONFIG_VALUES_DEFAULT` in `src/config-values.mjs` is `refuse`. `SINGULARITY_FLOW_CONFIG_VALUES=warn` holds that
off for a machine or a CI job that needs time.

A commit refuses a value that is new to Git. The same name and value already at `HEAD`, at a merge's other
side or at a publication's baseline only warns, because refusing it would stop a merge or an unrelated edit and
take it out of no clone. Those copies are read only when there is a finding, so most commits pay nothing.

## Later

- A private local copy over a tracked file, for frameworks that cannot read `${VAR}` (decision 2).
- XML settings, such as Maven's `settings.xml`, and YAML block scalars, next-line values and flow maps.
- A VS Code view of the findings. Until then the warning is on stderr and in `env audit`.
