---
id: secrets
title: Refusing to commit a credential
aliases: [secret-scan, pre-commit, credentials, leak]
related: [configuration, pins, quick-fix]
commands: [secrets]
---
A credential that reaches a commit is in the history on every clone, and deleting it in the next commit does not remove it — so the check runs before the commit exists rather than after. Every governed publication and every `commit()` passes through one gate that scans the exact content going in: the working-tree version of scoped paths, the staged blob when the whole index is committed. It fails closed — an unreadable file refuses the commit, because an unscanned file is not a clean file — and it never prints the value it found, since a refusal echoed into a terminal, a CI log and a scrollback buffer has published the credential more widely than the commit would have. `sflow secrets scan [--staged]` runs it by hand and exits non-zero, so CI fails too; `sflow secrets protect` installs a `pre-commit` hook so plain `git commit` is covered, running the CLI it was installed from rather than whatever is first on PATH. Detection is conservative on purpose — provider formats that are recognisable on sight, plus one entropy-gated rule for assignments — because a check that fires on documentation is a check people learn to wave through. Real examples are waived per line with a reason (`# sflow-allow-secret: why this is not a real credential`), so the exemption appears in the diff and is reviewed with the change instead of being set once in a config file and forgotten.
