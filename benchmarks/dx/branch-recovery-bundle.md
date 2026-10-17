# Branch checkout recovery: bundle accounting

The independent checkout recovery adds a small receipt/location resolver to workspace context and
an explicit native intake action. The clone engine remains behind the CLI workspace subcommand.
Ordinary exact-path workspace membership still returns before this optional receipt resolution;
ordinary active selections skip its Git lookup. No package dependency was added.

Measured with `npm run vscode:bundle-budget` on macOS, Node 25 (dirty development build):

| Runtime | JavaScript bytes | Source modules |
| --- | ---: | ---: |
| extension | 1,399,369 | 142 |
| gateway | 7,448,908 | 707 |
| help | 661,211 | 129 |
| lazy panels | 3,091,070 | 249 |
| support | 447,134 | 106 |

The source-module ceilings account for the measured closures; the lazy-panel byte ceiling grows
by 4,000 bytes. Other byte ceilings, the total limit and worker/prewarm budgets are unchanged.
These are bundle measurements, not Windows latency or network-performance qualification.
