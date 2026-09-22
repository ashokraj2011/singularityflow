# Environment bindings (ENV)

Status: adopted with security amendments

Environment bindings let a repository declare the *names* needed by QA, UAT, or another runtime without putting their values in Git. The committed authority is `singularity/environments.yml`; a machine-local binding is stored below the repository's Git common directory and is shared by that repository's worktrees. Values are never included in command arguments, JSON output, prompts, receipts, exports, or bundles.

## Adopted contract

The repository declaration has a closed, versioned shape:

```yaml
schemaVersion: 1
environments:
  qa:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://qa.example.test" }
      - { name: DB_CONN, kind: secret }
      - { name: FEATURE_X, kind: flag, default: "off" }
    localFiles:
      - config/qa.local.yml
      - .env.qa
checks:
  integration-tests: { environment: qa }
neverCommit:
  - "**/*.local.yml"
  - ".env.*"
```

`checks` links an environment to an existing governed quality-command ID. It does not contain a shell command. Secret requirements cannot have `value` or `default`. Shared endpoint URLs cannot contain credentials, a query, or a fragment. Environment variables that can change the loader, executable search path, Git transport, or runtime injection behavior are reserved and refused.

Bindings are supplied on standard input so a value does not enter shell history or the process argument list:

```sh
your-approved-secret-helper --format sflow-env-json qa | singularity-flow env bind qa --stdin
singularity-flow env status --json
singularity-flow env audit --json
singularity-flow env unbind qa
```

The input has the closed shape `{"bindings":{"DB_CONN":{"source":"local","value":"<supplied privately>"}}}`. The CLI refuses interactive TTY input so a value is not echoed into terminal scrollback. Pipe it from an organisation-approved secret helper; do not put a real value in the command, a shell here-document, documentation, or Copilot Chat. A reference binding records only an opaque provider reference; an unresolved provider remains `unavailable` and never becomes a passing check.

## Safety boundaries

- The declaration is approved configuration and is included in the configuration overlay. A binding is tied to the repository, the exact declaration digest, and an opaque binding revision. Changing the declaration makes the old binding unavailable rather than silently reinterpreting it.
- Private binding records use hardened sidecar storage, atomic replacement, POSIX `0700/0600`, and enforced Windows ACLs. Status and audit output contain names and fingerprints only.
- Secret rotation changes the opaque binding revision. No secret-derived hash is stored.
- `localFiles` and `neverCommit` are enforced by candidate/publication gates even when `git add -f` bypasses `.gitignore`. Document intake refuses matching input before copying it into governed artifacts.
- The draft proposed rewriting `.gitignore` during initialization. The adopted design does not mutate an application checkout merely to mirror policy: teams may add those convenience ignores themselves, while exact-tree Git gates enforce the declaration whether or not an ignore rule exists.
- Environment-local files are excluded before World Model or packet content is read. The declaration is safe input; the declared local content is not.
- A missing or partial binding is `unavailable`, never `passed`, and the required gate remains owed.
- The current developer-local signed runner is not an isolated evidence runner. Environment-bound commands therefore remain blocked until an approved isolated runner is active. The product does not inject secrets into the application worktree or relabel local execution as governed evidence.

## Fingerprints and evidence

Safe environment metadata may contain:

- environment name;
- declaration SHA-256;
- bound requirement names;
- endpoint-only SHA-256 aggregate;
- names of secret requirements present;
- binding source class;
- opaque binding revision and resulting environment fingerprint.

It may not contain a value, a secret hash, a provider error message, or a reusable provider reference. Existing GDP `environmentSha256` fields retain their historical host-attestation meaning; ENV uses distinct metadata and does not reinterpret signed records.

## Delivery boundary

This adoption implements the declaration, hardened local binding/status/audit surface, commit and document admission, World Model exclusion, quality-command linkage, and explicit unavailable behavior. Declaration changes use the normal approved-configuration proposal path; there is deliberately no `env declare` shortcut that silently edits authority. Actual secret resolution and materialization are enabled only through a separately approved isolated-runner authority with bounded output redaction and cleanup evidence. Until then, refusing execution is the intended safe behavior, not missing functionality disguised as success.
