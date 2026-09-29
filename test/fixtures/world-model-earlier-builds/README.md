# World models published by an earlier build

These Git bundles are repositories whose `state` branch holds a registered-v4 World Model published
by `main@b9bcb152`, whose Extractor Registry is
`sha256:559285187f036990893a6b062df871b70339be4bed7ee94e8896b21c3e163542`. They prove that an
upgrade keeps such models readable and current when the reviewed chain in
`src/world-model-reviewed-registries.mjs` connects that registry to the installed one.

| Bundle | View | Route |
| --- | --- | --- |
| `deterministic-55928518.bundle` | `dev.impact` | deterministic composer |
| `model-composed-55928518.bundle` | `dev.impact` | model route, through the local fake ACP composer used by `test/world-model-v4-runtime.test.mjs` |

No model was invoked to produce either bundle. Both were built from the same two-file application
source (`src/service.mjs`, `src/tax.mjs`) with `allowedPaths: ['src/**']`:

- deterministic: capability `probe`, policy snapshot `sha256({ fixture: 'probe-policy' })`;
- model-composed: capability `fixture`, policy snapshot `sha256({ fixture: 'earlier-build-model-route' })`.

Never regenerate these bundles with a newer build. Their value is that an earlier build wrote them.
