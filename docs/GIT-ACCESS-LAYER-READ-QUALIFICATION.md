# Git access read-path qualification

This is a reproducible **local measurement**, not a release qualification or a lifecycle gate. It covers only the currently implemented Git read paths. The complete GAL requirements and acceptance matrix remain in `SPEC-git-access-layer (1).md`; this harness does not turn pending GAL APIs or platform legs into supported behavior.

Run from the repository root:

```sh
node scripts/gal-read-benchmark.mjs --samples=10 --objects=500
node --test test/gal-read-benchmark.test.mjs
```

The harness creates an isolated temporary, unborn Git repository with 500 distinct staged blobs of exactly 1,024 bytes each. It records the fixture OID-list digest, Git/Node/OS/filesystem versions, source revision and dirty state, exact byte parity, timed distributions, and physical Git process counts. It removes only its own temporary fixture. It does not invoke a model or remote operation and does not print object bytes, repository paths, environment values, or Git stderr.

Profiles are intentionally separate:

| Profile | Timed boundary | Spawn counting | Current limitation |
| --- | --- | --- | --- |
| Cold runtime and repository discovery | A new `createGitRuntime` plus `openRepository` and disposal, inside an already-running Node process | Instrumented physical Git child launches | Does not include fresh Node startup, module load, or source fixture setup |
| Reference metadata-first synchronous batch | `readLocalGitBlobs` over all OIDs | Explicit wrapper around each Git subprocess | Current helper still probes object format, so its actual count is three, not the proposed two-spawn warm-format target |
| Warm legacy persistent worker | 500 sequential `FosGitObjectService.read` calls after an untimed worker warmup | Instrumented Git spawns and independent worker-spawn delta | Legacy `cat-file --batch`, not capability-verified `--batch-command`; startup and profile discovery are excluded |

The same exact expected bytes are checked after both read profiles. A failure aborts rather than accepting a partial result. Physical spawns are not inferred from a command name: the reference wrapper counts actual calls, and the persistent profile checks both the timing counter and the service's process-spawn count. Timing includes hashing, framing, and object verification but excludes fixture creation, warmup, and JSON presentation. The fixed order is reference then persistent in each trial; OS page-cache effects may favor the latter. Compare distributions rather than one run, and do not compare trial sets with different Git/Node/OS/filesystem versions or fixture digests as if they were controlled equivalents.

## Provisional local observation

On **2026-09-18**, an uncommitted macOS arm64 checkout (`main` at `d379da64191d35ba42745d9d87b4598c88c52b26`) with Node `25.5.0` and Git `2.54.0` produced this **three-trial development sample** for the full 500-object fixture. It is not evidence for the declared supported Node 22/24 matrix, Windows, or Linux.

| Profile | Physical Git spawns per trial | p95 wall time |
| --- | ---: | ---: |
| Cold runtime and repository discovery | 6 | 30.641 ms |
| Reference synchronous batch | 3 | 51.369 ms |
| Warm legacy persistent worker | 0 additional | 70.696 ms |

Both object profiles returned all 512,000 expected bytes exactly. The persistent worker served 500 logical requests per trial and had zero additional worker spawns. Its latency was *higher* than the three-spawn reference in this sample, which is why reduced spawn count alone is not a performance claim. The benchmark is useful for regression investigation and cost accounting, not as a release-time speed threshold.

## Remaining qualification

Run the same 500-object command on the supported Node and OS matrix, with the actual installed package/VSIX and production Git trust settings. Record complete per-leg JSON, failed trials, cleanup outcome, and the exact source revision. Add separate fixtures for multi-chunk reads, missing/wrong-type/oversized objects, SHA-256 stores, cancellation, and worker failure. Benchmark actual warm `sflow status` and end-to-end onboarding/publication with authority parity and remote state where applicable. Do not mark GAL G5 complete until these legs and the production migration gates pass.
