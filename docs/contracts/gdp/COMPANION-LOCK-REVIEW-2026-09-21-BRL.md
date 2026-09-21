# GDP companion authority review — BRL foundation — 2026-09-21

**Review boundary:** `main@499b2656353c8741f92a770410660750a6f356a3` plus the bounded
Browser-Verified Revision Loop foundation reviewed in this working tree.

**M0 baseline retained:** `70db564e59224b03729bab0f9a340807f3086c61`

This review accepts two exact companion-authority changes. It does not activate a browser runner,
grant witness or Testing authority, publish a browser verdict, add a delivery mode, or permit BRL
to execute arbitrary repository commands. The workflow change advertises an optional, fail-closed
inspection and planning surface. The migration change registers closed BRL records so readers can
validate and migrate their shape without inventing execution evidence.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Registers the closed browser-check, expanded run-key identity, run-state, one-receipt-per-run storage path, run-receipt, and comparison families with explicit current writers and N-1 readers; registration grants neither runner nor publication authority | `sha256:82fb9e535737ef32753c296f84c7f796a0c367f19ec2566c10ff863ebaa230f4` | `sha256:37b9b4b2d9c9527fbd384dd46f8bd9f8b284ca559f675cca3ae595d6faaee338` |
| `workflow-configuration` | Documents the optional BRL foundation for Spec → code → Playwright review while explicitly retaining the unavailable runner, green-verdict, Testing, publication, and approval boundaries | `sha256:54bd7a46e35299e0a51170ad4ef89c24253d55422fe6ecfa84385a297ca95635` | `sha256:4a6c7e3362b3be744162998a0b2b3ea2c28bc84c1bc3fa0cdadf9adfda4a844c` |

The BRL schema, migration, runtime, workflow, participant, and VS Code tests establish these exact
transitions. Repository-wide checks and the aggregate suite remain final acceptance gates. Any
future change to either authority must receive a new explicit digest review.
