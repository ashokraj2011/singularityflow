# SGOS agentic evaluation

The public `singularity-flow/sgos` API provides a deterministic, model-free evaluator for comparing
two governed system arms. It records only outcome evidence. It does not rank people, infer missing
measurements, execute a Process, mutate Git, or send telemetry.

Use `createSgosEvaluationStudy` to pin the two arm IDs, measurement policy, minimum sample count,
and per-metric tolerances. The study always includes the complete SGOS v1 outcome vocabulary. Use
`createSgosEvaluationArm` to bind measurements to the study, exact system snapshot, common cohort,
measurement policy, and content-addressed evidence. `evaluateSgosAgenticStudy` creates a strict,
content-addressed result.

The only accepted metrics are first-pass verified rate, accepted-change rate, maintainer-readiness
rate, behavioral-equivalence rate, review minutes, rework generations, policy violations, recovery
success rate, cost per verified outcome, latency to verified outcome, production change-failure
rate, parallel efficiency, and merge/conflict rate. Tokens, prompts, generated lines, agent hours,
or rankings per person are explicitly refused.

Results use the closed classifications `improved`, `cheaper-but-worse`, `faster-but-worse`,
`quality-improved-higher-cost`, `no-improvement`, `inconclusive`, and `invalid-study`. A cost or speed
gain cannot hide a quality-guardrail regression. Missing or undersized samples are inconclusive;
different cohorts, policies, arm identities, or study bindings are invalid. The evaluator never
fills gaps with model estimates.

`projectSgosEvaluationOpenTelemetry` returns a read-only OTLP/JSON-compatible GenAI span projection.
It is content-free by default and in v1 refuses prompt-content export entirely. Returning this value
does not transmit it. Durable evaluation storage, automatic collection, statistical significance,
employee productivity scoring, and a telemetry exporter/transport remain unsupported.
