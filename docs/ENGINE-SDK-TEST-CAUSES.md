# Test failure cause and message ownership

Test-run cause classification and bounded report messages now share one pure kernel owner.
Native verification, test diagnostics, application-review reads and decision rendering use the same
Node memory binding. Existing `test-run-cause.mjs` and `test-case-messages.mjs` paths remain
compatibility exports; they do not contain a second implementation.

The kernel accepts an explicit byte-normalization capability and works on supplied observations.
It does not read files, launch a process, load a provider, consult a clock, authenticate a human
or record a risk. Its memory decoder preserves native UTF-8, report ordering, XML strictness,
bounded messages and malformed-report behavior. Node-specific `Buffer` normalization stays in
the compatibility adapter.

The new `testing/causes` SDK export exposes this value API and strict NodeNext declarations.
Its descriptive cause table is an immutable copy: changing a public description cannot rewrite
the private rules. The native compatibility API keeps its existing exports and outcomes.

## Preserved rules

- Code, syntax, import and assertion failures take precedence over environment messages.
- A run whose tests failed is classified as environment-dependent only when the messages account
  for every failed test and failed suite, without an overriding code cause.
- Timeouts, unknown failures, malformed reports and tests with missing failure messages do not
  become environment exceptions.
- Launcher, dependency, browser, toolchain, device, service, permission and registry causes keep
  their original class identities and descriptions.

Classification describes observed data. It does not authorize continuing, accept a human risk,
declare tests passed or satisfy a phase's evidence obligations. Namespace test-risk recording and
consumption still need their real execution, authority and conditional-receipt owners.

## Qualification

The independent oracle contains 152 outcomes captured from the original implementations at
`6e3ae5797`, with both source hashes. Native and pure owners reproduce those results. An offline
installed consumer repeats the capture with new infrastructure imports and ambient clocks denied,
an empty `PATH`, and strict NodeNext declarations. The API refuses invented approval/risk methods.

All 165 distinct affected Mac checks pass without skips or cancellations. These include native
cause/message tests, actual test-risk continuation, 107 architecture guards, the installed consumer
and the unchanged 34-check package qualifier. That qualifier ran alone in 69.3 seconds within
its original 120-second parent and 60-second child deadlines.

Source validation passes 4,354 checks. VS Code typechecking, the unchanged 2,011-site Git audit
and all thirteen original bundle ceilings pass; gateway remains 852/852 modules. No Windows,
live provider, production installation, real Story mutation or main merge ran. The remaining
Phase 5/7 owners stay in the [completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md).
