# Git access read-path qualification

This is a reproducible **local measurement**, not a release qualification or a lifecycle gate. It covers only the currently implemented Git read paths. The complete GAL requirements and acceptance matrix remain in `SPEC-git-access-layer (1).md`; this harness does not turn pending GAL APIs or platform legs into supported behavior.

Run from the repository root:

```sh
node scripts/gal-read-benchmark.mjs --samples=10 --objects=500
node --test test/gal-read-benchmark.test.mjs
npm run test:platform:gal
```

The last command is a single-host qualification *cell*, not release qualification. It runs a
fixed bounded GAL test list and the ten-trial benchmark, records OS/Node/Git/source provenance,
and reports only content hashes for captured test output. `local-pass` requires a clean checkout,
no skipped cases, and exact-byte benchmark parity. A dirty source is explicitly
`unqualified-dirty`; known POSIX-only fixtures produce `local-incomplete` on Windows with named
scenario exclusions, while any unexpected skip is a failure. Neither counts as passed. The report
always sets `releaseQualified: false`, because no single laptop can prove the required matrix or
independent signature/office-network evidence.

The harness creates an isolated temporary, unborn Git repository with 500 distinct staged blobs of exactly 1,024 bytes each. It records the fixture OID-list digest, Git/Node/OS/filesystem versions, source revision and dirty state, exact byte parity, timed distributions, and physical Git process counts. It removes only its own temporary fixture. It does not invoke a model or remote operation and does not print object bytes, repository paths, environment values, or Git stderr.

Profiles are intentionally separate:

| Profile | Timed boundary | Spawn counting | Current limitation |
| --- | --- | --- | --- |
| Cold runtime and repository discovery | A new `createGitRuntime` plus `openRepository` and disposal, inside an already-running Node process | Instrumented physical Git child launches | Does not include fresh Node startup, module load, or source fixture setup |
| Reference metadata-first synchronous batch | `readLocalGitBlobs` over all OIDs | Explicit wrapper around each Git subprocess | Current helper still probes object format, so its actual count is three, not the proposed two-spawn warm-format target |
| Reference metadata-first asynchronous batch | `readLocalGitBlobsAsync` over all OIDs | Physical child `spawn` events counted by the shared timing owner | This is the new nonblocking reference path; it still probes object format and uses three processes for the one-chunk fixture |
| Warm legacy persistent worker | 500 sequential `FosGitObjectService.read` calls after an untimed worker warmup | Instrumented Git spawns and independent worker-spawn delta | Legacy `cat-file --batch`, not capability-verified `--batch-command`; startup and profile discovery are excluded |
| Warm explicit multi-frame persistent batch | `FosGitObjectService.readBatch` over ordered chunks of at most 128 OIDs after the same untimed warmup | Instrumented Git spawns, independent worker-spawn delta, and `git.batch-requests` stdin-write count | Still the optional legacy `cat-file --batch` worker; not a default transport or a `--batch-command` capability claim |

The same exact expected bytes are checked after all read profiles. A failure aborts rather than accepting a partial result. Physical spawns are not inferred from a command name: the legacy reference wrapper counts actual calls, the asynchronous reference counts successful child-spawn events, and both persistent profiles check the timing counter against the service's process-spawn delta. The explicit batch profile also checks its worker-write count and ordered OID results. Its `logicalRequests` count means `readBatch` calls, while `logicalObjectReads` counts OIDs; for 500 objects these are four calls and 500 objects. Timing includes hashing, framing, and object verification but excludes fixture creation, warmup, and JSON presentation. The fixed order is synchronous reference, asynchronous reference, sequential persistent, then explicit batch in each trial; OS page-cache effects may favor later profiles. Compare distributions rather than one run, and do not compare trial sets with different Git/Node/OS/filesystem versions or fixture digests as if they were controlled equivalents.

## Provisional local observation

On **2026-09-18**, an uncommitted macOS arm64 checkout (`main` at `d379da64191d35ba42745d9d87b4598c88c52b26`) with Node `25.5.0` and Git `2.54.0` produced this **three-trial development sample** for the full 500-object fixture. It is not evidence for the declared supported Node 22/24 matrix, Windows, or Linux.

| Profile | Physical Git spawns per trial | p95 wall time |
| --- | ---: | ---: |
| Cold runtime and repository discovery | 6 | 30.641 ms |
| Reference synchronous batch | 3 | 51.369 ms |
| Warm legacy persistent worker | 0 additional | 70.696 ms |

Both object profiles returned all 512,000 expected bytes exactly. The persistent worker served 500 logical requests per trial and had zero additional worker spawns. Its latency was *higher* than the three-spawn reference in this sample, which is why reduced spawn count alone is not a performance claim. The benchmark is useful for regression investigation and cost accounting, not as a release-time speed threshold.

### Explicit batch development sample

On **2026-09-19**, the same 500-object fixture was measured for **10 trials** on macOS arm64 with Node `25.5.0`, Git `2.54.0`, and an uncommitted checkout at `02edad9826869947eded69ed9eb7e77b3226da1f`. All profiles returned the exact 512,000 expected bytes per trial. This dirty-source, development-Node observation is not a supported-platform qualification.

| Profile | Git spawns per trial | Logical calls / object reads / worker writes | Median / p95 wall time |
| --- | ---: | ---: | ---: |
| Reference synchronous batch | 3 | — | 39.928 / 45.437 ms |
| Reference asynchronous batch | 3 | 1 / 500 / — | 39.229 / 40.464 ms |
| Warm sequential persistent worker | 0 additional | 500 / 500 / — | 57.625 / 64.659 ms |
| Warm explicit multi-frame persistent batch | 0 additional | 4 / 500 / 4 | 17.993 / 19.057 ms |

The four explicit batch calls contained 128, 128, 128, and 116 OIDs. This run shows lower latency for this fixture and order, not a general speed guarantee: the worker was already warm, the explicit batch ran last, and the reference paths perform format discovery. The full benchmark JSON records provenance, parity, and all trial counts.

## Remaining qualification

Run the same 500-object command on the supported Node and OS matrix, with the actual installed package/VSIX and production Git trust settings. Record complete per-leg JSON, failed trials, cleanup outcome, and the exact source revision. Add separate fixtures for multi-chunk reads, missing/wrong-type/oversized objects, SHA-256 stores, cancellation, and worker failure. Benchmark actual warm `sflow status` and end-to-end onboarding/publication with authority parity and remote state where applicable. Do not mark GAL G5 complete until these legs and the production migration gates pass.
