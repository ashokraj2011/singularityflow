# Local tests and application verification

An admitted authoring turn may run local tests and start the application for browser or
screenshot verification. A VS Code task is optional. The native terminal/process tools can run
repository-declared commands from the verified Story checkout on macOS and Windows.

The phase entry reports this in `mutationContract.toolProtocol.localVerification`. It follows
the phase's pinned authoring policy, not a hardcoded phase name: code, verification, scenario
checking and custom authoring steps share the same protocol. The prompt-submission hook delivers
the protocol before the first terminal attempt.

## Boundaries

- SFlow lifecycle commands still run standalone. Shell wrappers cannot approve, publish or change
  governed state outside the existing kernel operations.
- Ordinary authoring shell commands retain before/after content checks. Local verification does
  not grant application edits to an artifact-only phase, or edits to protected configuration.
- Start the app from this checkout, on loopback and a free port. Keep the terminal/session handle
  and stop only the process started for this verification, including after a failed browser check.
  Do not kill unrelated processes or use another checkout's already-running server.
- Save genuine screenshots at the exact authorized evidence paths. Starting an app or creating an
  image is not a visual acceptance verdict.
- Diagnostic tests report their actual command, cwd, exit status and failures. They never replace
  the fresh governed tests required by publication/submission, or count as human approval.
- Independent source-review, publication-only, approval, decision and kernel-only turns retain
  their standalone-command restrictions. This change is not an OS sandbox or a process supervisor;
  it describes existing tool permissions and does not bypass explicit project/environment policy.

## Existing Stories and prompts

Previously, the entry's terminal description said “standalone SFlow only” even in authoring mode,
while the code skill prohibited test pre-runs. This contradicted both the authoring guard and the
requirement to capture browser evidence. The guard already allowed authoring shell operations;
the incorrect instructions caused the agent to stop before trying the required app command.

New entries and the code skill now distinguish diagnostic verification from lifecycle execution.
Fresh and cached composed authoring prompts receive the same final runtime correction. Pinned
agent prompts, canonical prompt receipts and quoted source/evidence remain unchanged. No Story
recreation, workflow re-pinning, clarification replay or new VS Code task is needed.

## Regression coverage

The contract tests cover all six standard phase names plus custom check/repair steps, native
Bash/PowerShell/terminal call forms, an actual Node test run, a real loopback server request and
cleanup of its exact child process. Negative tests preserve restricted turns and existing
protected-path detection. Delivery tests retain old prompt/source bytes and prove the runtime
correction is idempotent and absent from source-review instructions.
