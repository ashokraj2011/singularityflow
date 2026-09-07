# SGOS read-model benchmark

Singularity Flow measures its native SGOS read projections without sending telemetry or retaining
repository content:

```bash
npm run benchmark:sgos-read-model
npm run benchmark:sgos-read-model:enforce
```

The first command reports results. The second also exits non-zero when a reviewed ceiling is
exceeded and is part of the POC release gate.

## Fixed profiles and ceilings

| Profile | Tasks | Total projection p95 | Combined serialized bytes |
|---|---:|---:|---:|
| `single-task` | 1 | 50 ms | 256 KiB |
| `review-scale` | 200 | 250 ms | 2 MiB |
| `installed-ceiling` | 2,000 | 1,500 ms | 8 MiB |

Each sample builds all canonical Work Object views and the Command Center projection from one
deterministic in-memory Process. The installed-ceiling profile uses the runtime's actual maximum
task count. Every view keeps its existing 200-row rendering ceiling.

The output reports aggregate catalog, Command Center, total, and CPU timings plus task, view, row,
and byte counts. It verifies byte-for-byte deterministic output between samples.

## Privacy and authority

The report excludes Process and task IDs, record hashes, repository and file paths, source bytes,
prompts, responses, people, Work IDs, and telemetry destinations. The fixture invokes no model,
network, store, Git command, lifecycle mutation, or telemetry exporter.

Results are local performance observations. They are not signed supported-machine baselines and do
not authorize execution or lifecycle progress. The external-telemetry half of `SGOS-P2-003` remains
disabled until an organization explicitly approves consent, destination, retention, and transport
policy.

Use a smaller bounded sample count only for diagnostics:

```bash
node scripts/sgos-read-model-benchmark.mjs --samples=2
```

The accepted range is 1–100. Unknown arguments, including an arbitrary telemetry destination, are
refused.
