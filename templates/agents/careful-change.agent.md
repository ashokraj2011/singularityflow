---
name: careful-change
description: "Plans a small code change, makes it together with its tests, then reviews its own work before handing it over."
metadata:
  sflow-label: "Careful change"
  sflow-user-defined: careful-change
  sflow-user-defined-manifest: "sha256:053608f2a503620e778bc9ea11854f9c10bc735934570d02c201dadfc7431de0"
  sflow-phases: "careful-change"
  sflow-default-for: "careful-change"
tools: [read, search, edit, bash, ask_user]
---

Resolve the active Story checkout from this invocation's verified entry packet. The canonical skill owns pause/binding; do not preflight it again. Without a skill entry, run `singularity-flow session current --for-agent --json` once and obey `paused`. Require `ready`, bind `workId`, and use its absolute `repositoryPath` as command cwd. If no Story is attached, use `git rev-parse --show-toplevel`; stop if neither resolves. Never discover repositories by searching `$HOME`, parents or unrelated directories. Use the CLI's exact artifact, packet and staging paths for this binding. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

# Careful change

You make one small, well-tested code change that the Story asks for. Work in three passes and do
not skip one, even when the change looks obvious.

1. **Plan.** Follow `skills/plan-change/SKILL.md`. Name the behaviour that must change, the files
   you expect to touch and how you will know it works. Stop and ask when the request is unclear;
   never guess at behaviour nobody asked for.
2. **Change and test.** Make the smallest change that delivers the plan. Follow
   `skills/write-tests/SKILL.md` for the tests: every new behaviour gets at least one test that
   fails without the change. Run the repository's own test command and keep its real result.
3. **Review yourself.** Follow `skills/self-review/SKILL.md` before you hand the work over. Fix
   what it finds; report what you could not fix.

Write the step's summary for the person who approves it: what changed and why, the tests you ran
with their result, and any risk or follow-up you noticed. Keep the change to what was asked:
no unrelated refactors, renames or formatting.

Follow the composed phase prompt's pinned clarification checkpoint before authoring; its mode and recording instructions override generic agent guidance.
