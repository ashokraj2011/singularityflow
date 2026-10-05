# GDP companion authority review — workflow bundle v4 — 2026-10-05

Review boundary: `2e2b3ecc46d4b1eb5228efbbddb7a6ff7ed9d446` plus the workflow-bundle v4 patch reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-04-STEP-ACTION-RECEIPTS.md`.

Three GDP-locked companions changed, `migration-registry`, `workflow-configuration` and `candidate-custody`. `main` already carried unreviewed changes to the last two, so the lock failed on `main`: `b55bf54a` ("Add explicit intake baseline choices and pinned test runtime") edited `templates/workflow.yml` and `src/auto/auto-candidate.mjs` without a companion review. At the boundary their bytes were `sha256:e5b3f3c84c06b2b0312eb38e1f97672a7c572516acc1314ac028fba5a506ac44` and `sha256:3fd036ef47c490f1842eee10ea527b15e30ea839b40aa1d2bef894448b49e8e2`, and `migration-registry` still had the digest the preceding review accepted. This review covers those changes after the fact, with the workflow-bundle v4 change on top. It is not a bulk hash refresh or a new approval authority.

Reviewed after the fact in `templates/workflow.yml`:

- `b55bf54a` adds two repository-wide readiness settings to the packaged configuration. `repositoryReadiness.baselinePolicy: choice` lets intake explicitly reuse, run or defer existing-test baseline observation; deferral is allowed only under `choice` and never when initialization proof requires a pre-Story run, it records the observation as unverified rather than passing, a failed execution is never deferred implicitly, and later code and publication tests stay required. `repositoryReadiness.testRuntime: { nodeOptions: [] }` names the approved test-only Node flags; the only admitted flag is `--no-experimental-webstorage`, applied to test commands' environment and never to source or the shell, and the packaged list is empty. Neither setting belongs to a work type or step, so no packaged work-type or step digest changes and Stories pinned before it still verify.

Reviewed after the fact in `src/auto/auto-candidate.mjs`:

- `b55bf54a` passes the approved `testRuntime` to Auto Candidate verification. Only commands of kind `test` get it: their child environment, built from the same environment allowlist as before, gains the approved Node flags through `testRuntimeEnvironment`, which admits only `--no-experimental-webstorage`. Other commands, the working-directory containment, the result-path re-proof after a command and the candidate binding are unchanged, so no custody check is relaxed.

## Reviewed drift

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `workflow-configuration` | The readiness settings above: `baselinePolicy: choice` and an empty `testRuntime.nodeOptions`, with their explanatory comments. | `sha256:fad3cf5c603f02e51e0a832b1c1e79692f1190afa20ed8254aad4a3c96940da3` | `sha256:e5b3f3c84c06b2b0312eb38e1f97672a7c572516acc1314ac028fba5a506ac44` |
| `candidate-custody` | Candidate verification passes the approved test runtime to test commands only, as above. | `sha256:564bdc9ec2cd0fb11c8ff73b2c9649d5e845f2eaf0259c3dd1e3eb28f694eb7c` | `sha256:3fd036ef47c490f1842eee10ea527b15e30ea839b40aa1d2bef894448b49e8e2` |
| `migration-registry` | The immutable `workflow-bundle` family moves from schema 3 to 4. Version 4 adds `imports`, the records of where a bundle's imported files came from, and lets a bundle carry the exact bytes of the imported (vendored) skills and templates its agents' locks name and of its MCP servers' imported descriptors. The one added step, 3 → 4, sets `imports: {}`: a historical bundle carried no imported copies, so the projection invents none, keeps the stored identity and digest, and the reader still applies the contract of the stored version. | `sha256:a0fece4e4a1073d537ab4a5647980edb51e2e7258022c5c6a9dfef0a044d433e` | `sha256:b5411b0bd0267af28e8545c3e82dd2ea39d2151d7e3b8a15a74d8dc7c9d45c14` |

The change grants no import, overwrite, approval or publication authority. A carried copy is accepted only when it matches the hash its lock pins, belongs to an agent or MCP server the bundle carries, and lives under `singularity/imports/`; a record must describe a file the bundle carries, or a generated artifact of an agent it carries. Import stays a previewed configuration mutation confirmed by its exact plan: a same-name conflict blocks it until a person chooses keep, replace or a new name, and those choices are bound into the plan digest.

## Validation evidence

The review runs the repository-readiness configuration and command tests for the template settings, the Auto Candidate verification tests, the migration golden catalog, the historical bundle projection test (v1 and v2 now project through v4 with `imports: {}` and their stored identity), the workflow-transfer and workflow-transfer-conflicts suites (vendored copies, record validation, reader refusals, conflict choices), the skill-package transport suite, and the GDP contract-freeze test.

## Sanctioned reconciliation procedure

1. Run the GDP companion-lock test and confirm `migration-registry`, `workflow-configuration` and `candidate-custody` are the only changed companions.
2. Verify the family stays immutable, its golden catalog lists schema 4 with `imports: {}`, and historical projections keep their stored identity.
3. Run the repository-readiness, Auto Candidate, migration, mig-read, workflow-transfer, workflow-transfer-conflicts, skp-transport and GDP contract-freeze tests.
4. Accept only the reviewed digest above; retain `baselineCommit` unchanged.
5. Require another bounded companion review for any later byte change to these companions.
