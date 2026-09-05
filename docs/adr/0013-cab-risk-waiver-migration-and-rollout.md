# ADR 0013 — CAB profiles are monotone and exceptions never become passes

- **Status:** Proposed for independent CAB-R0 review
- **Date:** 2026-09-05
- **Scope:** risk profiles, waivers, migration, and rollout

## Decision

CAB policy is capability-scoped and monotone: child policy may tighten but cannot weaken its
parent. `disabled` is the default and `observe` is the only additional available mode before an
authenticated runner exists. `enforce` and remote enforcement are unavailable.

An exception is an existing human-authority decision over one exact Candidate, bundle, predicate,
and scope. It requires a reason and future expiry and produces `verified-with-exceptions`; the
underlying failed or unavailable predicate never changes to pass. Models cannot decide exceptions.

Legacy and in-flight Stories never auto-enroll. Migration preserves `module-executed` and other
historical assurance exactly. Policy rollback affects future generations and retains all prior
evidence and decisions.

## Consequences

- rollout cannot silently strengthen assurance for existing records;
- an unavailable optional adapter never blocks ordinary work in disabled/observe mode;
- an enrolled future enforce profile fails closed on unavailable mandatory evidence;
- policy changes and waivers remain reviewed, expiring, replayable facts;
- CAB-R3 cannot start before CAB-R2 and supported-platform evidence complete.

## Rejected alternatives

- a numeric score that averages away mandatory failures;
- permanent or model-authored waivers;
- migration that inserts missing Candidate or authentication facts;
- enabling enforcement for every repository after installing a new version.
